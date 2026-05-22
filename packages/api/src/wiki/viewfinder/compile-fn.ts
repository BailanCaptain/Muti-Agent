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
import type { DecisionJudgeProvider, PhaseInfo } from "./types"
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
//   2. spawn `git log -1 --format=%h%n%s --grep=<featureId>` 拿最新 commit
//   3. regex parse subject "Phase \d+" / "Week \d+" / "Day \d+" / "AC-P\d+-\d+"
//   4. 验证 commit subject 含 featureId（防误抓跨房间 commit）
//   5. 任意失败 → 返 null → renderer fallback (A) 列表（不报错）
//
// 跨平台：spawnSync git 在 Windows / macOS / Linux 通用（git for Windows 装 PATH）
// timeout 5s 防 git 卡死；spawn 失败 / 非零退出 / 空 stdout → 全部 fallback null

const FEATURE_ID_REGEX = /\b([FB]\d+)\b/g

function defaultPhaseInfoQuerier(
  deps: CompileViewfinderDeps,
): (recentMessages: ReadonlyArray<MessageInput>, nowIso: string) => PhaseInfo | null {
  return (recentMessages, _nowIso) => {
    // 1. 提房间消息内出现的 feature IDs
    const featureIds = new Set<string>()
    for (const m of recentMessages) {
      const matches = m.content.matchAll(FEATURE_ID_REGEX)
      for (const match of matches) {
        featureIds.add(match[1])
      }
    }
    if (featureIds.size === 0) return null

    // 2-3. 依次尝试每个 featureId，找到第一个 hit 即返
    for (const featureId of featureIds) {
      const subject = safeGitLogSubject(featureId, {
        cwd: deps.rootDir,
        timeoutMs: deps.gitTimeoutMs ?? 5000,
      })
      if (!subject) continue
      const info = parseSubjectToPhaseInfo(subject.shortSha, subject.message, featureId)
      if (info) return info
    }
    return null
  }
}

interface GitLogResult {
  shortSha: string
  message: string
}

function safeGitLogSubject(
  featureId: string,
  opts: { cwd?: string; timeoutMs: number },
): GitLogResult | null {
  try {
    const result = spawnSync("git", ["log", "-1", "--format=%h%n%s", `--grep=${featureId}`], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      encoding: "utf-8",
    })
    if (result.error || typeof result.status !== "number" || result.status !== 0) return null
    const raw = (result.stdout ?? "").trim()
    if (!raw) return null
    const [shortSha, ...rest] = raw.split("\n")
    const message = rest.join("\n").trim()
    if (!shortSha || !message) return null
    return { shortSha: shortSha.trim(), message }
  } catch {
    return null
  }
}

function parseSubjectToPhaseInfo(
  shortSha: string,
  subject: string,
  featureId: string,
): PhaseInfo | null {
  // 验证 — subject 必须含 featureId（防误抓跨房间 commit）
  if (!subject.includes(featureId)) return null
  const phaseMatch = /\bPhase (\d+)\b/.exec(subject)
  const weekMatch = /\bWeek (\d+)\b/.exec(subject)
  const dayMatch = /\bDay (\d+)(?:-\d+)?\b/.exec(subject) // "Day 9-10" 取 9
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
