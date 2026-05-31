/**
 * F027 P12 · createViewfinderCompileFn —— RoomCompiler.compileFn 实现
 * 真相源：docs/plans/V16.5-final.md chap 8 + chap 11
 *
 * 注入到 P7 RoomCompiler 的 compileFn 槽位。流程：
 *   1. 查 newMessages 完整 content + alias（cursor 之后的）
 *   2. 关键词宽召 → Haiku judge → 写入 ledger
 *   3. computeCoverage 三集合
 *   4. 查 active decisions / tombstone decisions / blockerCalls / session group title
 *   5. 查 recent 50 messages（§2 进度扫）
 *   6. renderViewfinder → CompileArtifact (viewfinder/decisions/log markdown 三件套)
 *
 * Phase 1 简化：
 *   - decisionsMd = 决策 ledger 列表（dump 所有 active 决策）
 *   - logMd = 编译过程审计 log（candidates / coverage / Haiku 调用统计）
 *   - 不接 NightlyJob 调度（P19）
 */

import { spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import type { SqliteAdapterLike } from "../room-compiler/sqlite-checkpoint-store"
import type {
  CompileArtifact,
  CompileFn,
  MessageCommitRow,
  RoomCheckpointRow,
  ThreadSealRow,
} from "../room-compiler/types"
import { computeCoverage } from "./coverage-check"
import { type MessageInput, extractBroadCandidates, runExtractor } from "./decision-extractor"
import type { DecisionLedger } from "./decision-ledger"
import type { DecisionJudgeProvider, FeatureProgress, PhaseInfo } from "./types"
import { queryBlockerCalls, renderViewfinder } from "./viewfinder-renderer"

const RECENT_MESSAGES_LIMIT = 50
const COVERAGE_TOMBSTONE_LIMIT = 50

export interface CompileViewfinderDeps {
  db: SqliteAdapterLike
  ledger: DecisionLedger
  judge: DecisionJudgeProvider
  fencingToken: string
  leaderTerm: string
  nowFn?: () => string
  /** Claude CLI 单次调用 timeout（ms），默认 30s（生产 Sonnet 4.6） */
  judgeTimeoutMs?: number
  /** Claude CLI 并发上限，默认 4（防 spawn 风暴） */
  judgeConcurrency?: number
  /**
   * P12.b §2 phase coord 数据源（小孙 2026-05-22 拍方案 Y）
   * 默认走 spawnSync git log 抓取。测试时注入 stub 避免真 spawn。
   * 返回 null = 抓不到 / git 不可用 / 房间无 feature ID → renderer fallback (A) 列表
   */
  phaseInfoQuerier?: (
    recentMessages: ReadonlyArray<MessageInput>,
    nowIso: string,
  ) => PhaseInfo | null
  /** §2 git log spawn cwd（默认 process.cwd()），测试时注入 worktree 目录 */
  rootDir?: string
  /** §2 git log spawn timeout（ms），默认 5000 */
  gitTimeoutMs?: number
  /**
   * §2 进度% + §3 下一步数据源（站会式，小孙 2026-05-31 拍 A）
   * 默认读 docs/features/<F-id>-*.md 的 AC checklist。测试注入 stub 避免真读盘。
   * 返回 null = 非 feature 房 / 抓不到清单 → renderer fallback。
   */
  featureProgressQuerier?: (
    recentMessages: ReadonlyArray<MessageInput>,
    nowIso: string,
  ) => FeatureProgress | null
  /**
   * §1 主题数据源（站会式，小孙 2026-05-31 拍 A）
   * 默认读 docs/features|bugReport 文档 H1 标题。测试注入 stub 避免真读盘。
   * 返回 null = 非 feature/bug 房 / 抓不到 → renderer 退 spec 决策 > 房间标题。
   */
  topicQuerier?: (recentMessages: ReadonlyArray<MessageInput>, nowIso: string) => string | null
}

export function createViewfinderCompileFn(deps: CompileViewfinderDeps): CompileFn {
  const nowFn = deps.nowFn ?? (() => new Date().toISOString())

  return async (input: {
    roomId: string
    prevCheckpoint: RoomCheckpointRow | null
    newMessages: MessageCommitRow[]
    newSeals: ThreadSealRow[]
  }): Promise<CompileArtifact> => {
    const generatedAt = nowFn()

    // 1. 拿 session_group_id + title（fallback 主题用）
    const sessionGroup = querySessionGroupByRoomId(deps.db, input.roomId)
    const sessionGroupId = sessionGroup?.id ?? input.roomId
    const sessionGroupTitle = sessionGroup?.title ?? input.roomId

    // 2. 拉 newMessages 完整 content（extractor 用）+ recent 50 messages（§2 进度扫用）
    const newMessageIds = input.newMessages.map((m) => m.messageId)
    const newMessagesFull =
      newMessageIds.length > 0 ? queryMessagesByIds(deps.db, newMessageIds) : []
    const recentMessages =
      sessionGroupId !== input.roomId
        ? queryRecentMessagesForSessionGroup(deps.db, sessionGroupId, RECENT_MESSAGES_LIMIT)
        : []

    // 3. P4 C-auto-2: 拉房间当前 active commit 决策给 LLM 判 supersedes（sweep 用）
    const activeCommitsForSweep = deps.ledger
      .getActiveByType(input.roomId, "commit", 20)
      .map((d) => ({
        decisionId: d.decisionId,
        content: d.content,
        decidedAt: d.decidedAt,
      }))

    // 4. extractor 流程（newMessages 上跑 — 增量召回 + activeCommits 喂 sweep prompt）
    const broadCandidates = extractBroadCandidates(newMessagesFull)
    const extractorRun = await runExtractor(deps.judge, broadCandidates, {
      maxConcurrency: deps.judgeConcurrency,
      judgeTimeoutMs: deps.judgeTimeoutMs,
      activeCommits: activeCommitsForSweep,
    })

    // 5. 写入 ledger（resolved decisions）+ P4 sweep 旧 commit
    const writtenDecisionIds: number[] = []
    const sweptDecisionIds: number[] = []
    for (const { candidate, judgment } of extractorRun.resolvedDecisions) {
      if (!judgment.type || !judgment.content) continue
      try {
        const id = deps.ledger.append({
          roomId: input.roomId,
          decidedBy: candidate.authorAlias,
          decisionType: judgment.type,
          content: judgment.content,
          sourceMessageIds: [candidate.messageId],
          sourceQuote: candidate.content,
          fencingToken: deps.fencingToken,
          extractorConfidence: judgment.confidence,
        })
        writtenDecisionIds.push(id)
        // P4 C-auto-2: LLM 判 supersedes → markCompleted 旧 active commits
        if (judgment.supersedesDecisionIds && judgment.supersedesDecisionIds.length > 0) {
          const swept = deps.ledger.markCompleted(judgment.supersedesDecisionIds, deps.fencingToken)
          sweptDecisionIds.push(...swept)
        }
      } catch {
        // ledger.append 失败（极端：DB 锁/磁盘满）→ 不阻塞 viewfinder 编译
      }
    }

    // 5. computeCoverage（三集合算法）
    const coverage = computeCoverage(extractorRun)

    // 6. 查 active decisions + tombstone decisions（renderer §1/§5/§6 用）
    const activeDecisions = deps.ledger.getActiveDecisions(input.roomId, COVERAGE_TOMBSTONE_LIMIT)
    const tombstoneDecisions = deps.ledger.getTombstoneDecisions(input.roomId)

    // 7. §4 等谁 / blocker —— B024 24h 防御 SQL 兜底
    const blockerCalls =
      sessionGroupId !== input.roomId ? queryBlockerCalls(deps.db, sessionGroupId, generatedAt) : []

    // 7.5 §2 phase coord（P12.b 方案 Y）— spawn git log + 房间 ID 验证 → PhaseInfo | null
    const phaseInfo = (deps.phaseInfoQuerier ?? defaultPhaseInfoQuerier(deps))(
      recentMessages,
      generatedAt,
    )

    // 7.6 §2 进度% + §3 下一步（站会式，小孙 2026-05-31 拍 A）— 读 feature.md AC checklist
    const featureProgress = (deps.featureProgressQuerier ?? defaultFeatureProgressQuerier(deps))(
      recentMessages,
      generatedAt,
    )

    // 7.7 §1 主题（站会式，小孙 2026-05-31 拍 A）— 读 feature/bug 文档 H1 标题
    const featureTopic = (deps.topicQuerier ?? defaultTopicQuerier(deps))(
      recentMessages,
      generatedAt,
    )

    // 8. renderViewfinder
    const artifact = renderViewfinder({
      roomId: input.roomId,
      activeDecisions,
      tombstoneDecisions,
      recentMessages,
      blockerCalls,
      sessionGroupTitle,
      coverage,
      generatedAt,
      lastCommittedCursor: input.prevCheckpoint?.cursorMessageId ?? null,
      phaseInfo,
      featureProgress,
      featureTopic,
    })

    // 9. decisionsMd（dump active decisions for human-readable audit）
    const decisionsMd = renderDecisionsAuditMd(input.roomId, activeDecisions)

    // 10. logMd（编译审计：candidates / coverage / Claude CLI 调用统计 + P4 sweep）
    const logMd = renderCompileLogMd(input.roomId, {
      generatedAt,
      newMessagesCount: newMessagesFull.length,
      broadCount: broadCandidates.length,
      writtenIds: writtenDecisionIds,
      sweptIds: sweptDecisionIds,
      coverage,
      unresolvedSamples: extractorRun.unresolved.slice(0, 5).map((u) => ({
        messageId: u.candidate.messageId,
        excerpt: u.candidate.content.slice(0, 80),
        error: u.error,
      })),
    })

    // 11. cursor 推进
    const lastNew = input.newMessages[input.newMessages.length - 1]
    const cursorCommitSeq = lastNew?.seq ?? input.prevCheckpoint?.cursorCommitSeq ?? 0
    const cursorMessageId = lastNew?.messageId ?? input.prevCheckpoint?.cursorMessageId ?? ""

    const lastSeal = input.newSeals[input.newSeals.length - 1]
    const sealedCursorSeq = lastSeal?.seq ?? input.prevCheckpoint?.sealedCursorSeq ?? 0
    const threadSealId = lastSeal?.threadId ?? input.prevCheckpoint?.threadSealId ?? null

    return {
      viewfinderMd: artifact.markdown,
      decisionsMd,
      logMd,
      cursorCommitSeq,
      cursorMessageId,
      sealedCursorSeq,
      threadSealId,
    }
  }
}

// ─── DB query helpers ────────────────────────────────────────────────

interface SessionGroupRow {
  id: string
  title: string
}

function querySessionGroupByRoomId(db: SqliteAdapterLike, roomId: string): SessionGroupRow | null {
  const row = db.prepare("SELECT id, title FROM session_groups WHERE room_id = ?").get(roomId) as
    | SessionGroupRow
    | undefined
  return row ?? null
}

interface MessageJoinedRow {
  id: string
  thread_id: string
  role: string
  content: string
  created_at: string
  alias: string
}

function queryMessagesByIds(db: SqliteAdapterLike, messageIds: string[]): MessageInput[] {
  if (messageIds.length === 0) return []
  // SQLite 不支持参数化 IN (?)，手动展开
  const placeholders = messageIds.map(() => "?").join(",")
  const rows = db
    .prepare(`
      SELECT m.id, m.thread_id, m.role, m.content, m.created_at, t.alias
      FROM messages m
      JOIN threads t ON m.thread_id = t.id
      WHERE m.id IN (${placeholders})
      ORDER BY m.created_at ASC
    `)
    .all(...messageIds) as MessageJoinedRow[]
  return rows.map(mapMessageRow)
}

function queryRecentMessagesForSessionGroup(
  db: SqliteAdapterLike,
  sessionGroupId: string,
  limit: number,
): MessageInput[] {
  const rows = db
    .prepare(`
      SELECT m.id, m.thread_id, m.role, m.content, m.created_at, t.alias
      FROM messages m
      JOIN threads t ON m.thread_id = t.id
      WHERE t.session_group_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `)
    .all(sessionGroupId, limit) as MessageJoinedRow[]
  // 倒序拿后翻正序
  return rows.map(mapMessageRow).reverse()
}

function mapMessageRow(r: MessageJoinedRow): MessageInput {
  const role: MessageInput["role"] =
    r.role === "user" || r.role === "assistant" || r.role === "system" || r.role === "tool"
      ? r.role
      : "system"
  return {
    messageId: r.id,
    threadId: r.thread_id,
    authorAlias: r.alias,
    role,
    content: r.content,
    createdAt: r.created_at,
  }
}

// ─── decisions.md / log.md renderers ─────────────────────────────────

import type { CoverageReport, DecisionRow } from "./types"

function renderDecisionsAuditMd(roomId: string, decisions: ReadonlyArray<DecisionRow>): string {
  const lines: string[] = [`# ${roomId} Decisions Ledger (active)`, ""]
  if (decisions.length === 0) {
    lines.push("（无 active 决策）")
    return `${lines.join("\n")}\n`
  }
  for (const d of decisions) {
    const tomb = d.tombstone ? " [tombstone]" : ""
    lines.push(`## D-${d.decisionId} · ${d.decisionType}${tomb}`)
    lines.push(`- by: ${d.decidedBy}`)
    lines.push(`- at: ${d.decidedAt}`)
    lines.push(`- source: ${d.sourceMessageIds.join(", ")}`)
    lines.push(`- content: ${d.content}`)
    lines.push(`- quote: "${d.sourceQuote.slice(0, 200).replace(/\n/g, " ")}"`)
    if (d.extractorConfidence !== null) {
      lines.push(`- confidence: ${d.extractorConfidence.toFixed(2)}`)
    }
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}

// ─── §2 phase coord querier（P12.b 方案 Y · 小孙 2026-05-22 拍） ───────
//
// 数据流：
//   1. 扫 recentMessages content 抓 feature IDs (regex F\d+ | B\d+)
//   2. spawn `git log -N --format=%h%n%s%n--END-- --grep=<featureId>` 拿最近 N commits
//      (r2 范-r1 P2-1 修：原 -1 命中最新 commit 若不可 parse 就 fallback null，
//       不会回退找更早的可解析 commit；改成回溯 N=10 commits 找首个可 parse 的)
//   3. regex parse subject "Phase \d+" / "Week \d+" / "Day \d+" / "AC-P\d+-\d+"
//      (r2 范-r1 P2-2 修：Day range "Day 9-10" 取后端 → 10，跟"做到 Day 10"语义一致)
//   4. 验证 commit subject 含 featureId（防误抓跨房间 commit）
//   5. 任意失败 → 返 null → renderer fallback (A) 列表（不报错）
//
// 跨平台：spawnSync git 在 Windows / macOS / Linux 通用（git for Windows 装 PATH）
// timeout 5s 防 git 卡死；spawn 失败 / 非零退出 / 空 stdout → 全部 fallback null

/** r2 范-r1 P2-1 修：单 featureId 回溯 N commits 找首个可 parse 的 */
// P4-A6 (2026-05-26)：从 10 提到 30。10 个 commits 在密集 commit 期间（如 Phase 4
// 收稿 + hotfix 链）可能全是 "P4-A1" / "hotfix" 这种非 "Phase X / Day X" subject，
// 回溯失败 → viewfinder phase 字段为空。扩到 30 让密集 commit 期也能命中历史 Phase 锚。
const PHASE_QUERY_COMMITS = 30

/**
 * 扫 recentMessages 抽 feature/bug IDs，**按 recency 降序**（最新出现的 id 排首）。
 * phaseInfo + featureProgress + topic 共用；querier 取首个能读到文档的 id = 当前站会主题。
 *
 * 范-r1 P2-1 修（2026-05-31 codex review）:
 *   (a) 3 位起 `\b[FB]\d{3,}\b`（项目 id 全 F0xx/B0xx 3 位）——杜绝 "F5 键"/"F1 档位" 闲聊误抓。
 *   (b) **recency 降序**：原 Set 首次出现序 = 最早 id，房间从 F026 转 F027 会错房读旧 F026。
 *       recentMessages 是时间正序（caller queryRecent... 已反转 chronological），故从后往前扫，
 *       每个 message 内多 id 也反着 push，首次见即最新 → 最新房间主题排首。
 */
export function extractFeatureIds(recentMessages: ReadonlyArray<MessageInput>): string[] {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const matches = [...recentMessages[i].content.matchAll(/\b([FB]\d{3,})\b/g)]
    for (let j = matches.length - 1; j >= 0; j--) {
      const id = matches[j][1]
      if (!seen.has(id)) {
        seen.add(id)
        ordered.push(id)
      }
    }
  }
  return ordered
}

/** 校验 docId 合法（防 readDocTitle/readFeatureProgress 被未来调用方传未净化 id → 路径穿越）。 */
function isValidDocId(docId: string): boolean {
  return /^[FB]\d{3,}$/.test(docId)
}

// ─── §2 进度% + §3 下一步（站会式，小孙 2026-05-31 拍 A）──────────────────
//
// 铁律（小孙拍）：
//   - % 永远只数 feature.md 的 `- [x]` checkbox，commit 一律不算 AC 完成
//   - 唯一清单脊柱 = feature.md（不读 plan/evidence 编号，三处编号分叉过）
//   - 第一条未勾 AC = §3 下一步；intra-AC 进度只在 §2 给定性(in-flight)，不给假%

/**
 * 匹配 feature.md AC checklist 行：`- [x] **AC-P1-1 · 标题**...`
 * codex P3-4 修：分隔符放宽 `·` → `[·:：—-]`（中点/半/全角冒号/em-dash/连字符），
 * 防有人写 `**AC-Px-y: title**` 时整行被跳过 → total 缩水 → % 虚高（fail-soft 无日志难察觉）。
 * `**AC-P` 前缀仍硬要求，故"普通 todo 不计入 AC"语义不变。
 */
const AC_CHECKLIST_RE = /^- \[([ xX])\]\s*\*\*(AC-P\d+-\d+)\s*[·:：—-]\s*(.+?)\*\*/

/** 解析 feature.md 全文 → FeatureProgress（纯函数，便于测试）*/
export function parseFeatureProgress(featureId: string, content: string): FeatureProgress | null {
  let total = 0
  let done = 0
  let firstUndoneAC: { id: string; title: string } | null = null
  for (const line of content.split("\n")) {
    const m = AC_CHECKLIST_RE.exec(line)
    if (!m) continue
    total++
    if (m[1].toLowerCase() === "x") {
      done++
    } else if (!firstUndoneAC) {
      firstUndoneAC = { id: m[2], title: m[3].trim() }
    }
  }
  if (total === 0) return null
  return { featureId, total, done, pct: Math.round((done / total) * 100), firstUndoneAC }
}

/** 读 docs/features/<F-id>-*.md → parseFeatureProgress（fail-soft 返 null）*/
export function readFeatureProgress(featureId: string, rootDir?: string): FeatureProgress | null {
  // 范-r1 P1-1 修：exported helper 防御性校验 featureId（防未净化 id → join 路径穿越）。
  if (!isValidDocId(featureId)) return null
  try {
    const dir = join(rootDir ?? process.cwd(), "docs", "features")
    const file = readdirSync(dir).find((f) => f.startsWith(`${featureId}-`) && f.endsWith(".md"))
    if (!file) return null
    return parseFeatureProgress(featureId, readFileSync(join(dir, file), "utf-8"))
  } catch {
    return null
  }
}

// ─── §1 主题：feature/bug 文档 H1 标题（站会式，小孙 2026-05-31 拍 A）─────
//
// §1「当前主题」优先取房间所属 feature/bug 文档的完整 H1 标题（带 F-id/B-id 前缀），
// 让 agent 一眼知道"这房间在做哪个 feature + 主题"。全确定性、零 LLM（AC-P2-9 descope LLM 路径）。
// 认不出 feature/bug → renderer 退 tombstone spec > active spec > 房间标题。

/** 读 docs/features/<F-id>-*.md 或 docs/bugReport/<B-id>-*.md 的 H1 标题（fail-soft 返 null）*/
export function readDocTitle(docId: string, rootDir?: string): string | null {
  // 范-r1 P1-1 修：exported helper 防御性校验 docId（防未来调用方传未净化 id → join 路径穿越）。
  // 注：F1/F12 前缀碰撞 codex 担心的场景实测已被 `${docId}-` 后缀杜绝（"F12-".startsWith("F1-")=false），
  // 但 join 穿越面真实，统一在此 hard gate。
  if (!isValidDocId(docId)) return null
  const subdir = docId.startsWith("B") ? "bugReport" : "features"
  try {
    const dir = join(rootDir ?? process.cwd(), "docs", subdir)
    const file = readdirSync(dir).find((f) => f.startsWith(`${docId}-`) && f.endsWith(".md"))
    if (!file) return null
    for (const line of readFileSync(join(dir, file), "utf-8").split("\n")) {
      const m = /^#\s+(.+?)\s*$/.exec(line)
      if (m) return m[1].trim()
    }
    return null
  } catch {
    return null
  }
}

/** 默认 §1 主题查询器：扫房间 feature/bug ID → 读其文档 H1 标题 */
export function defaultTopicQuerier(
  deps: Pick<CompileViewfinderDeps, "rootDir">,
): (recentMessages: ReadonlyArray<MessageInput>, nowIso: string) => string | null {
  return (recentMessages: ReadonlyArray<MessageInput>): string | null => {
    for (const docId of extractFeatureIds(recentMessages)) {
      const title = readDocTitle(docId, deps.rootDir)
      if (title) return title
    }
    return null
  }
}

/** 默认 featureProgress 查询器：扫房间 feature ID → 读其 feature.md 清单 */
export function defaultFeatureProgressQuerier(
  deps: Pick<CompileViewfinderDeps, "rootDir">,
): (recentMessages: ReadonlyArray<MessageInput>, nowIso: string) => FeatureProgress | null {
  return (recentMessages: ReadonlyArray<MessageInput>): FeatureProgress | null => {
    for (const featureId of extractFeatureIds(recentMessages)) {
      const progress = readFeatureProgress(featureId, deps.rootDir)
      if (progress) return progress
    }
    return null
  }
}

export function defaultPhaseInfoQuerier(
  deps: CompileViewfinderDeps,
): (recentMessages: ReadonlyArray<MessageInput>, nowIso: string) => PhaseInfo | null {
  return (recentMessages, _nowIso) => {
    // 1. 提房间消息内出现的 feature IDs（recency 降序，与 §1/§3 同源 — codex P2-1 修）
    const featureIds = extractFeatureIds(recentMessages)
    if (featureIds.length === 0) return null

    // 2-3. r2 范-r1 P2-1 修：每个 featureId 拿 N 个最近 commits，遍历找首个可 parse 的
    for (const featureId of featureIds) {
      const subjects = safeGitLogSubjects(featureId, {
        cwd: deps.rootDir,
        timeoutMs: deps.gitTimeoutMs ?? 5000,
      })
      for (const subject of subjects) {
        const info = parseSubjectToPhaseInfo(subject.shortSha, subject.message, featureId)
        if (info) return info
      }
    }
    return null
  }
}

interface GitLogResult {
  shortSha: string
  message: string
}

/**
 * r2 范-r1 P2-1 修：safeGitLogSubject → safeGitLogSubjects（多 commits）
 * 用 `--END--` sentinel 分隔多 commit 输出，subject 含换行也能 parse
 */
export function safeGitLogSubjects(
  featureId: string,
  opts: { cwd?: string; timeoutMs: number; limit?: number },
): GitLogResult[] {
  try {
    const limit = opts.limit ?? PHASE_QUERY_COMMITS
    const result = spawnSync(
      "git",
      ["log", `-${limit}`, "--format=%h%n%s%n--END--", `--grep=${featureId}`],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        encoding: "utf-8",
      },
    )
    if (result.error || typeof result.status !== "number" || result.status !== 0) return []
    const raw = (result.stdout ?? "").trim()
    if (!raw) return []
    // 每 commit 一段: "<shortSha>\n<subject>\n--END--"，多 commits 用 \n--END--\n 分割
    const results: GitLogResult[] = []
    const blocks = raw.split(/\n?--END--\n?/)
    for (const block of blocks) {
      const trimmed = block.trim()
      if (!trimmed) continue
      const lines = trimmed.split("\n")
      const shortSha = lines[0]?.trim()
      const message = lines.slice(1).join("\n").trim()
      if (!shortSha || !message) continue
      results.push({ shortSha, message })
    }
    return results
  } catch {
    return []
  }
}

export function parseSubjectToPhaseInfo(
  shortSha: string,
  subject: string,
  featureId: string,
): PhaseInfo | null {
  // 验证 — subject 必须含 featureId（防误抓跨房间 commit）
  if (!subject.includes(featureId)) return null
  const phaseMatch = /\bPhase (\d+)\b/.exec(subject)
  const weekMatch = /\bWeek (\d+)\b/.exec(subject)
  // r2 范-r1 P2-2 修：Day range "Day 9-10" 取后端 → 10（"做到 Day 10"语义）
  // regex 同时支持 "Day 9" 单值 / "Day 9-10" range
  const dayMatch = /\bDay (?:\d+-)?(\d+)\b/.exec(subject)
  const acMatches = subject.matchAll(/\bAC-P\d+-\d+\b/g)
  const acs = Array.from(acMatches).map((m) => m[0])
  // 至少要 parse 到一个 phase/day/ac 才算 hit，否则返 null fallback (A)
  if (!phaseMatch && !dayMatch && acs.length === 0) return null
  return {
    featureId,
    phase: phaseMatch ? Number.parseInt(phaseMatch[1], 10) : undefined,
    week: weekMatch ? Number.parseInt(weekMatch[1], 10) : undefined,
    day: dayMatch ? Number.parseInt(dayMatch[1], 10) : undefined,
    acs: acs.length > 0 ? acs : undefined,
    commitShortSha: shortSha,
    commitSubject: subject,
  }
}

interface CompileLogParams {
  generatedAt: string
  newMessagesCount: number
  broadCount: number
  writtenIds: number[]
  /** P4 C-auto-2: 本轮被 extractor LLM 标 completed 的旧 active commit ids */
  sweptIds: number[]
  coverage: CoverageReport
  unresolvedSamples: Array<{ messageId: string; excerpt: string; error: string }>
}

function renderCompileLogMd(roomId: string, p: CompileLogParams): string {
  const lines: string[] = [
    `# ${roomId} Compile Log`,
    "",
    `- generated_at: ${p.generatedAt}`,
    `- new_messages: ${p.newMessagesCount}`,
    `- broad_candidates: ${p.broadCount}`,
    `- written_decisions: ${p.writtenIds.length} [${p.writtenIds.map((i) => `D-${i}`).join(", ")}]`,
    `- swept_decisions: ${p.sweptIds.length} [${p.sweptIds.map((i) => `D-${i}`).join(", ")}]`,
    `- coverage: ${p.coverage.coverage === null ? "unknown" : `${(p.coverage.coverage * 100).toFixed(0)}%`} (${p.coverage.status})`,
    `- coverage_reason: ${p.coverage.reason}`,
    "",
  ]
  if (p.unresolvedSamples.length > 0) {
    lines.push(`## Unresolved samples (top ${p.unresolvedSamples.length})`)
    for (const s of p.unresolvedSamples) {
      lines.push(`- ${s.messageId}: "${s.excerpt}" → ${s.error}`)
    }
  }
  return `${lines.join("\n")}\n`
}
