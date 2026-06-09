/**
 * F027 v3 G11 · Phase 2 LLM compile · 生产 CompileLLMClient 适配器
 *
 * 真相源：
 *   - docs/features/F027-unified-memory-architecture.md（compile-LLM = Opus 4.7）
 *   - types.ts:6 + types.ts:205 CompileLLMClient interface
 *   - haiku-runner.ts createOpusRunner / createHaikuRunner + runner-with-fallback.ts
 *
 * 职责：把一个 HaikuRunner（生产用 Opus 4.7 primary + Haiku 4.5 fallback 链）
 * 封装成 compile-pipeline 期望的 CompileLLMClient 接口：
 *   compile({systemPrompt, userMessage}) → runner.runPrompt(prompt) → parse + validate → LLMCompileOutput
 *
 * 错误语义（与 runCompilePipelineWithRetry 配套；该 wrapper 仅对 LLMCompileSchemaError 重试）：
 *   - runner !ok（timeout / empty-output / exit-code / spawn-error）→ 抛普通 Error
 *     此时 primary(Opus)+fallback(Haiku) 都已失败（runner-with-fallback 内部已 fallback 过），
 *     重试 schema 循环无意义 → 普通 Error 让 caller 包 CompilePipelineError("compile") 直接熔断。
 *   - malformed JSON（parseLLMCompileJSON 抛 SyntaxError）→ 包成 LLMCompileSchemaError
 *     （LLM 下次 attempt 可能吐合法 JSON）→ caller 重试。
 *   - shape 不符（validateLLMCompileOutput 抛 LLMCompileSchemaError）→ 原样抛 → caller 重试。
 */

import type { HaikuRunner } from "../../runtime/haiku-runner"
import { parseLLMCompileJSON, validateLLMCompileOutput } from "./schema-validator"
import { type CompileLLMClient, type LLMCompileOutput, LLMCompileSchemaError } from "./types"

export interface ProductionCompileLLMClientDeps {
  /** 生产用 createRunnerWithFallback({primary: createOpusRunner(), fallback: createHaikuRunner()})。 */
  runner: HaikuRunner
  /**
   * runner 超时（ms）。编译是重任务（长上下文 + 结构化抽取），默认 60s，
   * 远大于 haiku-runner DEFAULT_TIMEOUT_MS(15s)。
   */
  timeoutMs?: number
  /** 可选 log（trace 用；默认 noop）。 */
  logger?: (msg: string) => void
}

/** 编译 LLM 调用超时默认 60s（重任务，覆盖 runner 默认 15s）。 */
export const DEFAULT_COMPILE_TIMEOUT_MS = 60_000

export function createProductionCompileLLMClient(
  deps: ProductionCompileLLMClientDeps,
): CompileLLMClient {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS
  const log = deps.logger ?? (() => {})

  return {
    async compile(input): Promise<LLMCompileOutput> {
      // SYSTEM + USER 拼成单 prompt（claude --print 单轮）。
      // SYSTEM 在前提供 schema 合约，USER 数据块（已带 nonce sentinel 防注入）在后。
      const prompt = `${input.systemPrompt}\n\n${input.userMessage}`

      const result = await deps.runner.runPrompt(prompt, { timeoutMs })
      if (!result.ok) {
        // primary + fallback 都失败（runner-with-fallback 内部已尝试 fallback）。
        // 非 schema 错 → 不进重试循环 → caller 熔断。
        throw new Error(
          `compile LLM runner failed (primary+fallback): ${result.error ?? "unknown"}`,
        )
      }
      if (result.error === "fallback-haiku-success") {
        // AC-P4-8：primary(Opus) 失败降级 Haiku。编译仍产出，但质量可能降级 → log 供审计。
        log("compile LLM fell back to Haiku (Opus primary failed); output quality may be degraded")
      }

      let parsed: unknown
      try {
        parsed = parseLLMCompileJSON(result.text)
      } catch (err) {
        // malformed JSON 视为可重试 schema 错（下次 attempt 可能合法）。
        throw new LLMCompileSchemaError(
          "__json_parse__",
          `compile LLM returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      // shape 不符 → validateLLMCompileOutput 抛 LLMCompileSchemaError（caller 重试）。
      return validateLLMCompileOutput(parsed)
    },
  }
}
