/**
 * 德彪 r2 P1 · 人审豁免文档 promote 二审加严 —— taintedSourceFields 服务端动态导出
 *
 * 背景:V14 layer 3(tainted_source_direct_quote)只在 caller 传 taintedSourceFields 时
 * 运行,而 KB 前端不传 → 人审豁免通道(ingest-human-reviewed.ts)落的 draft 即使 body
 * 直引危险原文,promote 也只过 layer 1/2。本模块在 promote/preview 服务端补上该层:
 *
 *   - 仅对 frontmatter 带 `ingest_exemption` 标记的文档生效(豁免通道唯一产物;普通
 *     draft 零回归——它们的 taint 语义仍走 caller 显式传参)。
 *   - 对 src 全文跑 sanitizeRawDrop **检测**(不消费其 blocked 决策),把命中的
 *     redLineTriggers.matched + quarantinedSegments.original 作为 taintedSourceFields。
 *   - 片段若仍在 body 里(未改写为陈述句)→ layer 3 substring 命中 → promote 拒。
 *
 * 为什么不把危险片段持久化进 draft frontmatter(德彪建议的另一形态):
 *   1. frontmatter 会随 promote 进 canonical → 危险原文泄进 wiki 正文/FTS 索引/召回;
 *   2. V14 layer 1/2 扫的是全文(含 frontmatter),片段一旦写进去 promote 永拒,死锁;
 *   3. 动态复检零持久化、不可被 client 绕过(服务端推导,不信 caller)。
 */

import { sanitizeRawDrop } from "../sanitize/sanitize-raw-drop"

const LEADING_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/
/** 防 frontmatter 超长片段灌爆 audit:截断不影响 layer3(前缀仍是 body 的 substring)。 */
const MAX_FIELD_CHARS = 300
const MAX_FIELDS = 32

/** 文档是否人审豁免通道产物(frontmatter 顶层含 ingest_exemption 键)。 */
export function hasIngestExemption(content: string): boolean {
  const m = LEADING_FRONTMATTER_RE.exec(content)
  if (!m) return false
  return /^ingest_exemption\s*:/m.test(m[1])
}

/**
 * 豁免文档 → sanitize 复检命中的危险片段(去重、截断、限量)。
 * 非豁免文档 → []（不改变普通 draft 的 promote 行为）。
 */
export function deriveExemptionTaintedFields(content: string): string[] {
  if (!hasIngestExemption(content)) return []
  const det = sanitizeRawDrop(content)
  const spans = [
    ...det.redLineTriggers.map((t) => t.matched),
    ...det.quarantinedSegments.map((s) => s.original),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of spans) {
    const t = (s ?? "").trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t.length > MAX_FIELD_CHARS ? t.slice(0, MAX_FIELD_CHARS) : t)
    if (out.length >= MAX_FIELDS) break
  }
  return out
}
