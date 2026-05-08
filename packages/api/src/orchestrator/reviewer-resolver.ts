import type { Provider } from "@multi-agent/shared"

/**
 * Map a target role (as declared in a skill's `next_dispatch.target`) and the
 * source provider to a concrete provider for the forced dispatch.
 *
 * For the "reviewer" role we keep a fixed cross-provider mapping:
 *   claude → codex  (范德彪 reviews 黄仁勋's code)
 *   codex → claude  (黄仁勋 reviews 范德彪's code)
 *   gemini → codex  (桂芬 usually routes to 范德彪)
 *
 * Returns null when the target role is unknown.
 */
export function resolveReviewerProvider(sourceProvider: Provider, target: string): Provider | null {
  if (target !== "reviewer") return null
  switch (sourceProvider) {
    case "claude":
      return "codex"
    case "codex":
      return "claude"
    case "gemini":
      return "codex"
    default:
      return null
  }
}
