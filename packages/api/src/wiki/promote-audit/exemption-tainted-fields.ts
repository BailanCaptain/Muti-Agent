/**
 * 德彪 r2 P1 + r3 P1 · 人审豁免文档 promote 二道安全关
 *
 * 背景:人审豁免通道(scripts/ingest-human-reviewed.ts)是唯一让 sanitize-blocked 的原文
 * 进入编译→draft 的路径(小孙拍 B)。普通 draft 的 sanitize 在 ingest 入口已做;豁免 draft
 * 的编译产物可能仍残留危险内容(LLM 被注入诱导/直引原文样例),promote 转正进 canonical
 * 前必须复检。
 *
 * 方案演进:
 *   r2: 服务端 sanitize 复检 → 命中片段动态注入 V14 layer3 taintedSourceFields(substring 比对)。
 *   r3 德彪 P1 实测推翻:redLineTrigger.matched 是 NFKC/confusable 归一化**后**的 ASCII 形态,
 *     body 是原文域(西里尔/全角同形字);layer3 `body.includes()` 跨域比对必漏,全角注入连
 *     quarantinedSegments 都不产(NFKC 预处理非 quarantine)→ substring 方案对同形字完全失效。
 *   r3 改方案(德彪建议 b):**不做 substring 注入,直接用 sanitize blocked 判定**。
 *     blocked 对全文在归一化域内生效、无跨域盲区;语义也更强——豁免文档的编译产物若仍触发
 *     sanitize 红线(jailbreak 模板/危险标签/编码 jailbreak/超限),就是不该转正 canonical。
 *     实测:西里尔 "ignоre previous instructions" 与全角同形 → blocked=true 而 V14 passed=true,
 *     正是本门槛要堵的窗口;干净中文摘要 blocked=false 不误伤。
 *
 * 仅对 frontmatter 带 `ingest_exemption` 的豁免文档生效;普通 draft hasIngestExemption=false
 * 直接放行 → 零回归(它们的 body 是 ingest 时 sanitize 后的干净产物)。
 */

import { sanitizeRawDrop } from "../sanitize/sanitize-raw-drop"

const LEADING_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

/** 文档是否人审豁免通道产物(frontmatter 顶层含 ingest_exemption 键)。 */
export function hasIngestExemption(content: string): boolean {
  const m = LEADING_FRONTMATTER_RE.exec(content)
  if (!m) return false
  return /^ingest_exemption\s*:/m.test(m[1])
}

export interface ExemptionSanitizeCheck {
  /** 仅 hasIngestExemption 的文档才可能 true;非豁免文档恒 false(放行)。 */
  blocked: boolean
  /** blocked=true 时填触发的红线 reason 列表(去重),供 audit hint / 审计。 */
  reasons: string[]
}

/**
 * 豁免文档 promote 复检:对 src 全文跑 sanitizeRawDrop,仍 blocked → 拒 promote。
 * 非豁免文档 → { blocked:false }(普通 draft 不受影响)。
 */
export function checkExemptionSanitizeBlocked(content: string): ExemptionSanitizeCheck {
  if (!hasIngestExemption(content)) return { blocked: false, reasons: [] }
  const det = sanitizeRawDrop(content)
  if (!det.blocked) return { blocked: false, reasons: [] }
  const reasons: string[] = Array.from(new Set(det.redLineTriggers.map((t) => String(t.reason))))
  // redLineTriggers 为空但 quarantinedRatio 超阈也会 blocked → 给个兜底 reason 不丢信息。
  if (reasons.length === 0) reasons.push(`quarantined_ratio:${det.quarantinedRatio.toFixed(2)}`)
  return { blocked: true, reasons }
}
