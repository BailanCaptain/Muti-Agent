import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { AgentKind } from "./model-catalog"

export type AgentOverride = {
  model?: string
  effort?: string
}

export type RuntimeConfig = Partial<Record<AgentKind, AgentOverride>>

const CONFIG_FILE_NAME = "multi-agent.runtime-config.json"
const AGENT_KINDS: AgentKind[] = ["claude", "codex", "gemini"]

/**
 * Resolve where the runtime config JSON lives on disk.
 * Env var MULTI_AGENT_RUNTIME_CONFIG_PATH wins; otherwise it sits at the project root
 * (process.cwd()), alongside multi-agent.sqlite. The file is user-preference state
 * and should be gitignored.
 */
export function resolveRuntimeConfigPath(): string {
  const fromEnv = process.env.MULTI_AGENT_RUNTIME_CONFIG_PATH
  if (fromEnv?.trim()) return fromEnv.trim()
  return path.join(process.cwd(), CONFIG_FILE_NAME)
}

export function loadRuntimeConfig(configPath: string = resolveRuntimeConfigPath()): RuntimeConfig {
  if (!existsSync(configPath)) return {}
  try {
    const raw = readFileSync(configPath, "utf8")
    return sanitize(JSON.parse(raw))
  } catch {
    // Corrupt file → treat as empty; UI will rewrite on next save.
    return {}
  }
}

export function saveRuntimeConfig(
  config: RuntimeConfig,
  configPath: string = resolveRuntimeConfigPath(),
): void {
  const sanitized = sanitize(config)
  const dir = path.dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(configPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8")
}

function sanitize(input: unknown): RuntimeConfig {
  if (!input || typeof input !== "object") return {}
  const source = input as Record<string, unknown>
  const result: RuntimeConfig = {}
  for (const agent of AGENT_KINDS) {
    const raw = source[agent]
    if (!raw || typeof raw !== "object") continue
    const entry = raw as Record<string, unknown>
    const override: AgentOverride = {}
    if (typeof entry.model === "string" && entry.model.trim()) {
      override.model = entry.model.trim()
    }
    if (typeof entry.effort === "string" && entry.effort.trim()) {
      override.effort = entry.effort.trim()
    }
    if (override.model || override.effort) {
      result[agent] = override
    }
  }
  return result
}
