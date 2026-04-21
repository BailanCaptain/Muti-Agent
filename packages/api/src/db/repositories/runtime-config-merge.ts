// F021 P1 (范德彪 二轮 review): pending -> active flush 必须在 provider 内按字段合并，
// 不能 provider 级浅覆盖 —— 否则 pending 只含单字段时会把 active 另一字段吞掉。
export function mergeRuntimeConfigFieldwise(
  active: Record<string, unknown>,
  pending: Record<string, unknown>,
): Record<string, unknown> {
  const providers = new Set<string>([
    ...Object.keys(active ?? {}),
    ...Object.keys(pending ?? {}),
  ])
  const merged: Record<string, unknown> = {}
  for (const provider of providers) {
    const activeEntry = isPlainObject(active?.[provider]) ? active[provider] : {}
    const pendingEntry = isPlainObject(pending?.[provider]) ? pending[provider] : {}
    const combined = { ...activeEntry, ...pendingEntry }
    if (Object.keys(combined).length > 0) merged[provider] = combined
  }
  return merged
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}
