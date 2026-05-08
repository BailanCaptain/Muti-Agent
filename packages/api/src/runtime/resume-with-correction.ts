import type { AgentRunInput } from "./base-runtime"

/**
 * F026 P3.1 Task5 · 派发协议 retry — 构造 resume + correction 的 AgentRunInput
 *
 * 走法：claude --resume <native_session_id> + 新 user message (correction prompt) via stdin
 *
 * 设计：
 *   - 不新开 BaseCliRuntime 子类、不动 buildCommand —— 现成 ClaudeRuntime 已支持 env 驱动 --resume
 *   - 单一职责：构造一个 AgentRunInput；spawn 由 claudeRuntime.run() 接管
 *   - Immutable：不修改入参 base.env，每次构造新对象
 *
 * AC-8: Retry 触发：拒收时给 runtime 发 internal event；
 *        claude-runtime.ts:resumeWithCorrection 走 claude --resume + 新 user message
 */

export const RESUME_WITH_CORRECTION_ENV_FLAG = "MULTI_AGENT_RETRY_DISPATCH_VALIDATION"

export type ResumeWithCorrectionArgs = {
  /** 原始 turn 的 AgentRunInput（仅用于继承 invocationId / threadId / agentId / cwd / model 等） */
  base: AgentRunInput
  /** ClaudeRuntime 上一轮 result.nativeSessionId — 必填，否则不是 resume 而是新会话 */
  nativeSessionId: string
  /** dispatch-retry-coordinator.buildCorrectionPrompt 的输出 */
  correctionPrompt: string
}

export function buildResumeWithCorrectionInput(args: ResumeWithCorrectionArgs): AgentRunInput {
  if (!args.nativeSessionId || args.nativeSessionId.trim().length === 0) {
    throw new Error(
      "buildResumeWithCorrectionInput: nativeSessionId is required (resume 必须有 native session)",
    )
  }
  if (!args.correctionPrompt || args.correctionPrompt.trim().length === 0) {
    throw new Error(
      "buildResumeWithCorrectionInput: correctionPrompt is required (空 prompt 等于静默 retry)",
    )
  }

  const env = {
    ...(args.base.env ?? {}),
    MULTI_AGENT_NATIVE_SESSION_ID: args.nativeSessionId,
    [RESUME_WITH_CORRECTION_ENV_FLAG]: "1",
  }

  return {
    ...args.base,
    prompt: args.correctionPrompt,
    env,
  }
}
