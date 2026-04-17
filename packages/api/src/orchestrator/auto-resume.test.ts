import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { shouldAutoResume, buildAutoResumeMessage } from "./auto-resume"
import type { SOPBookmark } from "./sop-bookmark"

describe("shouldAutoResume", () => {
  const activeBookmark: SOPBookmark = {
    skill: "tdd", phase: "red", lastCompletedStep: "wrote test",
    nextExpectedAction: "implement", blockingQuestion: null,
    updatedAt: "2026-04-13T10:00:00Z",
  }

  const emptyBookmark: SOPBookmark = {
    skill: null, phase: null, lastCompletedStep: "",
    nextExpectedAction: "", blockingQuestion: null,
    updatedAt: "2026-04-13T10:00:00Z",
  }

  it("returns true when bookmark has unfinished work and count < max", () => {
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0.3), true)
  })

  it("returns false when autoResumeCount >= maxResumes", () => {
    assert.equal(shouldAutoResume(activeBookmark, 2, 2, 0.3), false)
  })

  it("returns false when bookmark has no skill", () => {
    assert.equal(shouldAutoResume(emptyBookmark, 0, 2, 0.3), false)
  })

  it("returns false when fillRatio > 0.5 on new session", () => {
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0.6), false)
  })

  it("returns true when fillRatio is 0 (fresh session)", () => {
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0), true)
  })

  it("returns false when bookmark has no nextExpectedAction", () => {
    const noNext: SOPBookmark = { ...activeBookmark, nextExpectedAction: "" }
    assert.equal(shouldAutoResume(noNext, 0, 2, 0.3), false)
  })

  it("returns false for null bookmark", () => {
    assert.equal(shouldAutoResume(null, 0, 2, 0.3), false)
  })

  it("returns false when phase is completed (Bug 4 - completed short-circuit)", () => {
    const completedBookmark: SOPBookmark = {
      ...activeBookmark,
      phase: "completed",
      nextExpectedAction: "",
    }
    assert.equal(shouldAutoResume(completedBookmark, 0, 2, 0), false)
  })

  it("returns false when lastStopReason is complete (B015 — agent finished answering, not mid-task)", () => {
    // B015 root cause: agent 完整回答了用户问题（Claude 原生 end_turn，runtime 映射为内部 "complete"）
    // 但同 turn 内 sealDecision.shouldSeal=true 触发 auto-resume，
    // context-assembler 把 R1 原对话重灌进新 session，LLM 误把已答问题当 pending 重答。
    // 修复：StopReason="complete" 明确表示"这轮 agent 正常说完了"，不应该被续接。
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0, "complete"), false)
  })

  it("returns true when lastStopReason is truncated (genuine continuation needed)", () => {
    // 对称用例：truncated / tool_wait 表示 agent 被截断或等工具，续接是正确行为
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0, "truncated"), true)
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0, "tool_wait"), true)
  })

  it("returns true when lastStopReason is undefined/null (backward compat)", () => {
    // 向后兼容：没传 stopReason 时行为不变（旧调用不破坏）
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0), true)
    assert.equal(shouldAutoResume(activeBookmark, 0, 2, 0, null), true)
  })
})

describe("buildAutoResumeMessage", () => {
  const bookmark: SOPBookmark = {
    skill: "tdd", phase: "red", lastCompletedStep: "wrote test",
    nextExpectedAction: "minimal implementation", blockingQuestion: null,
    updatedAt: "2026-04-13T10:00:00Z",
  }

  it("contains bookmark info and resume count", () => {
    const msg = buildAutoResumeMessage(bookmark, 1, 2)
    assert.ok(msg.includes("1/2"))
    assert.ok(msg.includes("skill=tdd"))
    assert.ok(msg.includes("next=minimal implementation"))
  })

  it("includes blocking question when present", () => {
    const bm: SOPBookmark = { ...bookmark, blockingQuestion: "需要确认接口" }
    const msg = buildAutoResumeMessage(bm, 1, 2)
    assert.ok(msg.includes("需要确认接口"))
  })

  it("includes lastCompletedStep in resume message (Bug 2)", () => {
    const bm: SOPBookmark = { ...bookmark, lastCompletedStep: "wrote failing test for auth" }
    const msg = buildAutoResumeMessage(bm, 1, 2)
    assert.ok(msg.includes("last=wrote failing test for auth"),
      "resume message must include last= field so agent knows what was already done")
  })

  it("contains suppress-follow-up hard guard against restating / re-answering history (B015)", () => {
    // B015 防御：resume 消息必须带硬指令，禁止 LLM 复述已有结论、重新回答历史问题、
    // 以"让我继续 / 我来回答"等开场。参照 OpenHarness compact 的 suppress_follow_up。
    const msg = buildAutoResumeMessage(bookmark, 1, 2)
    assert.ok(
      /严禁|不得|禁止/.test(msg),
      "resume message must contain a hard prohibition keyword (严禁/不得/禁止)",
    )
    assert.ok(
      msg.includes("复述") || msg.includes("重新回答"),
      "resume message must explicitly forbid restating or re-answering prior user questions",
    )
    assert.ok(
      msg.includes("让我继续") || msg.includes("我来回答") || msg.includes("开场"),
      "resume message must forbid acknowledge-style opening phrases",
    )
  })
})
