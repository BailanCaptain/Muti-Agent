/**
 * F026 · Long-output payload token cap (assistant 完整输出回流场景)。
 *
 *   A2A_PAYLOAD_MAX_TOKENS = <int>  → buildReturnPathPayload 的 token 预算（chars = tokens × 4）
 *   默认 16384（spec Design Decision：仍在 LLM 强注意力区间）
 *   越界（< 4096 或 > 65536，或非数字）fallback 到默认 + 启动日志告警
 *   每次调用读 env（runtime hot-reload，沿用 R-198 hot-reload 通道）
 */
export const A2A_PAYLOAD_MAX_TOKENS_ENV = "A2A_PAYLOAD_MAX_TOKENS"
export const A2A_PAYLOAD_MAX_TOKENS_DEFAULT = 16384
export const A2A_PAYLOAD_MAX_TOKENS_MIN = 4096
export const A2A_PAYLOAD_MAX_TOKENS_MAX = 65536

const warnedValues = new Set<string>()

export function getA2APayloadMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[A2A_PAYLOAD_MAX_TOKENS_ENV]
  if (raw === undefined || raw === "") return A2A_PAYLOAD_MAX_TOKENS_DEFAULT
  const n = Number(raw)
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < A2A_PAYLOAD_MAX_TOKENS_MIN ||
    n > A2A_PAYLOAD_MAX_TOKENS_MAX
  ) {
    if (!warnedValues.has(raw)) {
      warnedValues.add(raw)
      console.warn(
        `[F026 P3] A2A_PAYLOAD_MAX_TOKENS=${raw} 越界 [${A2A_PAYLOAD_MAX_TOKENS_MIN}, ${A2A_PAYLOAD_MAX_TOKENS_MAX}]，fallback 到默认 ${A2A_PAYLOAD_MAX_TOKENS_DEFAULT}`,
      )
    }
    return A2A_PAYLOAD_MAX_TOKENS_DEFAULT
  }
  return n
}
