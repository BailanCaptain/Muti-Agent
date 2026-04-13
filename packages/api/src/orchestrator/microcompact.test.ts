import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ContextMessage } from "./context-snapshot"
import { microcompact } from "./microcompact"

describe("microcompact", () => {
  const makeToolMsg = (id: string, content: string, createdAt: string, summary?: string): ContextMessage => ({
    id,
    role: "assistant",
    agentId: "黄仁勋",
    content,
    createdAt,
    toolEventsSummary: summary ?? "edit_file(completed)",
  })

  const makeFailToolMsg = (id: string, content: string, createdAt: string): ContextMessage => ({
    id,
    role: "assistant",
    agentId: "黄仁勋",
    content,
    createdAt,
    toolEventsSummary: "edit_file(error)",
  })

  const makeNormalMsg = (id: string, content: string, createdAt: string): ContextMessage => ({
    id,
    role: "assistant",
    agentId: "黄仁勋",
    content,
    createdAt,
  })

  it("keeps recent 5 tool results intact, compacts older ones", () => {
    const messages: ContextMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push(makeToolMsg(`t${i}`, `edited src/f${i}.ts`, `2026-04-13T10:${String(i).padStart(2, "0")}:00Z`))
    }
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    for (let i = 0; i < 5; i++) {
      assert.ok(result[i].content.includes("[工具结果已压缩]"), `msg ${i} should have anchor`)
      assert.ok(result[i].content.includes(`msgId=t${i}`), `msg ${i} should have anchor id`)
      assert.ok(result[i].content.includes(`edited src/f${i}.ts`), `msg ${i} should preserve original content`)
    }
    for (let i = 5; i < 10; i++) {
      assert.ok(!result[i].content.includes("[工具结果已压缩]"), `msg ${i} should be intact`)
    }
  })

  it("always keeps the most recent failure result intact", () => {
    const messages: ContextMessage[] = [
      makeFailToolMsg("t0", "edit failed with TypeError", "2026-04-13T10:00:00Z"),
      makeToolMsg("t1", "edited src/b.ts", "2026-04-13T10:01:00Z"),
      makeToolMsg("t2", "edited src/c.ts", "2026-04-13T10:02:00Z"),
      makeToolMsg("t3", "edited src/d.ts", "2026-04-13T10:03:00Z"),
      makeToolMsg("t4", "edited src/e.ts", "2026-04-13T10:04:00Z"),
      makeToolMsg("t5", "edited src/f.ts", "2026-04-13T10:05:00Z"),
      makeToolMsg("t6", "edited src/g.ts", "2026-04-13T10:06:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    assert.ok(!result[0].content.includes("[工具结果已压缩]"), "failure result must be preserved (in keepSet)")
    assert.ok(result[0].content.includes("edit failed with TypeError"), "failure content must be preserved")
    assert.ok(result[1].content.includes("[工具结果已压缩]"), "non-recent non-failure should have anchor")
    assert.ok(result[1].content.includes("edited src/b.ts"), "non-recent should still preserve original text")
  })

  it("does not modify non-tool messages (no toolEventsSummary)", () => {
    const messages: ContextMessage[] = [
      makeNormalMsg("n0", "我来分析一下架构", "2026-04-13T10:00:00Z"),
      makeToolMsg("t0", "read file src/a.ts", "2026-04-13T10:01:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    assert.equal(result[0].content, "我来分析一下架构")
  })

  it("returns new array without mutating input", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "edited file", "2026-04-13T10:00:00Z"),
    ]
    const original = messages[0].content
    microcompact(messages, { keepRecent: 0, keepLastFailure: false })
    assert.equal(messages[0].content, original)
  })

  it("anchor placeholder contains msgId, tools summary, and timestamp", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "edited foo", "2026-04-13T10:00:00Z", "edit_file(completed), read_file(completed)"),
      makeToolMsg("t1", "edited bar", "2026-04-13T10:01:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 1, keepLastFailure: false })
    assert.ok(result[0].content.includes("msgId=t0"))
    assert.ok(result[0].content.includes("edit_file(completed), read_file(completed)"))
    assert.ok(result[0].content.includes("at=2026-04-13T10:00:00Z"))
  })

  it("handles empty messages array", () => {
    const result = microcompact([], { keepRecent: 5, keepLastFailure: true })
    assert.equal(result.length, 0)
  })

  it("handles all non-tool messages", () => {
    const messages: ContextMessage[] = [
      makeNormalMsg("n0", "hello", "2026-04-13T10:00:00Z"),
      makeNormalMsg("n1", "world", "2026-04-13T10:01:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    assert.equal(result[0].content, "hello")
    assert.equal(result[1].content, "world")
  })

  // P1-1 Red: assistant content with toolEvents must NOT be entirely replaced
  it("preserves assistant content text for compacted tool messages (P1-1)", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "我分析了 context-assembler 的注入链路，发现三个问题", "2026-04-13T10:00:00Z"),
      makeToolMsg("t1", "recent1", "2026-04-13T10:01:00Z"),
      makeToolMsg("t2", "recent2", "2026-04-13T10:02:00Z"),
      makeToolMsg("t3", "recent3", "2026-04-13T10:03:00Z"),
      makeToolMsg("t4", "recent4", "2026-04-13T10:04:00Z"),
      makeToolMsg("t5", "recent5", "2026-04-13T10:05:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: false })
    // t0 is compacted (outside keepRecent), but its original content must be preserved
    assert.ok(
      result[0].content.includes("我分析了 context-assembler 的注入链路"),
      "original assistant text must be preserved even when compacted",
    )
    // anchor should also be appended
    assert.ok(result[0].content.includes("[工具结果已压缩]"), "anchor should be present")
  })
})
