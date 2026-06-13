/**
 * F027 收录设置 · wiki 编译动态 runner（三引擎 + 自由模型 id）
 *
 * 真相源：docs/features/F027-unified-memory-architecture.md「收尾补丁 · 收录体验」
 *   + 小孙 2026-06-13 追加拍板：①「编译模型 我也要可以自己写 不然有时候新模型出了
 *   你这里不更新的怎么办」②「你这样写 我这样就只能用claude了」
 *
 * 职责：每次 runPrompt **动态**读 runtime config（收录设置卡改完即热生效，不重启）：
 *   - provider = wikiCompile.provider（claude / codex / gemini，默认 claude）
 *   - model = wikiCompile.primaryModel 自由字符串；留空 → 该引擎默认
 *     （claude→Opus 4.7；codex/gemini→不传 -m 用 CLI 自己的默认）
 *   - fallback 链恒 claude Haiku 4.5（跨引擎兜底）；primary 即 claude haiku 时直跑不自叠
 *   - 降级谓词：**任何 primary 失败都降级**（德彪 kb-ux2 r1 P1）——自由输入时代填错 id
 *     （exit-code 业务错）是最常见失败；跨引擎下 codex/gemini spawn-error ≠ claude 不可用。
 *     AC-P4-8 的 timeout/quota 谓词是 primary=fallback 同 CLI 时代的假设，不适用本链
 *     （judge/critique 等其他消费方保持 default 谓词不动）。schema 失败（CLI 成功但产出
 *     非法 JSON）仍走编译管道既有 3 重试 + stub——与原 claude 链同语义，非本层职责
 *   - 降级发生 → onFallback("<provider>:<model|default>") 审计
 *   - loadConfig 抛错 → 回落默认引擎+默认模型（编译主链不因配置文件损坏熔断）
 *   - runner 按 `${provider}:${model}` 缓存复用（runner 无状态，仅封装 spawn 参数）
 *
 * 成本口径：三家全是本机订阅 CLI（claude --print / codex exec / gemini -p），非计费 API。
 */

import { createClaudeModelRunner, type HaikuRunner } from "./haiku-runner"
import { createRunnerWithFallback } from "./runner-with-fallback"
import {
  DEFAULT_WIKI_COMPILE_MODEL,
  DEFAULT_WIKI_COMPILE_PROVIDER,
  loadRuntimeConfig,
  type RuntimeConfig,
  type WikiCompileProvider,
} from "./runtime-config"
import {
  createCodexPromptRunner,
  createGeminiPromptRunner,
} from "./wiki-compile-cli-runners"

const FALLBACK_MODEL = "claude-haiku-4-5"

export interface ResolvedWikiCompileTarget {
  provider: WikiCompileProvider
  /** undefined = 该引擎 CLI 默认模型（仅 codex/gemini；claude 恒有具体 id）。 */
  model: string | undefined
  /** 推理强度（补丁#3）；缺省/undefined = CLI 默认强度。gemini 恒无（无强度参数）。 */
  effort?: string
}

/**
 * config → {provider, model, effort}。claude 缺省模型补 Opus 4.7；codex/gemini 缺省 = CLI 默认。
 * effort 直接透传（已由 runtime-config 校验按 provider 白名单；gemini 恒无 effort）。
 */
export function resolveWikiCompileTarget(config: RuntimeConfig): ResolvedWikiCompileTarget {
  const provider = config.wikiCompile?.provider ?? DEFAULT_WIKI_COMPILE_PROVIDER
  const raw = config.wikiCompile?.primaryModel?.trim()
  const effort = config.wikiCompile?.effort?.trim() || undefined
  if (provider === "claude") {
    return { provider, model: raw || DEFAULT_WIKI_COMPILE_MODEL, effort }
  }
  return { provider, model: raw || undefined, effort }
}

/** 审计标签：`claude:claude-opus-4-7` / `codex:default` …（effort 不进标签，见 cacheKey）。 */
export function wikiCompileTargetLabel(t: ResolvedWikiCompileTarget): string {
  return `${t.provider}:${t.model ?? "default"}`
}

/** 缓存键 = 标签 + effort（effort 改变 spawn 参数，必须区分，否则热切强度命中旧 runner）。 */
function wikiCompileCacheKey(t: ResolvedWikiCompileTarget): string {
  return `${wikiCompileTargetLabel(t)}@${t.effort ?? "default"}`
}

export interface DynamicWikiCompileRunnerDeps {
  /** config 读取器（默认 loadRuntimeConfig — 每次调用现读盘，热生效）。 */
  loadConfig?: () => RuntimeConfig
  /**
   * runner 工厂注入（测试 stub 用）。生产默认按 provider 真构造：
   * claude→createClaudeModelRunner(model)；codex/gemini→各自 CLI prompt runner。
   */
  buildRunner?: (target: ResolvedWikiCompileTarget) => HaikuRunner
  /** 降级发生回调（带 `${provider}:${model|default}` 标签，caller 接审计 log）。 */
  onFallback?: (primaryLabel: string) => void
}

function defaultBuildRunner(target: ResolvedWikiCompileTarget): HaikuRunner {
  switch (target.provider) {
    case "claude":
      // 补丁#3：effort 透传（createClaudeModelRunner 第三参 → --effort）
      return createClaudeModelRunner(target.model ?? DEFAULT_WIKI_COMPILE_MODEL, {}, target.effort)
    case "codex":
      return createCodexPromptRunner({ model: target.model, effort: target.effort })
    case "gemini":
      // gemini 无强度（runtime-config 已拒 gemini+effort）——不传
      return createGeminiPromptRunner({ model: target.model })
  }
}

export function createDynamicWikiCompileRunner(
  deps: DynamicWikiCompileRunnerDeps = {},
): HaikuRunner {
  const loadConfig = deps.loadConfig ?? (() => loadRuntimeConfig())
  const buildRunner = deps.buildRunner ?? defaultBuildRunner
  // runner 无状态（只封装 spawn 参数）→ 按 label 缓存复用，自由 id 也不会泄漏增长
  //（同一时刻配置只有一个值；切换累计的条目数 = 用户试过的组合数，天花板极低）
  const cache = new Map<string, HaikuRunner>()
  const getRunner = (target: ResolvedWikiCompileTarget): HaikuRunner => {
    // 补丁#3：缓存键含 effort（effort 改 spawn 参数；只按 label 缓存会让热切强度命中旧 runner）
    const key = wikiCompileCacheKey(target)
    const hit = cache.get(key)
    if (hit) return hit
    const built = buildRunner(target)
    cache.set(key, built)
    return built
  }
  const fallbackTarget: ResolvedWikiCompileTarget = {
    provider: "claude",
    model: FALLBACK_MODEL,
    effort: undefined,
  }

  return {
    async runPrompt(prompt, opts) {
      let target: ResolvedWikiCompileTarget
      try {
        target = resolveWikiCompileTarget(loadConfig())
      } catch {
        target = {
          provider: DEFAULT_WIKI_COMPILE_PROVIDER,
          model: DEFAULT_WIKI_COMPILE_MODEL,
          effort: undefined,
        }
      }
      const primary = getRunner(target)

      // primary 即兜底模型（claude haiku）→ 直跑一次；失败原样返回（不自叠 fallback 双跑）
      if (target.provider === "claude" && target.model === FALLBACK_MODEL) {
        return primary.runPrompt(prompt, opts)
      }

      const chained = createRunnerWithFallback({
        primary,
        fallback: getRunner(fallbackTarget),
        // 任何 primary 失败都降级（含 exit-code 业务错 / spawn-error）：卡片承诺
        // 「失败自动降级 Haiku」，且 fallback 是另一家 CLI，primary 挂不代表它挂
        shouldFallback: () => true,
      })
      const result = await chained.runPrompt(prompt, opts)
      if (result.ok && result.error === "fallback-haiku-success") {
        deps.onFallback?.(wikiCompileTargetLabel(target))
      }
      return result
    },
  }
}
