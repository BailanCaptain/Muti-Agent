/**
 * F027 收尾修1 · warnings 文件生产原语 —— NHC + DriftDetector 共用
 *
 * 背景：KB warnings tab 两个派生数据源 = `<wikiRoot>/warnings/*.md`（file-backed）+ wiki_events
 * action='warning_raised'（event-only 兜底）。原本只有 NightlyHealthCheck 是 producer
 * （health-warnings-writer.ts）。小孙拍：DriftDetector 检到 drift / 开 draft 失败时也要在「警告」
 * tab 可见 —— 最省接法 = 往 `wiki/warnings/` 写一条 warning，复用此原语，**零新前端、零 ws union 改**。
 *
 * 本文件把「落 warning 文件 + 写 warning_raised 事件」抽成单一真相源（家规 P4），两个生产者
 * （nightly-health / drift_alert）共用 —— 尤其复用同一套**已审 leader-term null-skip fencing**
 * （德彪 batch2-r3 P2：禁 "999" 超级 term 兜底；无身份不写事件，文件照写），drift 侧不重复实现
 * 避免重新引入该缺口。
 *
 * 行为：
 *   - writeFileAtomic `<wikiRoot>/warnings/<fileName>`（同名覆盖幂等不堆积）
 *   - frontmatter 按 WikiMetaScanner.WarningFrontmatter 契约
 *     （type/subtype/severity/source/detected_at/raised_by/generated_by）
 *     —— generated_by 非空 → NightlyHealthCheck.isDerivedView 豁免，warning 文件不会被反扫成
 *     orphan/缺 frontmatter（无回环）
 *   - 注入 events + 捕获到 leader term → wiki_events warning_raised（PREPARE→立即 COMMIT）
 *   - 两路独立 fail-soft：文件失败 → 事件兜底（tab 走 event-only）；事件失败 → 文件已落仍可被 tab 扫到
 *
 * 根约定：wikiRoot = **单层** wikiServices.wikiRoot（= scheduler-bootstrap opts.wikiIndexRoot
 * = WikiMetaScanner 的根）。写双层 roomCompileWikiRoot 视图读不到（B2 双根教训）。
 */

import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import { writeFileAtomic } from "../../wiki/atomic-write"

export type WarningSeverity = "critical" | "high" | "warn" | "info"

/** 一条 warning 的内容规格（生产者按各自语义构造，原语只负责落盘 + 写事件）。 */
export interface WarningFileSpec {
  /** warnings tab subtype（区分来源：nightly-health / drift_alert）。 */
  subtype: string
  severity: WarningSeverity
  /** warnings tab source 字段（wiki-governance / drift-detector）。 */
  source: string
  /** ISO 检测时刻（→ frontmatter detected_at；与事件 ts 可不同，事件 ts 用 deps.clock）。 */
  detectedAt: string
  /**
   * 写入器别名 → frontmatter raised_by + generated_by + wiki_events.alias。
   * generated_by 非空使该文件被 NHC isDerivedView 豁免（无回环）。
   */
  alias: string
  /** 文件名（含 .md，落 `<wikiRoot>/warnings/<fileName>`）。同名覆盖幂等。 */
  fileName: string
  /** 标题（渲染成 `# <title>`，frontmatter 之后第一行）。 */
  title: string
  /** frontmatter + 标题之后的正文 markdown（不含 frontmatter、不含 `# title`）。 */
  body: string
  /** wiki_events diffSummary（简短统计串）。 */
  diffSummary: string
  /** wiki_events reason（人类可读触发说明）。 */
  reason: string
}

export interface WriteWarningFileDeps {
  /** 单层 wiki 根（warnings/ 的父目录 = WikiMetaScanner 的 wikiRoot）。 */
  wikiRoot: string
  /** 注入则写 wiki_events warning_raised（PREPARE+COMMIT）；缺省只落文件。 */
  events?: Pick<WikiEventsRepository, "appendPending" | "commit">
  /**
   * leader 上下文（wiki_events reject_stale_leader trigger 要求）。
   *
   * 德彪 batch2-r3 P2 · currentLeaderTerm 返回 **null = 本轮无合法 leader 身份 → 跳过事件写入**
   * （文件照写）。不允许 "999" 类超级 term 兜底——trigger 只拒"小于现任"，现实 term 是 1/2/3 量级，
   * "999" 永远通过 = demote 后照样冒写。caller（scheduler-bootstrap）应在 **job 轮开始时捕获**持有
   * term 整轮固定，轮中被抢占 → 捕获的旧 term < 新任 → trigger 拒，fencing 正确。
   * 缺省实现返回 null（无身份不写）。
   */
  leaderContext?: { currentLeaderTerm(): string | null; newFencingToken(): string }
  clock?: () => Date
  warn?: (msg: string) => void
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** 渲染整篇 warning 文件（frontmatter + 标题 + 正文）。frontmatter 字段按 WarningFrontmatter 契约。 */
function renderWarningFile(spec: WarningFileSpec): string {
  return [
    "---",
    "type: warning",
    `subtype: ${spec.subtype}`,
    `severity: ${spec.severity}`,
    `source: ${spec.source}`,
    `detected_at: ${spec.detectedAt}`,
    `raised_by: ${spec.alias}`,
    `generated_by: ${spec.alias}`,
    "---",
    "",
    `# ${spec.title}`,
    "",
    spec.body,
  ].join("\n")
}

/**
 * 落一条 warning：原子写文件 + 可选写 warning_raised 事件。两路独立 fail-soft（绝不抛——
 * 不能因告警落盘失败拖垮调用方主链，如 NHC 的 draftExpired mv / drift cron 的 draft 开启）。
 */
export async function writeWarningFile(
  spec: WarningFileSpec,
  deps: WriteWarningFileDeps,
): Promise<void> {
  const warn = deps.warn ?? (() => {})
  const leaderContext = deps.leaderContext ?? {
    // 无注入 = 无 leader 身份 → 不写事件（r3：禁超级 term 兜底，见 deps doc）。
    currentLeaderTerm: () => null,
    newFencingToken: () =>
      createHash("sha256").update(`${Math.random()}`).digest("hex").slice(0, 32),
  }
  const now = (deps.clock ?? (() => new Date()))()
  const content = renderWarningFile(spec)

  // 德彪 batch2 P2-2：两路派生数据源独立 fail-soft —— wiki-meta 支持 event-only warning 兜底
  // （无文件 → hasContent=false 仍显示），fs 故障不应连坐取消事件写入（否则 fs 故障 = 两路全黑）。
  let fileWritten = false
  try {
    const dir = path.join(deps.wikiRoot, "warnings")
    await fs.mkdir(dir, { recursive: true })
    writeFileAtomic(path.join(dir, spec.fileName), content)
    fileWritten = true
  } catch (err) {
    warn(
      `warnings-file-writer: file write failed (warning_raised 事件仍会写，tab 走 event 兜底): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!deps.events) return
  // r3：轮开始未捕获到持有 lease（demote race / 无身份）→ 不写审计行。
  const leaderTerm = leaderContext.currentLeaderTerm()
  if (leaderTerm === null) {
    warn(
      "warnings-file-writer: no leader lease term captured for this run — skip warning_raised event (file path unaffected)",
    )
    return
  }
  try {
    const event = deps.events.appendPending({
      ts: now.toISOString(),
      alias: spec.alias,
      action: "warning_raised",
      path: `wiki/warnings/${spec.fileName}`,
      baseHash: null,
      attemptedHash: sha256(content),
      diffSummary: spec.diffSummary,
      sourceMessageIds: null,
      reason: spec.reason,
      fencingToken: leaderContext.newFencingToken(),
      leaderTerm,
      result: "ok",
    })
    const committed = deps.events.commit(event.id, { contentHash: sha256(content) })
    if (!committed) {
      // 德彪 batch2 P3：commit CAS false = row 非 pending（罕见 race），留 warn 别静默。
      warn(
        `warnings-file-writer: wiki_events commit returned false (eventId=${event.id}, row not pending?)`,
      )
    }
  } catch (err) {
    warn(
      `warnings-file-writer: wiki_events warning_raised failed (${fileWritten ? "file 已落盘，仅缺审计行" : "file 也失败，本轮两路全失"}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
