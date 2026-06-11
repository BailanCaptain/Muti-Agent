/**
 * F027 收尾补丁 AC-W1 · wiki 编译动态 runner
 *
 * 真相源：docs/features/F027-unified-memory-architecture.md「收尾补丁 · 收录体验」AC-W1
 *
 * 背景：编译链原在 server.ts boot 时固定 createRunnerWithFallback({primary: Opus 4.7,
 * fallback: Haiku 4.5})（AC-P4-8），primary 改不了——小孙原话「订阅编译的模型 我前端不能选」。
 *
 * 职责：每次 runPrompt **动态**读 runtime config 取 primary 模型（前端全局默认 tab 改完即热
 * 生效，不重启），fallback 链固定 Haiku 4.5 不变：
 *   - primary = wikiCompile.primaryModel（白名单 4 模型，默认 Opus 4.7）
 *   - primary 本身是 Haiku → 直跑（不自叠 fallback：同模型失败重跑无意义且双倍延迟）
 *   - 降级发生 → onFallback(真实 primary 模型名)，替换原硬编码 "Opus primary failed" 审计文案
 *   - loadConfig 抛错 → 回落默认模型（编译主链不因配置文件损坏熔断）
 *
 * 成本口径：4 个 runner 全是本机 `claude --print --model <id>` CLI（小孙订阅），非计费 API。
 */

import {
  createHaikuRunner,
  createOpus46Runner,
  createOpusRunner,
  createSonnetRunner,
  type HaikuRunner,
} from "./haiku-runner"
import { createRunnerWithFallback } from "./runner-with-fallback"
import {
  DEFAULT_WIKI_COMPILE_MODEL,
  loadRuntimeConfig,
  type RuntimeConfig,
  type WikiCompileModelId,
} from "./runtime-config"

const FALLBACK_MODEL: WikiCompileModelId = "claude-haiku-4-5"

/** config → primary 模型（sanitize 已保证白名单内；缺省 → Opus 4.7）。 */
export function resolveWikiCompileModel(config: RuntimeConfig): WikiCompileModelId {
  return config.wikiCompile?.primaryModel ?? DEFAULT_WIKI_COMPILE_MODEL
}

export interface DynamicWikiCompileRunnerDeps {
  /** config 读取器（默认 loadRuntimeConfig — 每次调用现读盘，热生效）。 */
  loadConfig?: () => RuntimeConfig
  /** runner 注入（测试 stub 用；默认 4 个真 CLI runner，boot 时构造一次复用）。 */
  runnersById?: Record<WikiCompileModelId, HaikuRunner>
  /** 降级发生回调（带真实 primary 模型名，caller 接审计 log）。 */
  onFallback?: (primaryModel: WikiCompileModelId) => void
}

export function createDynamicWikiCompileRunner(
  deps: DynamicWikiCompileRunnerDeps = {},
): HaikuRunner {
  const loadConfig = deps.loadConfig ?? (() => loadRuntimeConfig())
  const runners: Record<WikiCompileModelId, HaikuRunner> = deps.runnersById ?? {
    "claude-opus-4-7": createOpusRunner(),
    "claude-sonnet-4-6": createSonnetRunner(),
    "claude-opus-4-6": createOpus46Runner(),
    "claude-haiku-4-5": createHaikuRunner(),
  }

  return {
    async runPrompt(prompt, opts) {
      let model: WikiCompileModelId
      try {
        model = resolveWikiCompileModel(loadConfig())
      } catch {
        model = DEFAULT_WIKI_COMPILE_MODEL
      }
      const primary = runners[model]

      // primary 即兜底模型 → 直跑一次；失败原样返回（不自叠 fallback 双跑）
      if (model === FALLBACK_MODEL) {
        return primary.runPrompt(prompt, opts)
      }

      const chained = createRunnerWithFallback({
        primary,
        fallback: runners[FALLBACK_MODEL],
      })
      const result = await chained.runPrompt(prompt, opts)
      if (result.ok && result.error === "fallback-haiku-success") {
        deps.onFallback?.(model)
      }
      return result
    },
  }
}
