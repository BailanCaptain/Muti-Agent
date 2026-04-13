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
})
