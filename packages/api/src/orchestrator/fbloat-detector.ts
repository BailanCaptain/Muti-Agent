export type FBloatResult = {
  detected: boolean
  dropRatio: number
}

const BLOAT_DROP_THRESHOLD = 0.4

export function detectFBloat(prevUsedTokens: number, currentUsedTokens: number): FBloatResult {
  if (prevUsedTokens <= 0) return { detected: false, dropRatio: 0 }
  const drop = prevUsedTokens - currentUsedTokens
  if (drop <= 0) return { detected: false, dropRatio: 0 }
  const dropRatio = drop / prevUsedTokens
  return { detected: dropRatio > BLOAT_DROP_THRESHOLD, dropRatio }
}
