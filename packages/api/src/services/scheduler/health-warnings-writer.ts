/**
 * F027 续 · HealthWarningsWriter —— warnings 文件生产链（NHC 生产者）
 *
 * 背景：KB warnings tab 派生数据源 = `<wikiRoot>/warnings/*.md` + wiki_events
 * action='warning_raised'（wiki-meta.ts AC-P4-9 a），但生产里两者都没有 producer：
 * ingest 隔离写 _quarantined/、DriftDetector 开 update draft —— 视图恒空。
 * 本 writer 挂 NightlyHealthCheck.onReport，是这条链缺的生产者。
 *
 * 落盘 / 事件 / leader fencing / fail-soft 的底层机制收敛进共享原语 `writeWarningFile`
 * （warnings-file-writer.ts，DriftDetector 也复用，家规 P4 单一真相源）。本文件只负责把
 * HealthCheckReport 的 findings 渲染成 spec（severity / 标题 / 正文条目）。
 *
 * 行为（机制细节见 warnings-file-writer.ts）：
 *   - findings 全空 → 不写不发（无告警不制造噪声文件）
 *   - 有 findings → `<wikiRoot>/warnings/nightly-health-<YYYY-MM-DD>.md`（同日重跑覆盖，幂等）
 *     + wiki_events warning_raised（注入 events + 捕获 leader term 时）
 *   - severity 取 findings 类别最高档；generated_by=nightly-health-check → NHC isDerivedView 豁免
 *
 * 根约定：wikiRoot = **单层** wikiServices.wikiRoot（= scheduler-bootstrap opts.wikiIndexRoot
 * = WikiMetaScanner 的根）。scanner 只扫 `<该根>/warnings/`，写双层 roomCompileWikiRoot
 * 视图读不到（B2 双根教训）。
 */

import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import type { HealthCheckReport } from "./nightly-health-check"
import { type WarningSeverity, writeWarningFile } from "./warnings-file-writer"

export interface HealthWarningsWriterDeps {
  /** 单层 wiki 根（warnings/ 的父目录 = WikiMetaScanner 的 wikiRoot）。 */
  wikiRoot: string
  /** 注入则写 wiki_events warning_raised（PREPARE+COMMIT）；缺省只落文件。 */
  events?: Pick<WikiEventsRepository, "appendPending" | "commit">
  /**
   * leader 上下文（wiki_events reject_stale_leader trigger 要求）。currentLeaderTerm 返回 null =
   * 本轮无合法 leader 身份 → 跳过事件写入（文件照写）。详见 warnings-file-writer.ts deps doc
   * （德彪 batch2-r3 P2：禁 "999" 超级 term 兜底）。
   */
  leaderContext?: { currentLeaderTerm(): string | null; newFencingToken(): string }
  clock?: () => Date
  warn?: (msg: string) => void
}

const ALIAS = "nightly-health-check"

export function createHealthWarningsWriter(
  deps: HealthWarningsWriterDeps,
): (report: HealthCheckReport) => Promise<void> {
  return async (report: HealthCheckReport): Promise<void> => {
    const total = countFindings(report)
    if (total === 0) return

    const now = (deps.clock ?? (() => new Date()))()
    const date = now.toISOString().slice(0, 10)
    await writeWarningFile(
      {
        subtype: "nightly-health",
        severity: deriveSeverity(report),
        source: "wiki-governance",
        detectedAt: report.scannedAt,
        alias: ALIAS,
        fileName: `nightly-health-${date}.md`,
        title: `Nightly Health Check — ${total} findings（${date}）`,
        body: renderBody(report),
        diffSummary: summarizeCounts(report),
        reason: `nightly health check: ${total} findings`,
      },
      {
        wikiRoot: deps.wikiRoot,
        events: deps.events,
        leaderContext: deps.leaderContext,
        clock: () => now, // 文件 date / 事件 ts 共享同一 now
        warn: deps.warn,
      },
    )
  }
}

function countFindings(r: HealthCheckReport): number {
  return (
    r.deadLinks.length +
    r.orphans.length +
    r.missingFrontmatter.length +
    r.canonicalOwnerDrift.length +
    r.draftExpired.length +
    r.duplicateCanonical.length +
    r.deadSupersedes.length
  )
}

/** 类别 → 严重度：链路断/canonical 冲突=high；元数据缺/漂移=warn；孤儿/过期=info。 */
function deriveSeverity(r: HealthCheckReport): WarningSeverity {
  if (r.deadLinks.length || r.duplicateCanonical.length || r.deadSupersedes.length) return "high"
  if (r.missingFrontmatter.length || r.canonicalOwnerDrift.length) return "warn"
  return "info"
}

function summarizeCounts(r: HealthCheckReport): string {
  const parts: string[] = []
  if (r.deadLinks.length) parts.push(`deadLinks=${r.deadLinks.length}`)
  if (r.duplicateCanonical.length) parts.push(`duplicateCanonical=${r.duplicateCanonical.length}`)
  if (r.deadSupersedes.length) parts.push(`deadSupersedes=${r.deadSupersedes.length}`)
  if (r.missingFrontmatter.length) parts.push(`missingFrontmatter=${r.missingFrontmatter.length}`)
  if (r.canonicalOwnerDrift.length) parts.push(`canonicalOwnerDrift=${r.canonicalOwnerDrift.length}`)
  if (r.orphans.length) parts.push(`orphans=${r.orphans.length}`)
  if (r.draftExpired.length) parts.push(`draftExpired=${r.draftExpired.length}`)
  return parts.join(", ")
}

/** 单类条目渲染上限（防一类爆几千条把文件撑炸；尾部标注截断数）。 */
const MAX_ITEMS_PER_SECTION = 50

/** frontmatter + 标题之后的正文（统计行 + 各类条目）。frontmatter / `# 标题` 由原语渲染。 */
function renderBody(r: HealthCheckReport): string {
  const lines: string[] = [
    `扫描实体 ${r.totalEntities} 个 @ ${r.scannedAt}。${summarizeCounts(r)}`,
    "",
  ]
  section(lines, "Dead links（引用不存在的实体）", r.deadLinks, (d) => `\`${d.from}\` → \`${d.to}\``)
  section(
    lines,
    "Duplicate canonical（同一 canonical_owner_path 被多实体声称）",
    r.duplicateCanonical,
    (d) => `\`${d.canonicalOwnerPath}\` ← ${d.claimants.join(", ")}`,
  )
  section(lines, "Dead supersedes（supersedes 指向不存在实体）", r.deadSupersedes, (d) =>
    `\`${d.path}\` supersedes ${d.missing.map((m) => `\`${m}\``).join(", ")}`,
  )
  section(
    lines,
    "Missing frontmatter（缺 sources / canonical_owner_path）",
    r.missingFrontmatter,
    (m) => `\`${m.path}\` 缺 ${m.missing.join(", ")}`,
  )
  section(
    lines,
    "Canonical owner drift（实际 path 与声明不符）",
    r.canonicalOwnerDrift,
    (c) => `\`${c.path}\` 声明 \`${c.declared}\``,
  )
  section(lines, "Orphans（无 inbound 引用）", r.orphans, (p) => `\`${p}\``)
  section(
    lines,
    "Draft expired（超 TTL 归档）",
    r.draftExpired,
    (d) => `\`${d.path}\`（${d.ageDays} 天${d.movedTo ? ` → \`${d.movedTo}\`` : "，dry-run 未移"}）`,
  )
  return lines.join("\n")
}

function section<T>(lines: string[], title: string, items: T[], render: (item: T) => string): void {
  if (items.length === 0) return
  lines.push(`## ${title}（${items.length}）`, "")
  for (const item of items.slice(0, MAX_ITEMS_PER_SECTION)) lines.push(`- ${render(item)}`)
  if (items.length > MAX_ITEMS_PER_SECTION) {
    lines.push(`- …（截断，共 ${items.length} 条，余 ${items.length - MAX_ITEMS_PER_SECTION} 条见 NHC 日志）`)
  }
  lines.push("")
}
