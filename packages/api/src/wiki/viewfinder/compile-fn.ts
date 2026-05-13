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
import type { DecisionJudgeProvider } from "./types"
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

    // 3. extractor 流程（newMessages 上跑 — 增量召回）
    const broadCandidates = extractBroadCandidates(newMessagesFull)
    const extractorRun = await runExtractor(deps.judge, broadCandidates, {
      maxConcurrency: deps.judgeConcurrency,
      judgeTimeoutMs: deps.judgeTimeoutMs,
    })

    // 4. 写入 ledger（resolved decisions）
    const writtenDecisionIds: number[] = []
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
    })

    // 9. decisionsMd（dump active decisions for human-readable audit）
    const decisionsMd = renderDecisionsAuditMd(input.roomId, activeDecisions)

    // 10. logMd（编译审计：candidates / coverage / Haiku 调用统计）
    const logMd = renderCompileLogMd(input.roomId, {
      generatedAt,
      newMessagesCount: newMessagesFull.length,
      broadCount: broadCandidates.length,
      writtenIds: writtenDecisionIds,
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

interface CompileLogParams {
  generatedAt: string
  newMessagesCount: number
  broadCount: number
  writtenIds: number[]
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
