/**
 * F027 P4.5 · 跨 drop reference link 检测
 * 真相源：docs/plans/V16.5-final.md chap 7 行 825 ("跨 drop 引用链：drop A 提到 drop B")
 *
 * 检测 currentText 是否显式引用 candidate.id 或 candidate 的 series_id。
 * 命中即 chained_suspect (reason: reference_link)。
 *
 * 引用模式：
 *   - "drop:abc-123"
 *   - "see drop abc"
 *   - "参考 drop abc"
 *   - "ref drop abc"
 *   - "[drop:abc-123]"
 */

/**
 * 在 currentText 中查找对 candidate.id 的显式引用。
 * 命中返回匹配片段；未命中返回 null。
 *
 * 注意：candidateId 可能含特殊字符，escape 后嵌进 regex。
 */
export function findReferenceLink(currentText: string, candidateId: string): string | null {
  if (!candidateId) return null
  const escaped = escapeRegex(candidateId)
  // 多种引用形式：drop:ID / see drop ID / 参考 drop ID / [drop:ID] / ref drop ID
  // 单 regex 覆盖：(?:drop:|see drop |参考 drop |ref drop |\[drop:)<id>
  const re = new RegExp(
    `(?:drop:|see\\s+drop\\s+|参考\\s*drop\\s+|ref\\s+drop\\s+|\\[drop:)${escaped}(?:\\b|\\])`,
    "i",
  )
  const m = currentText.match(re)
  return m ? m[0] : null
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
