import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { type AgentKind, MODEL_CATALOG } from "./model-catalog"

export type AgentOverride = {
  model?: string
  effort?: string
  contextWindow?: number
  sealPct?: number
}

export const SEAL_PCT_MIN = 0.3
export const SEAL_PCT_MAX = 1.0

/**
 * F027 收录设置 · wiki 编译引擎三家（claude / codex / gemini CLI，全订阅）。
 * 默认 claude + Opus 4.7（AC-P4-8 原链）；fallback 恒 claude Haiku 4.5 不可配。
 */
export const WIKI_COMPILE_PROVIDERS = ["claude", "codex", "gemini"] as const
export type WikiCompileProvider = (typeof WIKI_COMPILE_PROVIDERS)[number]
export const DEFAULT_WIKI_COMPILE_PROVIDER: WikiCompileProvider = "claude"

/**
 * claude 引擎的**建议**模型列表（前端 datalist 联想用）。
 * 小孙拍：模型 id 可自由输入（「新模型出了 你这里不更新的怎么办」）——本列表不再是白名单；
 * primaryModel 只做格式校验（非空/≤64/无控制字符），填错 id 由 CLI 失败 → 降级链兜底（log 可查）。
 */
export const WIKI_COMPILE_MODEL_IDS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
] as const
export const DEFAULT_WIKI_COMPILE_MODEL = "claude-opus-4-7"
/** primaryModel 自由字符串格式上限（防垃圾/注入；正常 model id 远短于此）。 */
export const WIKI_COMPILE_MODEL_MAX_LEN = 64

export type WikiCompileOverride = {
  /** 编译引擎；缺省 claude。 */
  provider?: WikiCompileProvider
  /** 模型 id 自由字符串；缺省/留空 = 该引擎默认（claude→Opus 4.7，codex/gemini→CLI 默认）。 */
  primaryModel?: string
  /**
   * 补丁#3（小孙「claude/codex 应该可选强度」）：推理强度，按 provider 的 efforts 白名单校验
   * （claude: low/medium/high/max；codex: none…xhigh；gemini 无强度 → 不可设）。留空 = CLI 默认。
   */
  effort?: string
}

/** entry 的有效 provider（合法则取之，否则默认 claude）——effort 白名单按它取。 */
function resolveWikiCompileProvider(provider: unknown): WikiCompileProvider {
  return typeof provider === "string" &&
    (WIKI_COMPILE_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as WikiCompileProvider)
    : DEFAULT_WIKI_COMPILE_PROVIDER
}

/**
 * primaryModel 格式校验（trim 后非空 + ≤64 + 保守字符集）。
 *
 * 字符集 `[A-Za-z0-9._:/-]`：覆盖三家真实 id 形态（claude-opus-4-7 / gpt-5.4-codex /
 * gemini-3-pro / o3 / org/model）。**收紧不是洁癖**：model id 会进 `spawn(..., {shell:true})`
 * 的 argv（-m <model>），cmd.exe 元字符（& | > ^ " 空格等）可构成命令注入——单一入口
 * （本校验 + sanitize 同口径）堵死，runner 层不接任何未过此闸的字符串。
 *
 * 首字符额外限定字母数字：`-` 开头的"模型 id"（如 `--yolo`）跟在 `-m` 后会被 CLI
 * parser 当 flag 解析（clap/yargs 行为各家不一，不赌单家语义）——真实 model id 全部
 * 字母数字开头，零功能代价杀死整类 flag 注入。
 */
const WIKI_COMPILE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
export function isValidWikiCompileModelId(v: string): boolean {
  const trimmed = v.trim()
  if (trimmed.length === 0 || trimmed.length > WIKI_COMPILE_MODEL_MAX_LEN) return false
  return WIKI_COMPILE_MODEL_ID_RE.test(trimmed)
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
  // F027 收录设置：wikiCompile 显式校验。provider 枚举三家；primaryModel 自由字符串只做
  // 格式校验（小孙拍：新模型可直接写 id，白名单只是前端建议列表——填错 id 由 CLI 失败降级兜底）。
  const wcRaw = source.wikiCompile
  if (wcRaw !== undefined) {
    if (!wcRaw || typeof wcRaw !== "object" || Array.isArray(wcRaw)) {
      errors.push("wikiCompile: override must be an object")
    } else {
      const entry = wcRaw as Record<string, unknown>
      if (
        entry.provider !== undefined &&
        (typeof entry.provider !== "string" ||
          !(WIKI_COMPILE_PROVIDERS as readonly string[]).includes(entry.provider))
      ) {
        errors.push(
          `wikiCompile.provider must be one of: ${WIKI_COMPILE_PROVIDERS.join(", ")}`,
        )
      }
      const pm = entry.primaryModel
      if (pm !== undefined && (typeof pm !== "string" || !isValidWikiCompileModelId(pm))) {
        errors.push(
          `wikiCompile.primaryModel must be a non-empty string (≤${WIKI_COMPILE_MODEL_MAX_LEN} chars, no control chars)`,
        )
      }
      // 补丁#3：effort 按 provider 的 efforts 白名单校验（gemini efforts=[] → 任何 effort 非法）。
      const eff = entry.effort
      if (eff !== undefined) {
        const provider = resolveWikiCompileProvider(entry.provider)
        const allowed = MODEL_CATALOG[provider].efforts
        if (typeof eff !== "string" || !allowed.includes(eff)) {
          errors.push(
            allowed.length === 0
              ? `wikiCompile.effort: ${provider} 不支持推理强度（请移除 effort）`
              : `wikiCompile.effort must be one of: ${allowed.join(", ")} (provider ${provider})`,
          )
        }
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
  // F027 收录设置：wikiCompile 存储层 sanitize（最后防线——历史脏文件/手改只留合法形态）
  const wcRaw = source.wikiCompile
  if (wcRaw && typeof wcRaw === "object" && !Array.isArray(wcRaw)) {
    const entry = wcRaw as Record<string, unknown>
    const wc: WikiCompileOverride = {}
    if (
      typeof entry.provider === "string" &&
      (WIKI_COMPILE_PROVIDERS as readonly string[]).includes(entry.provider)
    ) {
      wc.provider = entry.provider as WikiCompileProvider
    }
    if (typeof entry.primaryModel === "string" && isValidWikiCompileModelId(entry.primaryModel)) {
      wc.primaryModel = entry.primaryModel.trim()
    }
    // 补丁#3：effort 按（已 sanitize 的）provider 白名单留存；非法/越界静默丢弃。
    if (typeof entry.effort === "string") {
      const provider = wc.provider ?? DEFAULT_WIKI_COMPILE_PROVIDER
      if (MODEL_CATALOG[provider].efforts.includes(entry.effort)) {
        wc.effort = entry.effort
      }
    }
    if (
      wc.provider !== undefined ||
      wc.primaryModel !== undefined ||
      wc.effort !== undefined
    ) {
      result.wikiCompile = wc
    }
  }
  return result
}
