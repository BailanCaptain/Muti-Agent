import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { extractSOPBookmark, formatBookmarkForInjection } from "./sop-bookmark"
import type { SOPBookmark } from "./sop-bookmark"

describe("extractSOPBookmark", () => {
  it("extracts skill and phase from agent output containing skill markers", () => {
    const output = `按 TDD 流程，我先写失败测试。

## Red Phase

这个测试验证...`
    const result = extractSOPBookmark(output, "tdd")
    assert.equal(result.skill, "tdd")
    assert.equal(result.phase, "red")
    assert.ok(result.lastCompletedStep.length > 0)
  })

  it("returns null-skill bookmark when no skill markers found", () => {
    const result = extractSOPBookmark("普通对话内容", null)
    assert.equal(result.skill, null)
    assert.equal(result.phase, null)
  })

  it("detects green phase", () => {
    const output = "测试通过了！现在重构..."
    const result = extractSOPBookmark(output, "tdd")
    assert.equal(result.skill, "tdd")
    assert.ok(result.phase === "green" || result.phase === "refactor")
  })

  it("detects review phase", () => {
    const output = "@范德彪 请 review 这个改动"
    const result = extractSOPBookmark(output, "requesting-review")
    assert.equal(result.skill, "requesting-review")
  })

  it("detects blocking question from 分歧点", () => {
    const output = `[分歧点] 要不要用 Redis 做缓存
  [A] 用 Redis
  [B] 用内存`
    const result = extractSOPBookmark(output, "tdd")
    assert.equal(result.blockingQuestion, "要不要用 Redis 做缓存")
  })

  it("handles empty output with skill stage", () => {
    const result = extractSOPBookmark("", "tdd")
    assert.equal(result.skill, "tdd")
    assert.equal(result.phase, null)
  })

  it("does NOT false-positive on 'review' when long output mentions review early but ends with different work", () => {
    // Simulate a real agent output: early text mentions "review passed",
    // but the last 300 chars describe current merge/deploy work with no review keywords
    const earlyText = "F007 review 三轮通过，德彪放行。已 merge 到 dev。".padEnd(400, "。")
    const recentText = "现在处理文档更新和 ROADMAP 同步，所有改动已提交完毕。"
    const output = earlyText + recentText
    const result = extractSOPBookmark(output, "feat-lifecycle")
    assert.notEqual(result.phase, "review",
      "extractSOPBookmark should only match on the last 300 chars, not early mentions")
  })

  it("marks phase=completed when sopStage indicates completion", () => {
    const output = "全部完成，已合入 dev"
    const result = extractSOPBookmark(output, "completed:feat-lifecycle")
    assert.equal(result.phase, "completed")
    assert.equal(result.nextExpectedAction, "")
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
