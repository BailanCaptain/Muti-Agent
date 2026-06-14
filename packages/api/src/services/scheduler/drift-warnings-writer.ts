/**
 * F027 收尾修1 · DriftWarningsWriter —— DriftDetector 的 warnings tab 生产者
 *
 * 小孙拍（2026-06-14，覆盖前「专门前端通知 UI」选项）：drift 告警**复用现有「警告」tab**
 * （「放记忆系统，下面那个警告栏」）。最省接法 = drift cron 检到 trigger / 开 draft 失败时往
 * `<wikiIndexRoot>/warnings/` 写一条 warning，复用共享原语 writeWarningFile（与 NHC 同套 leader
 * fencing + fail-soft）→ 现有 GET /api/wiki/warnings + warnings-tab 自动显示，**零新前端、零 ws
 * union 改、不要 toast/铃铛**。
 *
 * 与 ws 旁路告警（pushDriftAlert → scheduler.drift_alert）的关系：ws 旁路保留（无 UI consumer，
 * 预留位）；本 writer 才是小孙真看得到的告警通道。
 *
 * 回环排除（设计审 + Explore 测绘确认）：
 *   - generated_by=drift-detector → NightlyHealthCheck.isDerivedView 豁免，warning 文件不会被反扫成
 *     orphan/缺 frontmatter
 *   - DriftDetector 扫 trigger 走 DB（wiki_events + a2a_calls），不扫文件 → 新 warning 文件不产新 trigger
 *   - warnings/ 不在 WeeklyDraftDigest 的 draft/ 扫描范围、不在 docs-watcher 的 docs/ 监听范围
 */

import { DRIFT_DETECTOR_ALIAS, type DriftDetectionResult } from "./drift-detector"
import { type WarningSeverity, type WriteWarningFileDeps, writeWarningFile } from "./warnings-file-writer"

/** 单类条目渲染上限（防 trigger 爆量把文件撑炸）。 */
const MAX_ITEMS = 50

/**
 * 建 drift warnings writer。返回的函数挂在 drift cron（runDriftCron）里，drift.run() 结果有
 * 开 draft / 失败时调用。无 drift（0 开 0 失败）→ 不写（对齐 NHC 0-findings 不制造噪声）。
 */
export function createDriftWarningsWriter(
  deps: WriteWarningFileDeps,
): (result: DriftDetectionResult) => Promise<void> {
  return async (result: DriftDetectionResult): Promise<void> => {
    const opened = result.draftsOpened.length
    const failed = result.failed.length
    if (opened === 0 && failed === 0) return // 无 drift 不打扰

    const now = (deps.clock ?? (() => new Date()))()
    const date = now.toISOString().slice(0, 10)
    // failed>0 = 自动开 draft 链断了（drift 检到却没进审批队列）→ critical；
    // 纯 opened = drift 检到 + draft 已进队列待人审 → warn（提示性，非故障）。
    const severity: WarningSeverity = failed > 0 ? "critical" : "warn"

    await writeWarningFile(
      {
        subtype: "drift_alert",
        severity,
        source: DRIFT_DETECTOR_ALIAS,
        detectedAt: result.scannedAt,
        alias: DRIFT_DETECTOR_ALIAS,
        fileName: `drift-detector-${date}.md`,
        title: `Drift Detection — ${opened} draft(s) opened${failed > 0 ? `, ${failed} failed` : ""}（${date}）`,
        body: renderBody(result),
        diffSummary: `draftsOpened=${opened}, failed=${failed}, skippedDuplicate=${result.skippedDuplicate}`,
        reason: `drift detector: ${opened} draft(s) opened, ${failed} failed`,
      },
      { ...deps, clock: () => now }, // 文件 date / 事件 ts 共享同一 now
    )
  }
}

function renderBody(result: DriftDetectionResult): string {
  const lines: string[] = [
    `Drift 扫描 @ ${result.scannedAt}：开 draft ${result.draftsOpened.length} 篇，失败 ${result.failed.length}，跨 run/重复 skip ${result.skippedDuplicate}。`,
    "",
    "drift draft 是系统自动生成的更新建议，已进 KB 审批队列（wiki/concepts/draft/_auto/）等人审 promote。",
    "",
  ]
  if (result.draftsOpened.length > 0) {
    lines.push(`## 已开 update draft（${result.draftsOpened.length}）`, "")
    for (const d of result.draftsOpened.slice(0, MAX_ITEMS)) {
      lines.push(`- [${d.trigger.kind}] ${d.title}`)
    }
    if (result.draftsOpened.length > MAX_ITEMS) {
      lines.push(`- …（截断，共 ${result.draftsOpened.length} 篇）`)
    }
    lines.push("")
  }
  if (result.failed.length > 0) {
    lines.push(`## 开 draft 失败（${result.failed.length}）`, "")
    for (const f of result.failed.slice(0, MAX_ITEMS)) {
      lines.push(`- [${f.trigger.kind}] \`${f.trigger.ref}\` — ${f.error}`)
    }
    if (result.failed.length > MAX_ITEMS) {
      lines.push(`- …（截断，共 ${result.failed.length} 条）`)
    }
    lines.push("")
  }
  return lines.join("\n")
}
