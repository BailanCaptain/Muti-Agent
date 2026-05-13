/**
 * F027 P12 · Decision Coverage Check（范-r2 Q-2 三集合解法）
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1238-1253
 *
 * 三集合定义（范-r2 修我的"自圆其说"问题）：
 *   - broad_candidates: 宽召出的所有候选（含不确定短指令）
 *   - resolved: 已 ledger 入账（resolvedDecisions）+ 显式判 non-decision（resolvedNonDecisions）
 *   - unresolved: Haiku 失败 / 解析失败 → 必须冒泡到 viewfinder warning
 *
 * 指标：coverage = resolved / broad
 *   - broad < minBroad → status=unknown（分母太小不下结论）
 *   - coverage >= passThreshold (95%) → status=pass
 *   - 其他 → status=warn + 列出 unresolved messageId 给手动确认入口
 *
 * 关键：分母 = broad（宽召），不是 = ledger_rows，避免"关键词命中即写入"自圆其说。
 */

import type { CoverageOptions, CoverageReport, ExtractorRun } from "./types"

const DEFAULT_PASS_THRESHOLD = 0.95
const DEFAULT_MIN_BROAD = 3

export function computeCoverage(run: ExtractorRun, opts: CoverageOptions = {}): CoverageReport {
  const passThreshold = opts.passThreshold ?? DEFAULT_PASS_THRESHOLD
  const minBroad = opts.minBroad ?? DEFAULT_MIN_BROAD

  const broad = run.broadCandidates.length
  const resolvedDecisions = run.resolvedDecisions.length
  const resolvedNonDecisions = run.resolvedNonDecisions.length
  const resolved = resolvedDecisions + resolvedNonDecisions
  const unresolved = run.unresolved.length
  const unresolvedMessageIds = run.unresolved.map((u) => u.candidate.messageId)

  if (broad === 0) {
    return {
      broad: 0,
      resolved: 0,
      unresolved: 0,
      coverage: null,
      status: "unknown",
      reason: "no_broad_candidates",
      unresolvedMessageIds: [],
    }
  }

  if (broad < minBroad) {
    return {
      broad,
      resolved,
      unresolved,
      coverage: broad === 0 ? null : resolved / broad,
      status: "unknown",
      reason: `broad=${broad} < minBroad=${minBroad}`,
      unresolvedMessageIds,
    }
  }

  const coverage = resolved / broad

  if (coverage >= passThreshold) {
    return {
      broad,
      resolved,
      unresolved,
      coverage,
      status: "pass",
      reason: `coverage=${(coverage * 100).toFixed(0)}% >= ${(passThreshold * 100).toFixed(0)}%`,
      unresolvedMessageIds,
    }
  }

  return {
    broad,
    resolved,
    unresolved,
    coverage,
    status: "warn",
    reason: `coverage=${(coverage * 100).toFixed(0)}% < passThreshold=${(passThreshold * 100).toFixed(0)}%, ${unresolved} unresolved candidates`,
    unresolvedMessageIds,
  }
}

/**
 * 渲染 Coverage warning 列表（viewfinder frontmatter / footer 用）。
 * 返回 markdown 列表片段，每条 unresolved 一行 + 提示手动 POST API。
 */
export function renderCoverageWarning(
  report: CoverageReport,
  roomId: string,
  unresolvedExcerptByMessageId: Map<string, string>,
): string {
  if (report.status === "pass") return ""
  if (report.unresolvedMessageIds.length === 0) {
    return `> ⚠️ Coverage ${report.status}: ${report.reason}\n`
  }
  const lines: string[] = [`> ⚠️ Coverage ${report.status}: ${report.reason}`]
  lines.push("> Unresolved candidates (need manual confirm):")
  for (const id of report.unresolvedMessageIds) {
    const excerpt = unresolvedExcerptByMessageId.get(id) ?? "(excerpt unavailable)"
    const truncated = excerpt.length > 80 ? `${excerpt.slice(0, 80)}…` : excerpt
    lines.push(`>   - msg ${id}: "${truncated.replace(/\n/g, " ")}"`)
  }
  lines.push(`> 👉 手动确认: POST /api/rooms/${roomId}/decisions`)
  return `${lines.join("\n")}\n`
}
