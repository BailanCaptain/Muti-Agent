import assert from "node:assert/strict"
import test from "node:test"
import type { AgentRunInput } from "./base-runtime"
import {
  RESUME_WITH_CORRECTION_ENV_FLAG,
  buildResumeWithCorrectionInput,
} from "./resume-with-correction"

/**
 * F026 P3.1 Task5 · 派发协议 retry — 走 claude --resume <session> + correction prompt 喂回 CLI
 *
 * 此模块只构造 AgentRunInput；spawn 由 BaseCliRuntime 已有 run() 接管，无需重复测试。
 *
 * AC-8: Retry 触发：拒收时给 runtime 发 internal event；
 *        claude-runtime.ts:resumeWithCorrection 走 claude --resume <native_session_id> + 新 user message
 */

const baseInput: AgentRunInput = {
  invocationId: "inv-001",
  threadId: "t-001",
  agentId: "claude",
  prompt: "原始 prompt（不应被使用）",
  cwd: "/tmp/test-cwd",
  env: {
    MULTI_AGENT_MODEL: "claude-opus-4-7",
    MULTI_AGENT_EFFORT: "medium",
  },
}

test("AC-8 · resume：注入 native session id + 用 correction prompt 替换 stdin", () => {
  const next = buildResumeWithCorrectionInput({
    base: baseInput,
    nativeSessionId: "session-abc-123",
    correctionPrompt: "[系统] 上轮 final 派发格式不合契约：nested_call_tag。请重写。",
  })

  // session id 注入到 env，驱动 buildCommand 走 --resume 路径
  assert.equal(next.env?.MULTI_AGENT_NATIVE_SESSION_ID, "session-abc-123")
  // 标志位：retry 上下文（便于下游限速 / 排查日志）
  assert.equal(next.env?.[RESUME_WITH_CORRECTION_ENV_FLAG], "1")
  // prompt 必须被 correctionPrompt 覆盖（否则 CLI 会再跑一遍原始任务）
  assert.equal(next.prompt, "[系统] 上轮 final 派发格式不合契约：nested_call_tag。请重写。")
  // 其他 env 字段（model/effort）保留
  assert.equal(next.env?.MULTI_AGENT_MODEL, "claude-opus-4-7")
  assert.equal(next.env?.MULTI_AGENT_EFFORT, "medium")
  // agentId / threadId 不变
  assert.equal(next.agentId, baseInput.agentId)
  assert.equal(next.threadId, baseInput.threadId)
})

test("AC-8 · resume：base 没 env 也能构造", () => {
  const next = buildResumeWithCorrectionInput({
    base: {
      invocationId: "inv-002",
      threadId: "t-002",
      agentId: "claude",
      prompt: "x",
      cwd: "/tmp/cwd",
    },
    nativeSessionId: "s-xyz",
    correctionPrompt: "fix it",
  })
  assert.equal(next.env?.MULTI_AGENT_NATIVE_SESSION_ID, "s-xyz")
  assert.equal(next.env?.[RESUME_WITH_CORRECTION_ENV_FLAG], "1")
  assert.equal(next.prompt, "fix it")
})

test("AC-8 · 拒空 sessionId（resume 必须有 native session 否则就是新开会话）", () => {
  assert.throws(
    () =>
      buildResumeWithCorrectionInput({
        base: baseInput,
        nativeSessionId: "",
        correctionPrompt: "fix it",
      }),
    /nativeSessionId/i,
  )
})

test("AC-8 · 拒空 correctionPrompt（空 prompt = 静默 retry，违反 P5 可观测）", () => {
  assert.throws(
    () =>
      buildResumeWithCorrectionInput({
        base: baseInput,
        nativeSessionId: "s-xyz",
        correctionPrompt: "   ",
      }),
    /correctionPrompt/i,
  )
})

test("AC-8 · 多次 retry 不互相污染 env（构造为不可变；不写回 base.env）", () => {
  const next1 = buildResumeWithCorrectionInput({
    base: baseInput,
    nativeSessionId: "s-1",
    correctionPrompt: "p1",
  })
  const next2 = buildResumeWithCorrectionInput({
    base: baseInput,
    nativeSessionId: "s-2",
    correctionPrompt: "p2",
  })
  assert.equal(next1.env?.MULTI_AGENT_NATIVE_SESSION_ID, "s-1")
  assert.equal(next2.env?.MULTI_AGENT_NATIVE_SESSION_ID, "s-2")
  // base 未被改
  assert.equal(baseInput.env?.MULTI_AGENT_NATIVE_SESSION_ID, undefined)
})
