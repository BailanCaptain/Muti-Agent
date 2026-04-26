import type { Provider } from "@multi-agent/shared"
import { SEAL_THRESHOLDS_BY_PROVIDER } from "@multi-agent/shared"
import type { RuntimeConfig } from "./runtime-config"

export type ResolvedSealThresholds = { warn: number; action: number }

/**
 * F021 Phase 6: 用户在齿轮里只暴露一个数字「Seal 阈值」(= action%)。
 * warn 自动派生 = action - WARN_GAP_FROM_ACTION，避免心智过载。
 *
 * 注意：fallback 路径（用户没设任何 override）保留 SEAL_THRESHOLDS_BY_PROVIDER 原表的 warn/action，
 * 不强制 warn = action - 0.05 —— 否则会改变现有 seal 行为。
 */
export const WARN_GAP_FROM_ACTION = 0.05

export function resolveSealThresholds(
  provider: Provider,
  globalConfig: RuntimeConfig | undefined,
  sessionConfig: RuntimeConfig | undefined,
): ResolvedSealThresholds {
  const sessionPct = sessionConfig?.[provider]?.sealPct
  const globalPct = globalConfig?.[provider]?.sealPct
  const overrideAction = sessionPct ?? globalPct
  if (overrideAction !== undefined) {
    const action = overrideAction
    const warn = Math.max(0, action - WARN_GAP_FROM_ACTION)
    return { warn, action }
  }
  return SEAL_THRESHOLDS_BY_PROVIDER[provider]
}
