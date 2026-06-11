import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { AgentKind } from "./model-catalog"

export type AgentOverride = {
  model?: string
  effort?: string
  contextWindow?: number
  sealPct?: number
}

export const SEAL_PCT_MIN = 0.3
export const SEAL_PCT_MAX = 1.0

/**
 * F027 收尾补丁 AC-W1 · wiki 编译模型白名单 = haiku-runner 既有 4 个 CLI runner。
 * 默认 Opus 4.7（AC-P4-8 原硬编码链的 primary）；fallback 恒 Haiku 4.5 不可配。
 */
export const WIKI_COMPILE_MODEL_IDS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
] as const
export type WikiCompileModelId = (typeof WIKI_COMPILE_MODEL_IDS)[number]
export const DEFAULT_WIKI_COMPILE_MODEL: WikiCompileModelId = "claude-opus-4-7"

export type WikiCompileOverride = {
  primaryModel?: WikiCompileModelId
}

/** 仅 agent 维度的 overrides（session 快照 / invocation configSnapshot 用——不含 wikiCompile）。 */
export type AgentOverridesConfig = Partial<Record<AgentKind, AgentOverride>>

export type RuntimeConfig = AgentOverridesConfig & {
  /** F027 收尾补丁 AC-W1 · wiki ingest 编译 LLM 配置（前端全局默认 tab 可改，热生效）。 */
  wikiCompile?: WikiCompileOverride
}

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

/**
 * F021: merge session override over global override at field granularity.
 *
 * Session and global each own `model` and `effort` independently. A session
 * snapshot that only sets `effort` must still inherit `model` from global
 * (and vice versa) — object-level `??` would drop the sibling field.
 *
 * Returns undefined when no field on either side is set, so callers can
 * fall back to `thread.currentModel` etc.
 */
export function resolveEffectiveOverride(
  session: AgentOverride | undefined,
  global: AgentOverride | undefined,
): AgentOverride | undefined {
  const model = session?.model ?? global?.model
  const effort = session?.effort ?? global?.effort
  if (!model && !effort) return undefined
  const result: AgentOverride = {}
  if (model) result.model = model
  if (effort) result.effort = effort
  return result
}

/**
 * F021 Phase 6 — AC-29: PUT 路由调用，把"sanitize 静默丢弃"升级为"显式 reject HTTP 400"。
 * sanitize 仍保留作为存储层的最后防线（防止历史脏数据/手改文件）；validate 是 API 入口的明确边界。
 *
 * 不校验 input 必须是 plain object — 路由层已做 isPlainObject 检查并返回 400。
 * 这里只关心 agent 层的字段值合法性。
 */
export function validateRuntimeConfigInput(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["config must be a plain object."]
  }
  const errors: string[] = []
  const source = input as Record<string, unknown>
  for (const agent of AGENT_KINDS) {
    const raw = source[agent]
    if (raw === undefined) continue
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${agent}: override must be an object`)
      continue
    }
    const entry = raw as Record<string, unknown>
    // 注意：model / effort 仍走 sanitize 静默 drop（历史行为，前端 model 选择器
    // 永远发合法值；改成 400 是 scope 外）。这里只校验 P6 新加的两字段。
    if (entry.contextWindow !== undefined) {
      const value = entry.contextWindow
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value <= 0
      ) {
        errors.push(`${agent}.contextWindow must be a positive integer (tokens)`)
      }
    }
    if (entry.sealPct !== undefined) {
      const value = entry.sealPct
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < SEAL_PCT_MIN ||
        value > SEAL_PCT_MAX
      ) {
        errors.push(`${agent}.sealPct must be a number in [${SEAL_PCT_MIN}, ${SEAL_PCT_MAX}]`)
      }
    }
  }
  // F027 收尾补丁 AC-W1：wikiCompile 显式校验（白名单外 → 400，不静默丢——
  // 前端下拉永远发合法值，400 只挡手搓 payload / 版本漂移）。
  const wcRaw = source.wikiCompile
  if (wcRaw !== undefined) {
    if (!wcRaw || typeof wcRaw !== "object" || Array.isArray(wcRaw)) {
      errors.push("wikiCompile: override must be an object")
    } else {
      const pm = (wcRaw as Record<string, unknown>).primaryModel
      if (
        pm !== undefined &&
        (typeof pm !== "string" || !(WIKI_COMPILE_MODEL_IDS as readonly string[]).includes(pm))
      ) {
        errors.push(
          `wikiCompile.primaryModel must be one of: ${WIKI_COMPILE_MODEL_IDS.join(", ")}`,
        )
      }
    }
  }
  return errors
}

/**
 * 德彪 wiki-ux r1 P2 · session 层校验：agent 字段同全局规则，但 **wikiCompile 是全局专属段**
 * （PUT /api/runtime-config 才收）——session config / pending 出现即 400。否则 session 路由
 * 复用全局 validator 会把 wikiCompile 放进 session 存储，flushSessionPending 再带进
 * invocation configSnapshot（类型断言不做运行时剥离）。
 */
export function validateSessionRuntimeConfigInput(input: unknown): string[] {
  const errors = validateRuntimeConfigInput(input)
  if (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    "wikiCompile" in (input as Record<string, unknown>)
  ) {
    errors.push(
      "wikiCompile is global-only (PUT /api/runtime-config); session config must not include it",
    )
  }
  return errors
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
    if (
      typeof entry.contextWindow === "number" &&
      Number.isFinite(entry.contextWindow) &&
      entry.contextWindow > 0
    ) {
      override.contextWindow = Math.floor(entry.contextWindow)
    }
    if (
      typeof entry.sealPct === "number" &&
      Number.isFinite(entry.sealPct) &&
      entry.sealPct >= SEAL_PCT_MIN &&
      entry.sealPct <= SEAL_PCT_MAX
    ) {
      override.sealPct = entry.sealPct
    }
    if (
      override.model ||
      override.effort ||
      override.contextWindow !== undefined ||
      override.sealPct !== undefined
    ) {
      result[agent] = override
    }
  }
  // F027 收尾补丁 AC-W1：wikiCompile 存储层 sanitize（最后防线——历史脏文件/手改只留白名单值）
  const wcRaw = source.wikiCompile
  if (wcRaw && typeof wcRaw === "object" && !Array.isArray(wcRaw)) {
    const pm = (wcRaw as Record<string, unknown>).primaryModel
    if (
      typeof pm === "string" &&
      (WIKI_COMPILE_MODEL_IDS as readonly string[]).includes(pm.trim())
    ) {
      result.wikiCompile = { primaryModel: pm.trim() as WikiCompileModelId }
    }
  }
  return result
}
