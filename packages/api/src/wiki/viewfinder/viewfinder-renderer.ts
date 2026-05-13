/**
 * F027 P12 · Viewfinder 6 段 renderer（rule-based 模板填空）
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1255-1294 + 1296-1337（V16.5 修订 §4）
 *
 * 设计（小孙 2026-05-13 拍 + 范-r2 GO）：
 *   - 6 段全部 SQL 查 + 字符串拼，不调 LLM 编（高频确定性活）
 *   - §1 当前主题：取最新 spec 决策；无则 fallback session_groups.title
 *     → 关键修复：tombstone 决策永久投影到 §1（plan chap 11 行 1198-1200 设计意图）
 *   - §2 当前进度：messages tail 关键词扫（"完成/已合/通过"等）
 *   - §3 下一步 + 谁做：取最新 commit 决策（active，未被 supersede）
 *   - §4 等谁 / blocker：F026 a2a_calls 实时查 + 24h deadline_at 防御（B024 兜底）
 *   - §5 关键决策：active 5 条 + 含 [decision_id=X, msg_id] 证据链
 *   - §6 不要再做：reject 类 active + tombstone 类
 *
 * 漂移防御产物：
 *   - decisionsSummaryHash: §5 列表的 sha256（MonthlySnapshot drift 比对）
 *   - decisionsSummaryTokens: §5 列表 tokenized set（jaccard 算漂移用）
 */

import { createHash } from "node:crypto"
import type {
  BlockerCallRow,
  CoverageReport,
  DecisionRow,
  RenderViewfinderInput,
  ViewfinderArtifact,
} from "./types"

// ─── 主入口 ──────────────────────────────────────────────────────────

export function renderViewfinder(input: RenderViewfinderInput): ViewfinderArtifact {
  const lines: string[] = []

  // Frontmatter
  lines.push("---")
  lines.push(`viewfinder_id: ${makeViewfinderId(input.roomId, input.generatedAt)}`)
  lines.push(`generated_at: ${input.generatedAt}`)
  lines.push("generated_by: RoomCompiler (rule-based template)")
  lines.push("inputs:")
  lines.push(`  last_committed_cursor: ${input.lastCommittedCursor ?? "null"}`)
  lines.push(`  decision_ledger_count: ${input.activeDecisions.length}`)
  if (input.coverage.coverage !== null) {
    lines.push(
      `  coverage: ${(input.coverage.coverage * 100).toFixed(0)}% (${input.coverage.resolved}/${input.coverage.broad})`,
    )
  } else {
    lines.push(`  coverage: unknown (broad=${input.coverage.broad})`)
  }
  lines.push(`coverage_status: ${input.coverage.status}`)
  if (input.coverage.status !== "pass") {
    lines.push(`coverage_reason: "${escapeYaml(input.coverage.reason)}"`)
  }
  lines.push("---")
  lines.push("")

  // Title
  lines.push(`# ${input.roomId} Viewfinder`)
  lines.push("")

  // §1 当前主题
  lines.push("## 1. 当前主题")
  lines.push(renderTopic(input))
  lines.push("")

  // §2 当前进度
  lines.push("## 2. 当前进度")
  lines.push(renderProgress(input))
  lines.push("")

  // §3 下一步 + 谁做
  lines.push("## 3. 下一步 + 谁做")
  lines.push(renderNextStep(input))
  lines.push("")

  // §4 等谁 / blocker
  lines.push("## 4. 等谁 / blocker")
  lines.push(renderBlockers(input))
  lines.push("")

  // §5 关键决策
  lines.push("## 5. 关键决策")
  const decisionsSummary = renderDecisionsSummary(input.activeDecisions)
  lines.push(decisionsSummary || "（暂无决策）")
  lines.push("")

  // §6 不要再做
  lines.push("## 6. 不要再做")
  lines.push(renderDoNotList(input))
  lines.push("")

  // Footer: coverage warning（如有）
  if (input.coverage.status !== "pass") {
    const excerptMap = new Map<string, string>()
    for (const id of input.coverage.unresolvedMessageIds) {
      const m = input.recentMessages.find((rm) => rm.messageId === id)
      if (m) excerptMap.set(id, m.content)
    }
    lines.push("---")
    lines.push(renderCoverageFooter(input.coverage, input.roomId, excerptMap))
  }

  const markdown = lines.join("\n")
  const tokens = tokenizeDecisionsSummary(decisionsSummary)
  return {
    markdown,
    decisionsSummaryHash: sha256(decisionsSummary),
    decisionsSummaryTokens: tokens,
  }
}

// ─── §1 当前主题 ─────────────────────────────────────────────────────

function renderTopic(input: RenderViewfinderInput): string {
  // 优先级 1: tombstone 类 spec 决策（永久投影 — plan chap 11 行 1198-1200 设计意图）
  const tombstoneSpec = input.tombstoneDecisions.find((d) => d.decisionType === "spec")
  if (tombstoneSpec) {
    return `${tombstoneSpec.content}（${formatDecisionRef(tombstoneSpec)}, tombstone）`
  }
  // 优先级 2: 最新 active spec 决策
  const latestSpec = input.activeDecisions.find((d) => d.decisionType === "spec")
  if (latestSpec) {
    return `${latestSpec.content}（${formatDecisionRef(latestSpec)}）`
  }
  // 优先级 3: fallback session_groups.title
  return `${input.sessionGroupTitle}（fallback: 无 spec 决策入 ledger）`
}

// ─── §2 当前进度 ─────────────────────────────────────────────────────

const PROGRESS_KEYWORDS = [
  /已合(并|入|完)/,
  /推完/,
  /通过(了|啦)?/,
  /验过了/,
  /done/i,
  /完成/,
  /搞定/,
  /✅/,
  /阻塞.*(收尾|搞定|通过)/,
  /closed/i,
]

function renderProgress(input: RenderViewfinderInput): string {
  // 倒序找最新 assistant 消息含进度关键词的一句
  for (const m of [...input.recentMessages].reverse()) {
    if (m.role !== "assistant") continue
    for (const k of PROGRESS_KEYWORDS) {
      if (k.test(m.content)) {
        const sentence = extractFirstMatchingSentence(m.content, k)
        return `"${sentence}" (msg ${m.messageId} by ${m.authorAlias})`
      }
    }
  }
  return "（最近 messages 无明确进度信号）"
}

function extractFirstMatchingSentence(content: string, pattern: RegExp): string {
  // 按中英文句号 / 换行切，取第一句命中的
  const sentences = content.split(/[\n。.!?！？]+/).map((s) => s.trim())
  for (const s of sentences) {
    if (pattern.test(s)) {
      return s.length > 100 ? `${s.slice(0, 100)}…` : s
    }
  }
  return content.slice(0, 100)
}

// ─── §3 下一步 + 谁做 ────────────────────────────────────────────────

function renderNextStep(input: RenderViewfinderInput): string {
  // 取最新 active commit 决策（type=commit 通常是承诺/批准下一步动作）
  const latestCommit = input.activeDecisions.find((d) => d.decisionType === "commit")
  if (latestCommit) {
    return `${latestCommit.content}（${formatDecisionRef(latestCommit)}）`
  }
  // 退而求其次：最新任意 active 决策
  const latest = input.activeDecisions[0]
  if (latest) {
    return `${latest.content}（${formatDecisionRef(latest)}）`
  }
  return "（暂无承诺类决策）"
}

// ─── §4 等谁 / blocker（含 B024 24h 防御过滤） ───────────────────────

export function renderBlockers(input: RenderViewfinderInput): string {
  if (input.blockerCalls.length === 0) {
    return "无 blocker（无 pending/working/failed/timeout a2a_calls）"
  }
  const lines: string[] = []
  for (const c of input.blockerCalls) {
    lines.push(`- ${renderBlockerLine(c)}`)
  }
  return lines.join("\n")
}

function renderBlockerLine(c: BlockerCallRow): string {
  const shortCallId = c.callId.startsWith("call-") ? c.callId.slice(0, 13) : c.callId.slice(0, 8)
  const deadline = formatTime(c.deadlineAt)
  if (c.status === "pending" || c.status === "working") {
    return `等 ${c.issuerId} [a2a_call=${shortCallId}, status=${c.status}, deadline ${deadline}]`
  }
  if (c.status === "failed" || c.status === "timeout") {
    const reason = c.reason ? `, reason="${escapeYaml(c.reason)}"` : ""
    return `等 ${c.issuerId} [a2a_call=${shortCallId}, status=${c.status}${reason}]`
  }
  // cancelled
  return `等 ${c.issuerId} [a2a_call=${shortCallId}, status=cancelled]`
}

function formatTime(iso: string): string {
  // "2026-05-08T09:11:19.603Z" → "09:11"
  const m = /T(\d{2}:\d{2})/.exec(iso)
  return m ? m[1] : iso
}

// ─── §5 关键决策 ─────────────────────────────────────────────────────

const DECISIONS_LIMIT = 5

function renderDecisionsSummary(decisions: ReadonlyArray<DecisionRow>): string {
  if (decisions.length === 0) return ""
  const slice = decisions.slice(0, DECISIONS_LIMIT)
  return slice.map((d) => `- ${formatDecisionRef(d)}: ${d.content}`).join("\n")
}

// ─── §6 不要再做 ─────────────────────────────────────────────────────

function renderDoNotList(input: RenderViewfinderInput): string {
  const items: DecisionRow[] = []
  // tombstone 类（永久不要再做 — chap 11 行 1198）
  for (const d of input.tombstoneDecisions) {
    if (d.decisionType === "reject" || d.decisionType === "pivot") items.push(d)
  }
  // active reject 类
  for (const d of input.activeDecisions) {
    if (d.decisionType === "reject" && !items.some((x) => x.decisionId === d.decisionId)) {
      items.push(d)
    }
  }
  if (items.length === 0) return "（暂无 reject/tombstone 决策）"
  return items
    .slice(0, DECISIONS_LIMIT)
    .map((d) => {
      const tomb = d.tombstone ? " [tombstone]" : ""
      return `- ${d.content}（${formatDecisionRef(d)}${tomb}）`
    })
    .join("\n")
}

// ─── helpers ────────────────────────────────────────────────────────

function formatDecisionRef(d: DecisionRow): string {
  const msgRef = d.sourceMessageIds[0] ?? "(no msg)"
  return `D-${d.decisionId} [msg_${msgRef}, ${d.decidedBy}]`
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex")
}

function makeViewfinderId(roomId: string, generatedAt: string): string {
  // "2026-05-13T14:30:00Z" → "2026-05-13-14-30"
  const stamp = generatedAt.replace(/T/, "-").replace(/:/g, "-").slice(0, 16)
  return `vf_${roomId}_${stamp}`
}

function tokenizeDecisionsSummary(summary: string): Set<string> {
  // 简单 tokenize：按非中英数字字符切，去空，小写
  const tokens = summary
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t.length > 0)
  return new Set(tokens)
}

function renderCoverageFooter(
  report: CoverageReport,
  roomId: string,
  excerptByMessageId: Map<string, string>,
): string {
  // 复用 coverage-check.renderCoverageWarning 的核心格式但 footer 不带 "> " 前缀
  const lines: string[] = []
  lines.push(`⚠️ Coverage **${report.status}**: ${report.reason}`)
  if (report.unresolvedMessageIds.length > 0) {
    lines.push("")
    lines.push("**Unresolved candidates** (need manual confirm):")
    for (const id of report.unresolvedMessageIds) {
      const excerpt = excerptByMessageId.get(id) ?? "(excerpt unavailable)"
      const truncated = excerpt.length > 80 ? `${excerpt.slice(0, 80)}…` : excerpt
      lines.push(`  - msg ${id}: "${truncated.replace(/\n/g, " ")}"`)
    }
    lines.push("")
    lines.push(`👉 手动确认: \`POST /api/rooms/${roomId}/decisions\``)
  }
  return lines.join("\n")
}

// ─── §4 SQL helper（B024 兜底）────────────────────────────────────────

import type { SqliteAdapterLike } from "../room-compiler/sqlite-checkpoint-store"

/**
 * 查 a2a_calls 当 §4 blockers 用。**含 B024 防御性 24h deadline_at 过滤**：
 *   - pending / working: deadline_at > now() - 24h（防 sweep 漏扫的僵尸 call）
 *   - failed / timeout / cancelled: 仅取 24h 内的（避免历史噪音）
 *
 * F026 a2a_calls 表不含 result/error 字段，failed/timeout 的 reason
 * 需要 LEFT JOIN messages.a2a_call_id 拿 retry_reasons / content（V16.5 chap 11 行 1311-1322）。
 * Phase 1 简化：只查 a2a_calls 主表，reason=undefined（P19 V16.5 修订时再补 LEFT JOIN）。
 *
 * 范-r3 P1-2 修：SQL 用 `datetime()` 而非字典序比较 —— SQLite datetime() 解析 ISO 字符串
 * 宽容（带/不带 Z / 带/不带毫秒 / 带 +HH:MM offset 都能解析），避免字典序在毫秒段
 * "." vs "Z" 字符 (0x2E < 0x5A) 反转的边界陷阱。
 */
export function queryBlockerCalls(
  db: SqliteAdapterLike,
  sessionGroupId: string,
  nowIsoString: string,
): BlockerCallRow[] {
  const cutoff = subtractHours(nowIsoString, 24)
  const rows = db
    .prepare(`
      SELECT call_id, issuer_id, status, deadline_at
      FROM a2a_calls
      WHERE session_group_id = ?
        AND status IN ('pending', 'working', 'failed', 'timeout', 'cancelled')
        AND datetime(deadline_at) > datetime(?)
      ORDER BY datetime(deadline_at) DESC
      LIMIT 20
    `)
    .all(sessionGroupId, cutoff) as Array<{
    call_id: string
    issuer_id: string
    status: string
    deadline_at: string
  }>
  return rows.map((r) => ({
    callId: r.call_id,
    issuerId: r.issuer_id,
    status: r.status as BlockerCallRow["status"],
    deadlineAt: r.deadline_at,
  }))
}

function subtractHours(iso: string, hours: number): string {
  const d = new Date(iso)
  d.setUTCHours(d.getUTCHours() - hours)
  return d.toISOString()
}
