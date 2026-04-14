import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { extractSOPBookmark, formatBookmarkForInjection } from "./sop-bookmark"
import type { SOPBookmark } from "./sop-bookmark"

describe("extractSOPBookmark", () => {
  it("uses stage name directly as phase — no regex on output", () => {
    const output = `按 TDD 流程，我先写失败测试。\n## Red Phase\n这个测试验证...`
    const result = extractSOPBookmark(output, "tdd")
    assert.equal(result.skill, "tdd")
    assert.equal(result.phase, "tdd")
    assert.ok(result.lastCompletedStep.length > 0)
  })

  it("returns null-skill bookmark when no skill markers found", () => {
    const result = extractSOPBookmark("普通对话内容", null)
    assert.equal(result.skill, null)
    assert.equal(result.phase, null)
  })

  it("phase equals stage regardless of output content", () => {
    const output = "测试通过了！review 完成，准备 merge..."
    const result = extractSOPBookmark(output, "tdd")
    assert.equal(result.skill, "tdd")
    assert.equal(result.phase, "tdd", "phase must be stage name, not regex-detected from output")
  })

  it("requesting-review stage produces correct phase", () => {
    const output = "@范德彪 请 review 这个改动"
    const result = extractSOPBookmark(output, "requesting-review")
    assert.equal(result.skill, "requesting-review")
    assert.equal(result.phase, "requesting-review")
  })

  it("detects blocking question from 分歧点", () => {
    const output = `[分歧点] 要不要用 Redis 做缓存\n  [A] 用 Redis\n  [B] 用内存`
    const result = extractSOPBookmark(output, "tdd")
    assert.equal(result.blockingQuestion, "要不要用 Redis 做缓存")
  })

  it("handles empty output with skill stage", () => {
    const result = extractSOPBookmark("", "tdd")
    assert.equal(result.skill, "tdd")
    assert.equal(result.phase, "tdd")
    assert.equal(result.lastCompletedStep, "")
  })

  it("output mentioning 'review' does NOT change phase when stage is feat-lifecycle", () => {
    const output = "F007 review 三轮通过，德彪放行。已 merge 到 dev。文档已更新。"
    const result = extractSOPBookmark(output, "feat-lifecycle")
    assert.equal(result.phase, "feat-lifecycle",
      "phase must be stage name, never regex-detected from natural language")
  })

  it("marks phase=completed when sopStage indicates completion", () => {
    const output = "全部完成，已合入 dev"
    const result = extractSOPBookmark(output, "completed:feat-lifecycle")
    assert.equal(result.phase, "completed")
    assert.equal(result.nextExpectedAction, "")
  })

  it("B014-Bug1: does NOT regex-match 'review' when stage is feat-lifecycle and last 300 chars contain review", () => {
    const output = "F007 全部完成。德彪第三轮 review 通过了。已 merge 到 dev 并推到远程。"
    const result = extractSOPBookmark(output, "feat-lifecycle")
    assert.notEqual(result.phase, "review",
      "phase must be the stage name, not regex-detected 'review' from natural language")
    assert.equal(result.skill, "feat-lifecycle")
  })

  it("B014-Bug1: does NOT regex-match 'merge' when stage is tdd", () => {
    const output = "测试写完了。merge 后需要补 e2e 场景。"
    const result = extractSOPBookmark(output, "tdd")
    assert.notEqual(result.phase, "merge",
      "mentioning 'merge' in output should not override the structured stage")
    assert.equal(result.phase, "tdd")
  })

  it("B014-Bug1: lastCompletedStep contains actual output context, not regex snippet", () => {
    const output = "Task 9 UX 完成。全部 10 个 Task 实现完毕，91 测试全绿。"
    const result = extractSOPBookmark(output, "quality-gate")
    assert.ok(result.lastCompletedStep.includes("91 测试全绿"),
      "lastCompletedStep should contain meaningful output context")
  })
})

describe("formatBookmarkForInjection", () => {
  it("formats bookmark as machine-readable line", () => {
    const bm: SOPBookmark = {
      skill: "tdd",
      phase: "red",
      lastCompletedStep: "wrote failing test",
      nextExpectedAction: "minimal implementation",
      blockingQuestion: null,
      updatedAt: "2026-04-13T10:00:00Z",
    }
    const result = formatBookmarkForInjection(bm)
    assert.ok(result.includes("skill=tdd"))
    assert.ok(result.includes("phase=red"))
    assert.ok(result.includes("next=minimal implementation"))
  })

  it("returns empty string for null-skill bookmark", () => {
    const bm: SOPBookmark = {
      skill: null, phase: null, lastCompletedStep: "", nextExpectedAction: "",
      blockingQuestion: null, updatedAt: "2026-04-13T10:00:00Z",
    }
    assert.equal(formatBookmarkForInjection(bm), "")
  })

  it("includes blocking question when present", () => {
    const bm: SOPBookmark = {
      skill: "tdd",
      phase: "red",
      lastCompletedStep: "wrote test",
      nextExpectedAction: "implement",
      blockingQuestion: "需要确认 API 接口",
      updatedAt: "2026-04-13T10:00:00Z",
    }
    const result = formatBookmarkForInjection(bm)
    assert.ok(result.includes("blocking=需要确认 API 接口"))
  })
})
