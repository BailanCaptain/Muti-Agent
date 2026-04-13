import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ContextMessage } from "./context-snapshot"
import { microcompact } from "./microcompact"

describe("microcompact", () => {
  const makeToolMsg = (id: string, content: string, createdAt: string): ContextMessage => ({
    id,
    role: "assistant",
    agentId: "黄仁勋",
    content: `[tool_result] ${content}`,
    createdAt,
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
      messages.push(makeToolMsg(`t${i}`, `edit_file src/f${i}.ts exit=0`, `2026-04-13T10:${String(i).padStart(2, "0")}:00Z`))
    }
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    for (let i = 0; i < 5; i++) {
      assert.ok(result[i].content.includes("[工具结果已压缩]"), `msg ${i} should be compacted`)
      assert.ok(result[i].content.includes(`msgId=t${i}`), `msg ${i} should have anchor`)
    }
    for (let i = 5; i < 10; i++) {
      assert.ok(result[i].content.includes("[tool_result]"), `msg ${i} should be intact`)
    }
  })

  it("always keeps the most recent failure result intact", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "edit_file src/a.ts exit=1 stderr=TypeError", "2026-04-13T10:00:00Z"),
      makeToolMsg("t1", "edit_file src/b.ts exit=0", "2026-04-13T10:01:00Z"),
      makeToolMsg("t2", "edit_file src/c.ts exit=0", "2026-04-13T10:02:00Z"),
      makeToolMsg("t3", "edit_file src/d.ts exit=0", "2026-04-13T10:03:00Z"),
      makeToolMsg("t4", "edit_file src/e.ts exit=0", "2026-04-13T10:04:00Z"),
      makeToolMsg("t5", "edit_file src/f.ts exit=0", "2026-04-13T10:05:00Z"),
      makeToolMsg("t6", "edit_file src/g.ts exit=0", "2026-04-13T10:06:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    assert.ok(result[0].content.includes("[tool_result]"), "failure result must be preserved")
    assert.ok(!result[0].content.includes("[工具结果已压缩]"))
    assert.ok(result[1].content.includes("[工具结果已压缩]"))
  })

  it("does not modify non-tool messages", () => {
    const messages: ContextMessage[] = [
      makeNormalMsg("n0", "我来分析一下架构", "2026-04-13T10:00:00Z"),
      makeToolMsg("t0", "read_file src/a.ts exit=0", "2026-04-13T10:01:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 5, keepLastFailure: true })
    assert.equal(result[0].content, "我来分析一下架构")
  })

  it("returns new array without mutating input", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "edit_file exit=0", "2026-04-13T10:00:00Z"),
    ]
    const original = messages[0].content
    microcompact(messages, { keepRecent: 0, keepLastFailure: false })
    assert.equal(messages[0].content, original)
  })

  it("anchor placeholder contains msgId, tool name, and timestamp", () => {
    const messages: ContextMessage[] = [
      makeToolMsg("t0", "edit_file path=src/foo.ts exit=0", "2026-04-13T10:00:00Z"),
      makeToolMsg("t1", "read_file exit=0", "2026-04-13T10:01:00Z"),
    ]
    const result = microcompact(messages, { keepRecent: 1, keepLastFailure: false })
    assert.ok(result[0].content.includes("msgId=t0"))
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
})
