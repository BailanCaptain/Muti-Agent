import type { Provider } from "@multi-agent/shared"
import { getContextWindowForModel } from "@multi-agent/shared"
import type { RuntimeConfig } from "./runtime-config"

/**
 * F021 Phase 6: 上下文窗口三层取值。
 *   session.contextWindow → global.contextWindow → CLI reported → getContextWindowForModel(model)
 *
 * user override > CLI 报告：用户在齿轮里调"最大窗口=2M"是明确意图（"模型升级了"），
 * 不应该被 CLI 自报盖掉（CLI 映射可能落后于实际）。
 */
export function resolveContextWindow(
  provider: Provider,
  globalConfig: RuntimeConfig | undefined,
  sessionConfig: RuntimeConfig | undefined,
  cliReportedWindow: number | null | undefined,
  model: string | null | undefined,
): number | null {
  const sessionWin = sessionConfig?.[provider]?.contextWindow
  const globalWin = globalConfig?.[provider]?.contextWindow
  return (
    sessionWin ??
    globalWin ??
    cliReportedWindow ??
    getContextWindowForModel(model)
  )
}
