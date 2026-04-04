import assert from "node:assert/strict"
import test from "node:test"
import { buildContextSnapshot, extractTaskSnippet } from "./context-snapshot"

// ── helpers ──────────────────────────────────────────────────────────

function makeMsg(
  index: number,
  overrides: Partial<{
    threadId: string
    role: "user" | "assistant"
    content: string
  }> = {},
) {
  const id = `msg-${index}`
  return {
    id,
    threadId: overrides.threadId ?? "thread-codex",
    role: overrides.role ?? "assistant",
    content: overrides.content ?? `message ${index}`,
    createdAt: new Date(1700000000000 + index * 1000).toISOString(),
  }
}

const threadMeta = new Map([
  ["thread-codex", { provider: "codex" as const, alias: "范德彪" }],
  ["thread-claude", { provider: "claude" as const, alias: "黄仁勋" }],
])

// ── buildContextSnapshot ─────────────────────────────────────────────

test("buildContextSnapshot returns messages up to trigger message", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(i + 1))
  const result = buildContextSnapshot(msgs, threadMeta, {
    sessionGroupId: "group-1",
    triggerMessageId: "msg-7",
    maxMessages: 20,
  })

  assert.equal(result.length, 7)
  assert.equal(result[0].id, "msg-1")
  assert.equal(result[6].id, "msg-7")
})

test("buildContextSnapshot caps at maxMessages", () => {
  const msgs = Array.from({ length: 30 }, (_, i) => makeMsg(i + 1))
  const result = buildContextSnapshot(msgs, threadMeta, {
    sessionGroupId: "group-1",
    triggerMessageId: "msg-25",
    maxMessages: 5,
  })

  assert.equal(result.length, 5)
  assert.equal(result[0].id, "msg-21")
  assert.equal(result[4].id, "msg-25")
})

test("buildContextSnapshot maps agentId correctly", () => {
  const msgs = [
    makeMsg(1, { threadId: "thread-codex", role: "user" }),
    makeMsg(2, { threadId: "thread-codex", role: "assistant" }),
    makeMsg(3, { threadId: "thread-claude", role: "assistant" }),
  ]
  const result = buildContextSnapshot(msgs, threadMeta, {
    sessionGroupId: "group-1",
    triggerMessageId: "msg-3",
  })

  assert.equal(result[0].agentId, "user")
  assert.equal(result[1].agentId, "范德彪")
  assert.equal(result[2].agentId, "黄仁勋")
})

test("buildContextSnapshot returns empty array if trigger not found", () => {
  const msgs = [makeMsg(1), makeMsg(2)]
  const result = buildContextSnapshot(msgs, threadMeta, {
    sessionGroupId: "group-1",
    triggerMessageId: "msg-999",
  })

  assert.equal(result.length, 0)
})

// ── extractTaskSnippet ───────────────────────────────────────────────

test("extractTaskSnippet extracts sentence containing @mention", () => {
  const content = "我觉得这个方案不错，大家辛苦了。@范德彪 请帮忙review一下这段新写的代码逻辑。然后我们合入主分支。"
  const result = extractTaskSnippet(content, "范德彪")
  assert.equal(result, "@范德彪 请帮忙review一下这段新写的代码逻辑")
})

test("extractTaskSnippet handles English periods", () => {
  const content = "This looks good. @codex please review the changes. Then merge."
  const result = extractTaskSnippet(content, "codex")
  assert.equal(result, "@codex please review the changes")
})

test("extractTaskSnippet returns full content when sentence too short", () => {
  const content = "@范德彪 看看"
  const result = extractTaskSnippet(content, "范德彪")
  assert.equal(result, content)
})

test("extractTaskSnippet truncates at 500 chars", () => {
  const longContent = "@范德彪 " + "这是一段很长的文字".repeat(100)
  const result = extractTaskSnippet(longContent, "范德彪")
  assert.ok(result.length <= 500)
})
