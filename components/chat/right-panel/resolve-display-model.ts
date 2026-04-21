import type { Provider } from "@multi-agent/shared"
import type { RuntimeConfig, SessionRuntimeConfig } from "@/components/stores/runtime-config-store"

export function resolveDisplayModel(
  provider: Provider,
  sessionConfig: SessionRuntimeConfig,
  globalConfig: RuntimeConfig,
  fallback: string | null,
): string | null {
  return (
    sessionConfig[provider]?.model ??
    globalConfig[provider]?.model ??
    fallback
  )
}
