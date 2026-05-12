/**
 * F027 P11 · Quality Gate
 * 真相源：docs/plans/V16.5-final.md chap 10 行 1126-1152
 *
 * 4 道规则：
 *   1. score < scoreFloor（默认 0.6）→ reject 'below_floor'
 *   2. 同 path 多 query 命中 → 保留最高分，其余 reject 'duplicate_source'
 *   3. score < injectFloor（默认 0.75）→ inspectorOnly
 *   4. injected 累计 token > totalTokenCap（默认 1200）→ 超出部分降级到 inspector
 */

import type {
  QualityGateBuckets,
  QualityGateOptions,
  RecallHit,
  RecallResult,
  RejectReason,
} from "./types"

const DEFAULT_OPTS: QualityGateOptions = {
  scoreFloor: 0.6,
  injectFloor: 0.75,
  totalTokenCap: 1200,
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
}

export interface ApplyQualityGateResult {
  buckets: QualityGateBuckets
  totalTokens: number
  budgetExceeded: boolean
}

export function applyQualityGate(
  results: RecallResult[],
  opts?: Partial<QualityGateOptions>,
): ApplyQualityGateResult {
  const cfg: QualityGateOptions = { ...DEFAULT_OPTS, ...opts }

  // Step 1 + 2: floor 过滤 + 同 source path dedupe
  const bestByPath = new Map<string, RecallHit>()
  const rejected: Array<{ hit: RecallHit; reason: RejectReason }> = []

  for (const r of results) {
    for (const hit of r.hits) {
      if (hit.score < cfg.scoreFloor) {
        rejected.push({ hit, reason: "below_floor" })
        continue
      }
      const prev = bestByPath.get(hit.path)
      if (!prev) {
        bestByPath.set(hit.path, hit)
        continue
      }
      // 保留最高分
      if (hit.score > prev.score) {
        rejected.push({ hit: prev, reason: "duplicate_source" })
        bestByPath.set(hit.path, hit)
      } else {
        rejected.push({ hit, reason: "duplicate_source" })
      }
    }
  }

  // Step 3 + 4: bucket by injectFloor + token cap
  // 范-r1 P2-1 修：token cap 触发时 hit 走单一状态——降级到 inspector，
  //   不再同时 push 到 rejected。budgetExceeded flag 统一 audit 写一条；
  //   下游需要找出"未注入的高置信"时按 (inspectorOnly 中 score >= injectFloor) 反查。
  //   rejected 只保留 below_floor + duplicate_source 两种"真丢弃"原因。
  const ordered = Array.from(bestByPath.values()).sort((a, b) => b.score - a.score)
  const injected: RecallHit[] = []
  const inspectorOnly: RecallHit[] = []
  let totalTokens = 0
  let budgetExceeded = false

  for (const hit of ordered) {
    if (hit.score < cfg.injectFloor) {
      inspectorOnly.push(hit)
      continue
    }
    const tok = cfg.estimateTokens(hit.excerpt)
    if (totalTokens + tok > cfg.totalTokenCap) {
      // 范-r1 P2-1: 单一状态降级，不重复进 rejected
      budgetExceeded = true
      inspectorOnly.push(hit)
      continue
    }
    injected.push(hit)
    totalTokens += tok
  }

  return {
    buckets: { injected, inspectorOnly, rejected },
    totalTokens,
    budgetExceeded,
  }
}
