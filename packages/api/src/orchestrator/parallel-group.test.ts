import assert from "node:assert/strict"
import test from "node:test"
import { ParallelGroupRegistry } from "./parallel-group"

test("create returns a ParallelGroup with correct fields", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "notify_originator",
  })

  assert.ok(group.id, "group should have an id")
  assert.equal(group.parentMessageId, "msg-1")
  assert.equal(group.originatorAgentId, "Coder")
  assert.equal(group.originatorProvider, "codex")
  assert.equal(group.pendingProviders.size, 2)
  assert.ok(group.pendingProviders.has("claude"))
  assert.ok(group.pendingProviders.has("gemini"))
  assert.equal(group.completedResults.size, 0)
  assert.equal(group.joinBehavior, "notify_originator")
  assert.ok(group.createdAt, "group should have createdAt")
})

test("markCompleted decrements pendingProviders", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "notify_originator",
  })

  const result = registry.markCompleted(group.id, "claude", {
    messageId: "reply-1",
    content: "Done",
  })

  assert.ok(result)
  assert.equal(result.allDone, false)
  assert.equal(result.group.pendingProviders.size, 1)
  assert.ok(result.group.pendingProviders.has("gemini"))
  assert.ok(!result.group.pendingProviders.has("claude"))
  assert.equal(result.group.completedResults.size, 1)
  assert.deepEqual(result.group.completedResults.get("claude"), {
    messageId: "reply-1",
    content: "Done",
  })
})

test("markCompleted returns allDone=true when all providers complete", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "silent",
  })

  registry.markCompleted(group.id, "claude", {
    messageId: "reply-1",
    content: "Done from claude",
  })

  const result = registry.markCompleted(group.id, "gemini", {
    messageId: "reply-2",
    content: "Done from gemini",
  })

  assert.ok(result)
  assert.equal(result.allDone, true)
  assert.equal(result.group.pendingProviders.size, 0)
  assert.equal(result.group.completedResults.size, 2)
})

test("markCompleted returns null for unknown groupId", () => {
  const registry = new ParallelGroupRegistry()

  const result = registry.markCompleted("nonexistent-id", "claude", {
    messageId: "reply-1",
    content: "Done",
  })

  assert.equal(result, null)
})

test("remove deletes the group", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude"],
    joinBehavior: "notify_originator",
  })

  assert.ok(registry.get(group.id))
  registry.remove(group.id)
  assert.equal(registry.get(group.id), undefined)
})
