import type {
  HaikuRunOptions,
  HaikuRunResult,
  HaikuRunner,
} from "../../runtime/haiku-runner"
import { createClaudeModelRunner } from "../../runtime/haiku-runner"
import { createCodexPromptRunner } from "../../runtime/wiki-compile-cli-runners"
import {
  DIGEST_DEFAULT_FALLBACK_MODEL,
  DIGEST_DEFAULT_PRIMARY_MODEL,
  isDigestClaudeModelId,
} from "./digest-settings"

export interface DigestModelTarget {
  provider: "claude" | "codex"
  model: string
  effort?: string
}

/**
 * 顺序 fallback 与编辑独立复核共用同一组受控 target。
 * `runTargetPrompt` 只接受服务端构建的下标，调用方不能临时伪造 provider/model。
 */
export interface DigestModelRunner extends HaikuRunner {
  readonly targets: readonly Readonly<DigestModelTarget>[]
  runTargetPrompt(
    targetIndex: number,
    prompt: string,
    options?: HaikuRunOptions,
  ): Promise<HaikuRunResult>
}

export interface RunValidatedStageOptions<T> {
  runner: Pick<DigestModelRunner, "targets" | "runTargetPrompt">
  stageName: string
  buildPrompt: (context: {
    target: Readonly<DigestModelTarget>
    targetIndex: number
  }) => string
  validate: (
    text: string,
    context: { target: Readonly<DigestModelTarget>; targetIndex: number },
  ) => T | null
  /** 缺省按服务端配置顺序，每个 target 最多一次；重复下标会被去重。 */
  targetIndices?: readonly number[]
  runOptions?: HaikuRunOptions
  log?: (message: string) => void
}

export interface ValidatedStageAttempt {
  target: Readonly<DigestModelTarget>
  targetIndex: number
  status: "runner_failed" | "invalid_output" | "valid" | "aborted"
  durationMs: number
  error?: string
}

export type ValidatedStageResult<T> =
  | {
      ok: true
      value: T
      target: Readonly<DigestModelTarget>
      targetIndex: number
      durationMs: number
      attempts: ValidatedStageAttempt[]
    }
  | {
      ok: false
      durationMs: number
      error: "aborted" | "no-valid-digest-model-output"
      attempts: ValidatedStageAttempt[]
    }

/**
 * provider 成功不等于阶段成功：只有结构 parser 也通过才短路。
 * 结构无效只前进到下一个不同 target，不回头重跑 primary，也不把原始响应写入日志。
 */
export async function runValidatedStage<T>(
  options: RunValidatedStageOptions<T>,
): Promise<ValidatedStageResult<T>> {
  const requested =
    options.targetIndices ?? options.runner.targets.map((_target, index) => index)
  const targetIndices = [...new Set(requested)]
  let durationMs = 0
  const attempts: ValidatedStageAttempt[] = []

  for (const targetIndex of targetIndices) {
    const target = options.runner.targets[targetIndex]
    if (!target) continue
    const context = { target, targetIndex }
    const current = await options.runner.runTargetPrompt(
      targetIndex,
      options.buildPrompt(context),
      options.runOptions,
    )
    durationMs += current.durationMs
    if (!current.ok) {
      if (current.error === "aborted" || options.runOptions?.signal?.aborted) {
        attempts.push({
          target,
          targetIndex,
          status: "aborted",
          durationMs: current.durationMs,
          error: "aborted",
        })
        return { ok: false, durationMs, error: "aborted", attempts }
      }
      const safeError = toSafeDigestModelError(current.error)
      // CLI 正常退出却没有 stdout，证明的是输出合同失败，不是 provider/transport
      // unavailable。若把它记成 runner_failed，两个 Claude 空输出会错误开启同 Codex 双票降级。
      const status = safeError === "empty-output" ? "invalid_output" : "runner_failed"
      attempts.push({
        target,
        targetIndex,
        status,
        durationMs: current.durationMs,
        ...(current.error ? { error: safeError } : {}),
      })
      if (status === "invalid_output") {
        options.log?.(
          `[daily-digest] ${options.stageName} invalid structured output ${targetKey(target)}`,
        )
      }
      continue
    }

    let value: T | null = null
    try {
      value = options.validate(current.text, context)
    } catch {
      value = null
    }
    if (value !== null) {
      attempts.push({
        target,
        targetIndex,
        status: "valid",
        durationMs: current.durationMs,
      })
      return { ok: true, value, target, targetIndex, durationMs, attempts }
    }
    attempts.push({
      target,
      targetIndex,
      status: "invalid_output",
      durationMs: current.durationMs,
    })
    options.log?.(
      `[daily-digest] ${options.stageName} invalid structured output ${targetKey(target)}`,
    )
  }

  return { ok: false, durationMs, error: "no-valid-digest-model-output", attempts }
}

export const DIGEST_EMERGENCY_FALLBACK = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
} as const satisfies DigestModelTarget

/**
 * 日报所有 Claude 腿的统一极宽保险丝；摘要、深读、翻译和播客提炼共用。
 * 这不是性能 SLA：正常慢响应继续等待，只有单次调用连续 6h 未结束才视为挂死。
 */
export const DIGEST_CLAUDE_TIMEOUT_MS = 6 * 60 * 60_000

/**
 * B031：`gpt-5.6-sol/high` 高强度推理可能明显慢于 Claude。
 * 最终 Codex 层给 12h 下限；调用方更宽时原样保留，AbortSignal 始终优先。
 */
export const DIGEST_CODEX_TIMEOUT_MS = 12 * 60 * 60_000

/**
 * provider CLI 的 stderr 可能包含服务端正文、URL，甚至回显输入片段。日报日志和上层
 * 聚合错误只允许保留可操作的闭集分类；原始错误仍只在 runner 内用于当次控制流判断。
 */
export function toSafeDigestModelError(error: string | undefined): string {
  const normalized = error?.trim() ?? ""
  if (!normalized) return "unknown"
  if (/^aborted$/i.test(normalized)) return "aborted"
  if (/^timeout$/i.test(normalized)) return "timeout"
  if (/^empty-output(?:\s|$)/i.test(normalized)) return "empty-output"
  if (/^spawn-error:/i.test(normalized)) return "spawn-error"
  if (/^all-digest-models-failed:/i.test(normalized)) return "all-digest-models-failed"
  const exitCode = normalized.match(/^exit-code-(-?\d+)/i)?.[1]
  if (exitCode) {
    return /(?:quota|rate.?limit|\b429\b)/i.test(normalized)
      ? `exit-code-${exitCode}:quota-or-rate-limit`
      : `exit-code-${exitCode}`
  }
  if (/(?:quota|rate.?limit|\b429\b)/i.test(normalized)) return "quota-or-rate-limit"
  return "provider-error"
}

interface CodexRunnerOptions {
  model: string
  effort: string
}

export interface CreateDigestModelRunnerOptions {
  primaryModel: string
  fallbackModel: string
  log?: (message: string) => void
  /** 测试注入；生产缺省走现有 Claude CLI。 */
  createClaudeRunner?: (model: string) => HaikuRunner
  /** 测试注入；生产缺省走 Codex CLI，model/effort 由固定目标下发。 */
  createCodexRunner?: (opts: CodexRunnerOptions) => HaikuRunner
}

function targetKey(target: DigestModelTarget): string {
  return `${target.provider}:${target.model}:${target.effort ?? ""}`
}

function configuredClaudeTarget(model: string, fallback: string): DigestModelTarget {
  const normalized = model.trim()
  // API 与存储层会拒绝非 Claude；这里仍对历史手改/直接调用做 fail-safe，恢复默认 Claude
  // 拓扑，绝不能让固定 Codex slug 折叠掉前两层。
  return { provider: "claude", model: isDigestClaudeModelId(normalized) ? normalized : fallback }
}

/**
 * 有序目标 = 可配置 Claude 主力、可配置 Claude 备用、固定跨 provider 终极兜底。
 * provider/model/effort 三元组去重，避免相同配置重复扣额度。
 */
export function buildDigestModelTargets(
  primaryModel: string,
  fallbackModel: string,
): DigestModelTarget[] {
  const candidates = [
    configuredClaudeTarget(primaryModel, DIGEST_DEFAULT_PRIMARY_MODEL),
    configuredClaudeTarget(fallbackModel, DIGEST_DEFAULT_FALLBACK_MODEL),
    DIGEST_EMERGENCY_FALLBACK,
  ]
  const seen = new Set<string>()
  return candidates.filter((target) => {
    const key = targetKey(target)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * F037/B030 专用顺序 runner。任何失败才进入下一层；成功短路；abort fail-closed 停链。
 * 这里不复用两层 `createRunnerWithFallback`，避免嵌套后把 Codex 成功误标成 Haiku fallback。
 */
export function createDigestModelRunner(options: CreateDigestModelRunnerOptions): DigestModelRunner {
  const createClaude = options.createClaudeRunner ?? ((model) => createClaudeModelRunner(model))
  const createCodex =
    options.createCodexRunner ??
    ((opts) => createCodexPromptRunner({ model: opts.model, effort: opts.effort }))
  const targets = buildDigestModelTargets(options.primaryModel, options.fallbackModel)
  const chain = targets.map((target) => ({
    target,
    runner:
      target.provider === "codex"
        ? createCodex({ model: target.model, effort: target.effort ?? "high" })
        : createClaude(target.model),
  }))

  const exposedTargets = Object.freeze(
    targets.map((target) => Object.freeze({ ...target })),
  ) satisfies readonly Readonly<DigestModelTarget>[]

  async function runTargetPrompt(
    targetIndex: number,
    prompt: string,
    runOptions?: HaikuRunOptions,
  ): Promise<HaikuRunResult> {
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= chain.length) {
      return {
        ok: false,
        text: "",
        durationMs: 0,
        error: "invalid-digest-model-target",
      }
    }
    if (runOptions?.signal?.aborted) {
      return { ok: false, text: "", durationMs: 0, error: "aborted" }
    }

    const { runner, target } = chain[targetIndex]
    const minimumTimeoutMs =
      target.provider === "codex" ? DIGEST_CODEX_TIMEOUT_MS : DIGEST_CLAUDE_TIMEOUT_MS
    const targetOptions = {
      ...(runOptions ?? {}),
      timeoutMs: Math.max(runOptions?.timeoutMs ?? 0, minimumTimeoutMs),
    }
    const current = await runner.runPrompt(prompt, targetOptions)
    if (current.ok) return current
    if (current.error === "aborted" || runOptions?.signal?.aborted) {
      return { ok: false, text: "", durationMs: current.durationMs, error: "aborted" }
    }

    const safeError = toSafeDigestModelError(current.error)
    options.log?.(`[daily-digest] model target failed ${targetKey(target)}: ${safeError}`)
    return {
      ok: false,
      text: "",
      durationMs: current.durationMs,
      error: safeError,
    }
  }

  const digestRunner: DigestModelRunner = {
    targets: exposedTargets,
    runTargetPrompt,
    async runPrompt(prompt, runOptions) {
      let durationMs = 0
      const failures: string[] = []

      for (let index = 0; index < chain.length; index++) {
        if (runOptions?.signal?.aborted) {
          return { ok: false, text: "", durationMs, error: "aborted" }
        }
        const { target } = chain[index]
        const current = await runTargetPrompt(index, prompt, runOptions)
        durationMs += current.durationMs
        if (current.ok) {
          if (index === 0) return current
          options.log?.(`[daily-digest] model fallback success ${targetKey(target)}`)
          return {
            ok: true,
            text: current.text,
            durationMs,
            error: `fallback-success:${targetKey(target)}`,
          }
        }
        if (current.error === "aborted" || runOptions?.signal?.aborted) {
          return { ok: false, text: "", durationMs, error: "aborted" }
        }
        failures.push(`${targetKey(target)}=${toSafeDigestModelError(current.error)}`)
      }

      const failed: HaikuRunResult = {
        ok: false,
        text: "",
        durationMs,
        error: `all-digest-models-failed:${failures.join("|")}`,
      }
      return failed
    },
  }
  return digestRunner
}
