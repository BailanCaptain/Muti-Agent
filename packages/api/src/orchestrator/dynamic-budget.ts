export type DynamicLimits = {
  sharedHistoryLimit: number
  selfHistoryLimit: number
  maxContentLength: number
}

type Tier = { threshold: number; limits: DynamicLimits }

const TIERS: Tier[] = [
  { threshold: 0.3, limits: { sharedHistoryLimit: 60, selfHistoryLimit: 30, maxContentLength: 4000 } },
  { threshold: 0.5, limits: { sharedHistoryLimit: 40, selfHistoryLimit: 20, maxContentLength: 3000 } },
  { threshold: 0.7, limits: { sharedHistoryLimit: 30, selfHistoryLimit: 15, maxContentLength: 2000 } },
  { threshold: Infinity, limits: { sharedHistoryLimit: 15, selfHistoryLimit: 8, maxContentLength: 1000 } },
]

const DEFAULT_LIMITS: DynamicLimits = { sharedHistoryLimit: 30, selfHistoryLimit: 15, maxContentLength: 2000 }

export function computeDynamicLimits(fillRatio: number): DynamicLimits {
  if (Number.isNaN(fillRatio)) return DEFAULT_LIMITS
  for (const tier of TIERS) {
    if (fillRatio < tier.threshold) return tier.limits
  }
  return TIERS[TIERS.length - 1].limits
}
