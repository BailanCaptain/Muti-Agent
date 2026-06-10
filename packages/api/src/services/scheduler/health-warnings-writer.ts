/**
 * F027 续 · HealthWarningsWriter —— warnings 文件生产链
 *
 * 背景：KB warnings tab 派生数据源 = `<wikiRoot>/warnings/*.md` + wiki_events
 * action='warning_raised'（wiki-meta.ts AC-P4-9 a），但生产里两者都没有 producer：
 * ingest 隔离写 _quarantined/、DriftDetector 开 update draft —— 视图恒空。
 * 本 writer 挂 NightlyHealthCheck.onReport，是这条链缺的生产者。
 *
 * 行为：
 *   - findings 全空 → 不写不发（无告警不制造噪声文件）
 *   - 有 findings → writeFileAtomic `<wikiRoot>/warnings/nightly-health-<YYYY-MM-DD>.md`
 *     （同日重跑覆盖，幂等不堆积）+ wiki_events PREPARE→立即 COMMIT
 *     （warning_raised 与 recall_escalate 同款：event row 即终态，无 reconciler 扫描需求）
 *   - frontmatter 字段按 WikiMetaScanner.WarningFrontmatter 约定
 *     （type/severity/detected_at/raised_by；severity 取 findings 类别最高档）
 *   - 全程 fail-soft：文件失败 warn 不抛；events 失败 warn 不抛（文件已落仍可被 tab 扫到）
 *     —— NHC 主链（draftExpired mv 等）不能因告警落盘失败而中断。
 *
 * 根约定：wikiRoot = **单层** wikiServices.wikiRoot（= scheduler-bootstrap opts.wikiIndexRoot
 * = WikiMetaScanner 的根）。scanner 只扫 `<该根>/warnings/`，写双层 roomCompileWikiRoot
 * 视图读不到（B2 双根教训）。
 */

import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import { writeFileAtomic } from "../../wiki/atomic-write"
import type { HealthCheckReport } from "./nightly-health-check"

export interface HealthWarningsWriterDeps {
  /** 单层 wiki 根（warnings/ 的父目录 = WikiMetaScanner 的 wikiRoot）。 */
  wikiRoot: string
  /** 注入则写 wiki_events warning_raised（PREPARE+COMMIT）；缺省只落文件。 */
  events?: Pick<WikiEventsRepository, "appendPending" | "commit">
  /** leader 上下文（wiki_events reject_stale_leader trigger 要求）；默认 "999" + uuid。 */
  leaderContext?: { currentLeaderTerm(): string; newFencingToken(): string }
  clock?: () => Date
  warn?: (msg: string) => void
}

type Severity = "critical" | "high" | "warn" | "info"

const ALIAS = "nightly-health-check"

export function createHealthWarningsWriter(
  deps: HealthWarningsWriterDeps,
): (report: HealthCheckReport) => Promise<void> {
  const clock = deps.clock ?? (() => new Date())
  const warn = deps.warn ?? (() => {})
  const leaderContext = deps.leaderContext ?? {
    // createSimpleLeaderContext 同款："999" 保证 Phase 5 接真 Compiler Leader Lease 前
    // 不被 reject_stale_leader trigger 拒（production-recall-executor-deps.ts:156 注释）。
    currentLeaderTerm: () => "999",
    newFencingToken: () => createHash("sha256").update(`${Math.random()}`).digest("hex").slice(0, 32),
  }

  return async (report: HealthCheckReport): Promise<void> => {
    const total = countFindings(report)
    if (total === 0) return

    const now = clock()
    const date = now.toISOString().slice(0, 10)
    const fileName = `nightly-health-${date}.md`
    const content = renderWarningMarkdown(report, now, total)

    try {
      const dir = path.join(deps.wikiRoot, "warnings")
      await fs.mkdir(dir, { recursive: true })
      writeFileAtomic(path.join(dir, fileName), content)
    } catch (err) {
      warn(
        `health-warnings-writer: write failed (fail-soft, warnings tab 本轮无文件): ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }

    if (!deps.events) return
    try {
      const event = deps.events.appendPending({
        ts: now.toISOString(),
        alias: ALIAS,
        action: "warning_raised",
        path: `wiki/warnings/${fileName}`,
        baseHash: null,
        attemptedHash: sha256(content),
        diffSummary: summarizeCounts(report),
        sourceMessageIds: null,
        reason: `nightly health check: ${total} findings`,
        fencingToken: leaderContext.newFencingToken(),
        leaderTerm: leaderContext.currentLeaderTerm(),
        result: "ok",
      })
      deps.events.commit(event.id, { contentHash: sha256(content) })
    } catch (err) {
      warn(
        `health-warnings-writer: wiki_events warning_raised failed (file 已落盘，仅缺审计行): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
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
function deriveSeverity(r: HealthCheckReport): Severity {
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

function renderWarningMarkdown(r: HealthCheckReport, now: Date, total: number): string {
  const lines: string[] = [
    "---",
    "type: warning",
    "subtype: nightly-health",
    `severity: ${deriveSeverity(r)}`,
    "source: wiki-governance",
    `detected_at: ${r.scannedAt}`,
    `raised_by: ${ALIAS}`,
    `generated_by: ${ALIAS}`,
    "---",
    "",
    `# Nightly Health Check — ${total} findings（${now.toISOString().slice(0, 10)}）`,
    "",
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

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}
