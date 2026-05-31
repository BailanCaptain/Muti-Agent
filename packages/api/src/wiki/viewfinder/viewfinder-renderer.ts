/**
 * F027 P12 · Viewfinder 6 段 renderer（rule-based 模板填空）
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1255-1294 + 1296-1337（V16.5 修订 §4）
 *
 * 设计（小孙 2026-05-13 拍 + 范-r2 GO）：
 *   - 6 段全部 SQL 查 + 字符串拼，不调 LLM 编（高频确定性活）
 *   - §1 当前主题：取最新 spec 决策；无则 fallback session_groups.title
 *     → 关键修复：tombstone 决策永久投影到 §1（plan chap 11 行 1198-1200 设计意图）
 *   - §2 当前进度：站会式 = feature.md checkbox 进度% + phase 坐标 + 正在做(in-flight commit AC) + 漂移交叉验证；下接已完成 commit 列表
 *   - §3 下一步 + 谁做：feature.md 清单第一条未勾 AC（commit 不进 §3）；非 feature 房退 spec/pivot 方向（小孙 2026-05-31 拍 A）
 *   - §4 等谁 / blocker：F026 a2a_calls 实时查 + 24h deadline_at 防御（B024 兜底）
 *   - §5 关键决策：active 5 条 + 含 [decision_id=X, msg_id] 证据链
 *   - §6 不要再做：严格只 tombstone=1（AC-P2-7 小孙 2026-05-31 拍 A）；active reject 归 §5
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
  PhaseInfo,
  RenderViewfinderInput,
  ViewfinderArtifact,
} from "./types"

// ─── 主入口 ──────────────────────────────────────────────────────────

export function renderViewfinder(input: RenderViewfinderInput): ViewfinderArtifact {
  const lines: string[] = []

  // Frontmatter
  // F027 v3 G3 修: generated_by 字段加自描述说明
  // 真相源 V16.5 chap 11 line 1255-1294 — 6 段全 SQL 拼, 不调 LLM, 设计层只有一条路径
  // 之前 "RoomCompiler (rule-based template)" 暗示多 generator 备选 → 误导
  // 改为 "rule-based-template" 明示固定方式，注释说明设计原意
  lines.push("---")
  lines.push(`viewfinder_id: ${makeViewfinderId(input.roomId, input.generatedAt)}`)
  lines.push(`generated_at: ${input.generatedAt}`)
  lines.push(
    "generated_by: rule-based-template  # V16.5 chap 11 · 6 段全 SQL 拼, 不调 LLM (设计层固定单路径)",
  )
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

  // §4 等谁 / blocker（P12.b 小孙 2026-05-22 拍：a2a + decision-unresolved 合并 / c1 入口内联）
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
  // AC-P2-9（小孙 2026-05-31 拍 A）：§1 优先 feature/bug 文档 H1 标题（带 F-id/B-id 前缀），
  // 让 agent 一眼知道"这房间在做哪个 feature + 主题"。全确定性零 LLM（LLM 提炼路径 descope）。
  if (input.featureTopic) {
    return input.featureTopic
  }
  // fallback 1: tombstone 类 spec 决策（永久投影 — plan chap 11 行 1198-1200 设计意图）
  const tombstoneSpec = input.tombstoneDecisions.find((d) => d.decisionType === "spec")
  if (tombstoneSpec) {
    return `${tombstoneSpec.content}（${formatDecisionRef(tombstoneSpec)}, tombstone）`
  }
  // fallback 2: 最新 active spec 决策
  const latestSpec = input.activeDecisions.find((d) => d.decisionType === "spec")
  if (latestSpec) {
    return `${latestSpec.content}（${formatDecisionRef(latestSpec)}）`
  }
  // fallback 3: session_groups.title（纯闲聊房，无 feature/bug、无 spec 决策）
  return `${input.sessionGroupTitle}（fallback: 无 feature/bug 文档、无 spec 决策入 ledger）`
}

// ─── §2 当前进度 ─────────────────────────────────────────────────────
//
// 小孙 2026-05-13 真数据 walkthrough 反馈：原 messages 关键词扫法没时间语义，
// 容易抓到早期"在后台跑"等过期句子。改为从最新 active commit 决策拼"已完成"列表，
// 因为 commit 决策本身就是"已批准 / 已完成"语义的承诺事件。
//
// P12.b 小孙 2026-05-22 拍方案 Y（A+B 叠加）：
//   - 顶部 phase 坐标行 "F027 Phase 3 Week 2 Day 10 (commit 694fcc1)"（如 caller 抓到 phaseInfo）
//   - 下方已完成 commit decisions 列表（保留当前态）
//   - phaseInfo=null（git 不可用 / 抓不到 / 房间无 feature ID）→ 只显示列表（语义 A fallback）
//
// 算法：phaseInfo 由 compile-fn spawn git log 预查 + 房间 ID 验证后传入。
// renderer 是纯函数，不发起 IO。

const PROGRESS_COMMIT_LIMIT = 5

function renderProgress(input: RenderViewfinderInput): string {
  const sections: string[] = []

  // (S) 站会式进度行（小孙 2026-05-31 拍 A）
  //   - % 只数 feature.md checkbox（featureProgress），commit 一律不算 AC 完成
  //   - in-flight: 最新 commit 的 AC tag（phaseInfo.acs[0]）= "正在做"，不进 %
  //   - 漂移交叉验证: 最新 commit 的 AC ≠ 清单第一条未勾 → 暴露"做完忘勾/跳做"
  const prog = input.featureProgress
  if (prog) {
    const headLines: string[] = []
    let head = `进度: ${prog.done}/${prog.total} AC (${prog.pct}%)`
    if (input.phaseInfo) head += ` · ${formatPhaseCoordLine(input.phaseInfo)}`
    headLines.push(head)
    const inFlight = input.phaseInfo?.acs?.[0]
    if (inFlight) {
      const sha = input.phaseInfo?.commitShortSha
      headLines.push(`正在做: ${inFlight}${sha ? `（最近 commit ${sha}）` : ""}`)
      if (prog.firstUndoneAC && prog.firstUndoneAC.id !== inFlight) {
        headLines.push(
          `⚠ 漂移: 最近 commit 在 ${inFlight}，但清单第一条未勾是 ${prog.firstUndoneAC.id}（做完忘勾？跳做？）`,
        )
      }
    }
    sections.push(headLines.join("\n"))
  } else if (input.phaseInfo) {
    // (B) 非 feature 房但抓到 phase 坐标 → 保留坐标行
    sections.push(formatPhaseCoordLine(input.phaseInfo))
  }

  // (A) 已完成 commit decisions 列表
  const commits = input.activeDecisions
    .filter((d) => d.decisionType === "commit")
    .slice(0, PROGRESS_COMMIT_LIMIT)
  if (commits.length === 0) {
    if (sections.length === 0) {
      return "（暂无 commit 类决策入 ledger，无法描绘进度）"
    }
    return sections.join("\n\n")
  }
  const listLines = commits.map((d) => `- ${d.content}（${formatDecisionRef(d)}）`)
  sections.push(`已完成：\n${listLines.join("\n")}`)
  return sections.join("\n\n")
}

function formatPhaseCoordLine(info: PhaseInfo): string {
  const parts: string[] = [info.featureId]
  if (info.phase !== undefined) parts.push(`Phase ${info.phase}`)
  if (info.week !== undefined) parts.push(`Week ${info.week}`)
  if (info.day !== undefined) parts.push(`Day ${info.day}`)
  let line = parts.join(" ")
  if (info.acs && info.acs.length > 0) line += ` · ${info.acs.join(" + ")}`
  if (info.commitShortSha) line += ` (commit ${info.commitShortSha})`
  return line
}

// ─── §3 下一步 + 谁做 ────────────────────────────────────────────────

function renderNextStep(input: RenderViewfinderInput): string {
  // §3 站会式下一步（小孙 2026-05-31 拍 A）：feature.md 清单第一条未勾 AC。
  // 铁律：commit 一律不进 §3（commit = 已完成，归 §2 in-flight 指针）；只取 checkbox `- [ ]` 第一条。
  // 非 feature 房 / 抓不到清单 → 退最新 spec/pivot 方向决策（仍不取 commit），再退待定。
  const prog = input.featureProgress
  if (prog?.firstUndoneAC) {
    return `${prog.firstUndoneAC.id} ${prog.firstUndoneAC.title}（${prog.featureId} 清单第一条未勾 AC）`
  }
  if (prog && prog.total > 0) {
    return `✅ ${prog.featureId} 全部 ${prog.total} 条 AC 已勾完`
  }
  const direction = input.activeDecisions.find(
    (d) => d.decisionType === "spec" || d.decisionType === "pivot",
  )
  if (direction) {
    return `${direction.content}（${formatDecisionRef(direction)}）`
  }
  return "（无追踪 feature 清单、无 spec/pivot 方向决策，下一步待定 — 进展见 §2）"
}

// ─── §4 等谁 / blocker（含 B024 24h 防御过滤） ───────────────────────

export function renderBlockers(input: RenderViewfinderInput): string {
  const lines: string[] = []
  // (1) a2a blockers — F026 a2a_calls 实时查（B024 24h 防御过滤）
  for (const c of input.blockerCalls) {
    lines.push(`- ${renderBlockerLine(c)}`)
  }
  // (2) decision-unresolved 内联（P12.b 小孙 2026-05-22 拍 c1）
  // coverage.unresolvedMessageIds 是 extractor LLM 判模糊的候选 message_id（还没入 ledger）
  // 点 "confirm" 调 POST /api/rooms/:id/decisions（Week 2 Day 6 done）→ 升级成 D-X 入档案
  for (const msgId of input.coverage.unresolvedMessageIds) {
    const msg = input.recentMessages.find((m) => m.messageId === msgId)
    const author = msg?.authorAlias ?? "unknown"
    const excerpt = msg?.content
      ? msg.content.length > 60
        ? `${msg.content.slice(0, 60).replace(/\n/g, " ")}…`
        : msg.content.replace(/\n/g, " ")
      : "(excerpt unavailable)"
    lines.push(`- 等 @小孙 confirm: msg_${msgId} by ${author} — "${escapeYaml(excerpt)}"`)
  }
  if (lines.length === 0) {
    return "无 blocker（无 pending/working/failed/timeout a2a_calls + 无 unresolved candidates）"
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

// AC-P2-8（小孙 2026-05-31 拍）：§5 按重要性加权排序 pivot>spec>reject>commit。
// 方向类(pivot/spec)比执行类(reject/commit)更该先看到。纯展示重要性，与 §6 红线语义无关。
const DECISION_TYPE_WEIGHT: Record<string, number> = { pivot: 0, spec: 1, reject: 2, commit: 3 }

function renderDecisionsSummary(decisions: ReadonlyArray<DecisionRow>): string {
  if (decisions.length === 0) return ""
  // 稳定排序：先按类型权重，权重相同保留原始顺序（decided_at DESC，caller 已排）
  const sorted = decisions
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      const wa = DECISION_TYPE_WEIGHT[a.d.decisionType] ?? 99
      const wb = DECISION_TYPE_WEIGHT[b.d.decisionType] ?? 99
      return wa !== wb ? wa - wb : a.i - b.i
    })
    .map((x) => x.d)
  const slice = sorted.slice(0, DECISIONS_LIMIT)
  return slice.map((d) => `- ${formatDecisionRef(d)}: ${d.content}`).join("\n")
}

// ─── §6 不要再做 ─────────────────────────────────────────────────────

function renderDoNotList(input: RenderViewfinderInput): string {
  // AC-P2-7（小孙 2026-05-31 拍 A）：§6 = 永久红线，严格只收 tombstone=1。
  // active reject（可被 supersede，非永久红线）不进 §6 —— 它仍在 §5「关键决策」呈现，不丢信息。
  // 此前含 active reject 是范-r3 P2-2 锁定的旧契约，本次按 AC 原意收紧。
  const items: DecisionRow[] = []
  for (const d of input.tombstoneDecisions) {
    if (d.decisionType === "reject" || d.decisionType === "pivot") items.push(d)
  }
  if (items.length === 0) return "（暂无 tombstone 永久红线决策）"
  // P12.b 小孙 2026-05-22 拍：tombstone 三合一拼到 ref 方括号内（不再外挂 [tombstone]）
  return items
    .slice(0, DECISIONS_LIMIT)
    .map((d) => `- ${d.content}（${formatDecisionRefWithTombstone(d)}）`)
    .join("\n")
}

// ─── helpers ────────────────────────────────────────────────────────

function formatDecisionRef(d: DecisionRow): string {
  const msgRef = d.sourceMessageIds[0] ?? "(no msg)"
  return `D-${d.decisionId} [msg_${msgRef}, ${d.decidedBy}]`
}

/**
 * P12.b 小孙 2026-05-22 拍 §6 三合一：tombstone 标记拼进 ref 方括号
 * （区别 formatDecisionRef：active/§1/§5 不带 tombstone 标记，§6 单独用此 helper）
 *
 * 例：D-5 [msg_180, 小孙, tombstone] vs D-21 [msg_470, 小孙]
 */
function formatDecisionRefWithTombstone(d: DecisionRow): string {
  const msgRef = d.sourceMessageIds[0] ?? "(no msg)"
  const parts = [`msg_${msgRef}`, d.decidedBy]
  if (d.tombstone) parts.push("tombstone")
  return `D-${d.decisionId} [${parts.join(", ")}]`
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
