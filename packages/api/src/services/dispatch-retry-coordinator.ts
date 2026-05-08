import type { DispatchValidationRetryReason } from "@multi-agent/shared"
import { type ProviderAliases, detectInvalidDispatch } from "../orchestrator/mention-router"

/**
 * F026 P3.1 Task4 · 派发协议 retry 决策状态机（纯函数）
 *
 * 输入：assistant final accumulatedContent + 当前 retryState
 * 输出：accept / retry / exhaust 三态决策
 *
 * 职责边界：
 *   - 只做"该不该 retry / 该不该兜底"的决策
 *   - 不动 DB / 不发事件 / 不 spawn CLI（这些由 message-service + claude-runtime 接力）
 *   - 与 detectInvalidDispatch 是 1:1 唯一调用方（避免重复判定逻辑漂移）
 */

export const MAX_DISPATCH_RETRIES_DEFAULT = 3 as const

export type DecideRetryInput = {
  content: string
  aliases: ProviderAliases
  /** 1-indexed: 第 N 次尝试（首次为 1） */
  attemptIndex: number
  /** 此前每次失败的 reason，按时间顺序 */
  priorReasons: ReadonlyArray<DispatchValidationRetryReason>
  /** 默认 MAX_DISPATCH_RETRIES_DEFAULT；env A2A_MAX_DISPATCH_RETRIES 可覆盖 */
  maxAttempts?: number
}

export type RetryDecision =
  | {
      action: "accept"
      retryCount: number
      retryReasons: DispatchValidationRetryReason[]
    }
  | {
      action: "retry"
      reason: DispatchValidationRetryReason
      nextAttemptIndex: number
      maxAttempts: number
      retryReasons: DispatchValidationRetryReason[]
    }
  | {
      action: "exhaust"
      reason: DispatchValidationRetryReason
      retryCount: number
      retryReasons: DispatchValidationRetryReason[]
    }

export function decideRetryAction(input: DecideRetryInput): RetryDecision {
  const max = input.maxAttempts ?? MAX_DISPATCH_RETRIES_DEFAULT
  const detect = detectInvalidDispatch(input.content, input.aliases)

  if (detect.ok) {
    return {
      action: "accept",
      retryCount: input.attemptIndex - 1,
      retryReasons: [...input.priorReasons],
    }
  }

  // 还有重试机会 → retry
  if (input.attemptIndex < max) {
    return {
      action: "retry",
      reason: detect.reason,
      nextAttemptIndex: input.attemptIndex + 1,
      maxAttempts: max,
      retryReasons: [...input.priorReasons, detect.reason],
    }
  }

  // attemptIndex >= max → 兜底
  return {
    action: "exhaust",
    reason: detect.reason,
    retryCount: input.attemptIndex,
    retryReasons: [...input.priorReasons, detect.reason],
  }
}

export type CorrectionPromptInput = {
  reason: DispatchValidationRetryReason
  originalText: string
  attemptIndex: number
  maxAttempts: number
}

const SAMPLE_LIMIT = 200

/**
 * 拼装喂给 CLI 的"再来一遍"系统消息。
 * 走 claude --resume <native_session> + stdin 传入。
 * 内容指明：哪一类格式错、合规写法、原文样本（让 LLM 看到自己写的什么）。
 *
 * 支持 reason：
 *   - nested_call_tag             : R-054 嵌套 [Call:]
 *   - naked_at_with_real_teammate : R-057 行首裸真实队友 @ 缺 [Call:] 包装
 */
export function buildCorrectionPrompt(input: CorrectionPromptInput): string {
  const sample = input.originalText.slice(0, SAMPLE_LIMIT)
  const header = `[系统] 上轮 final 派发格式不合契约(第 ${input.attemptIndex}/${input.maxAttempts} 次重写)。`

  if (input.reason === "naked_at_with_real_teammate") {
    return [
      header,
      "原因：行首裸 @队友名 —— 这种格式不会触发派发，链路会静默断（R-057 真根因）。",
      '请重写：把行首的 @队友名 改成 [Call: @队友名 任务描述] 单独成行；如果只是叙述/提及（不派发），把 @ 移到句中（如 "也帮过我"、"之前提到 @人名"）。',
      "你刚才写的（截断 200 字）：",
      sample,
    ].join("\n")
  }

  return [
    header,
    "原因：嵌套 [Call:] —— [Call: ...] 内部不允许再写 [Call:]，会同时让派发链失配 + 前端渲染露馅 [Call:] 字面量。",
    "请重写：合法格式 [Call: @人名 任务描述]，禁止嵌套。多人接力请用并列两条 [Call:] 而非嵌套。",
    "你刚才写的（截断 200 字）：",
    sample,
  ].join("\n")
}

/**
 * 读 env A2A_MAX_DISPATCH_RETRIES（可选；默认 MAX_DISPATCH_RETRIES_DEFAULT=3）。
 * Clamp [1, 5]：1 = 不重试只兜底（极端关闭），5 = 上限防 LLM 死循环抖动。
 */
export function resolveMaxDispatchRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.A2A_MAX_DISPATCH_RETRIES
  if (!raw) return MAX_DISPATCH_RETRIES_DEFAULT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return MAX_DISPATCH_RETRIES_DEFAULT
  return Math.min(5, Math.max(1, parsed))
}
