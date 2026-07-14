import type { DigestOverviewRef } from "./types"

/**
 * 每条速览必须代表独立事件：同一条目 ID 不能被两条速览共同消费。
 * 这里同时拒绝单条速览内部的重复 ID，避免不同生产阶段对重复项产生不同解释。
 */
export function hasPairwiseDisjointOverviewItemIds(
  overviewRefs: readonly DigestOverviewRef[],
): boolean {
  const seen = new Set<string>()
  for (const overview of overviewRefs) {
    for (const itemId of overview.itemIds) {
      if (seen.has(itemId)) return false
      seen.add(itemId)
    }
  }
  return true
}
