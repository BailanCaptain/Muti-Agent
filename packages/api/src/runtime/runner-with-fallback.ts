/**
 * F027 Phase 4 AC-P4-8 (a) · Sonnet 4.6 + Haiku 4.5 fallback runner
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-8 (a)
 *     "critique LLM: new LlmCritiqueAgent({model: 'claude-sonnet-4-6'}) + Haiku 4.5 fallback
 *      (fallback 不等价 PASS, 记 BLOCKED)"
 *   - codex Week 5 j2 FAIL: production-recall-executor-deps.ts:69 only createSonnetRunner,
 *     无 Haiku fallback (FAIL spec_gate)
 *
 * Fallback 触发条件 (primary 失败 → Haiku retry):
 *   - timeout (HaikuRunResult.error = 'timeout')
 *   - rate-limit / quota (exit-code 含 'quota' / 'rate' / '429')
 *
 * 不触发 fallback (业务错, 不重试):
 *   - empty-output (model 返空)
 *   - exit-code 非 quota/rate (其他业务错)
 *   - spawn-error (CLI 不可用 — fallback 也跑不动)
 *
 * BLOCKED 语义 (caller 处理):
 *   - 当 primary fail + fallback 调用时, 在结果 metadata 里标 `fellBack=true`
 *   - caller (e.g. AC-P4-8 evidence pack) 看到 fellBack=true → 记 BLOCKED 不算 PASS
 *
 * 接口设计:
 *   - 返回的 HaikuRunner 跟原 runner 接口一致 (透明替换)
 *   - 额外信息通过 HaikuRunResult.error 字段编码:
 *     - "fallback-haiku-success" (primary fail, haiku 成功)
 *     - 其他原 error 保持不变
 */

import type { HaikuRunner, HaikuRunResult } from "./haiku-runner"

export interface RunnerWithFallbackOptions {
  primary: HaikuRunner
  fallback: HaikuRunner
  /** quota/rate 错误识别正则。默认覆盖 quota / rate / 429。 */
  shouldFallback?: (err: string | undefined) => boolean
}

export const DEFAULT_FALLBACK_PATTERNS = [
  /timeout/i,
  /quota/i,
  /rate.?limit/i,
  /429/,
]

export function defaultShouldFallback(err: string | undefined): boolean {
  if (!err) return false
  return DEFAULT_FALLBACK_PATTERNS.some((re) => re.test(err))
}

/**
 * createRunnerWithFallback — 包 primary runner, 失败时 fallback。
 *
 * Returns HaikuRunner. 输出 HaikuRunResult:
 *   - primary ok=true → 返 primary result
 *   - primary fail + shouldFallback → 跑 fallback:
 *     - fallback ok → 返 { ok: true, text, durationMs (primary+fallback), error: 'fallback-haiku-success' }
 *     - fallback fail → 返 { ok: false, text: '', durationMs (sum), error: 'primary-and-fallback-failed:<primary-err>|<fallback-err>' }
 *   - primary fail 但 !shouldFallback → 返 primary result (业务错不重试)
 */
export function createRunnerWithFallback(opts: RunnerWithFallbackOptions): HaikuRunner {
  const shouldFallback = opts.shouldFallback ?? defaultShouldFallback

  return {
    async runPrompt(prompt, runOpts) {
      const primaryResult = await opts.primary.runPrompt(prompt, runOpts)
      if (primaryResult.ok) return primaryResult

      if (!shouldFallback(primaryResult.error)) {
        return primaryResult
      }

      const fallbackResult = await opts.fallback.runPrompt(prompt, runOpts)
      const totalDuration = primaryResult.durationMs + fallbackResult.durationMs

      if (fallbackResult.ok) {
        return {
          ok: true,
          text: fallbackResult.text,
          durationMs: totalDuration,
          error: "fallback-haiku-success",
        }
      }

      return {
        ok: false,
        text: "",
        durationMs: totalDuration,
        error: `primary-and-fallback-failed:${primaryResult.error}|${fallbackResult.error}`,
      }
    },
  }
}

/** 判断结果是否走过 fallback (caller AC-P4-8 evidence 决定记 BLOCKED 不算 PASS)。 */
export function didFallback(result: HaikuRunResult): boolean {
  return result.ok && result.error === "fallback-haiku-success"
}
