import assert from "node:assert/strict"
import test from "node:test"
import { ParallelGroupRegistry, isTerminal, isValidTransition } from "./parallel-group"

// ── State machine ────────────────────────────────────────────────────

test("isTerminal returns true for done/timeout/failed", () => {
  assert.equal(isTerminal("done"), true)
  assert.equal(isTerminal("timeout"), true)
  assert.equal(isTerminal("failed"), true)
  assert.equal(isTerminal("pending"), false)
  assert.equal(isTerminal("running"), false)
  assert.equal(isTerminal("partial"), false)
})

test("isValidTransition allows pending → running", () => {
  assert.equal(isValidTransition("pending", "running"), true)
  assert.equal(isValidTransition("pending", "failed"), true)
  assert.equal(isValidTransition("pending", "done"), false)
})

test("isValidTransition allows running → partial/done/timeout/failed", () => {
  assert.equal(isValidTransition("running", "partial"), true)
  assert.equal(isValidTransition("running", "done"), true)
  assert.equal(isValidTransition("running", "timeout"), true)
  assert.equal(isValidTransition("running", "failed"), true)
  assert.equal(isValidTransition("running", "pending"), false)
})

test("isValidTransition blocks terminal → anything", () => {
  assert.equal(isValidTransition("done", "running"), false)
  assert.equal(isValidTransition("timeout", "running"), false)
  assert.equal(isValidTransition("failed", "pending"), false)
})

// ── Registry basics ──────────────────────────────────────────────────

test("create returns a ParallelGroup with correct fields", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "notify_originator",
  })

  assert.ok(group.id)
  assert.equal(group.parentMessageId, "msg-1")
  assert.equal(group.originatorAgentId, "Coder")
  assert.equal(group.originatorProvider, "codex")
  assert.equal(group.pendingProviders.size, 2)
  assert.ok(group.pendingProviders.has("claude"))
  assert.ok(group.pendingProviders.has("gemini"))
  assert.equal(group.completedResults.size, 0)
  assert.equal(group.joinBehavior, "notify_originator")
  assert.equal(group.status, "pending")
  assert.equal(group.timeoutMinutes, 8)
  assert.ok(group.createdAt)
})

test("create defaults initiatedBy to user when not provided", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Villager",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "notify_originator",
  })
  assert.equal(group.initiatedBy, "user")
})

test("create respects explicit initiatedBy=agent", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "silent",
    initiatedBy: "agent",
  })
  assert.equal(group.initiatedBy, "agent")
})

test("create stores participantProviders matching targetProviders", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Villager",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "notify_originator",
  })
  assert.deepEqual(group.participantProviders, ["claude", "gemini"])
})

test("participantProviders are frozen — do not mutate as providers complete", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Villager",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "notify_originator",
  })
  registry.start(group.id)
  registry.markCompleted(group.id, "claude", { messageId: "m1", content: "done" })
  assert.deepEqual(group.participantProviders, ["claude", "gemini"])
})

test("start transitions from pending to running", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude"],
    joinBehavior: "silent",
  })

  assert.equal(group.status, "pending")
  registry.start(group.id)
  assert.equal(group.status, "running")
})

// ── markCompleted ────────────────────────────────────────────────────

test("markCompleted decrements pendingProviders and transitions to partial", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "notify_originator",
  })
  registry.start(group.id)

  const result = registry.markCompleted(group.id, "claude", {
    messageId: "reply-1",
    content: "Done",
  })

  assert.ok(result)
  assert.equal(result.allDone, false)
  assert.equal(result.group.pendingProviders.size, 1)
  assert.equal(result.group.status, "partial")
})

test("markCompleted returns allDone=true and transitions to done", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "silent",
  })
  registry.start(group.id)

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
  assert.equal(result.group.status, "done")
})

test("markCompleted returns null for unknown groupId", () => {
  const registry = new ParallelGroupRegistry()
  const result = registry.markCompleted("nonexistent-id", "claude", {
    messageId: "reply-1",
    content: "Done",
  })
  assert.equal(result, null)
})

test("markCompleted on unstarted group throws when reaching terminal state", () => {
  // Regression: user-mention fan-out once created groups without calling start(),
  // which left status=pending. The last markCompleted then tried pending→done,
  // an illegal transition, and threw inside Promise.allSettled — silently
  // skipping the ConnectorBubble + fan-in selector. Test locks the contract:
  // if you forget to start(), the failure must be loud, not swallowed.
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Villager",
    originatorProvider: "claude",
    targetProviders: ["codex", "gemini"],
    joinBehavior: "notify_originator",
  })

  registry.markCompleted(group.id, "codex", { messageId: "r1", content: "done" })
  assert.throws(
    () => registry.markCompleted(group.id, "gemini", { messageId: "r2", content: "done" }),
    /Invalid transition: pending → done/,
  )
})

test("markCompleted ignores duplicate from same provider", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "silent",
  })
  registry.start(group.id)

  registry.markCompleted(group.id, "claude", { messageId: "reply-1", content: "First" })
  const result = registry.markCompleted(group.id, "claude", { messageId: "reply-2", content: "Duplicate" })

  assert.ok(result)
  assert.equal(result.group.completedResults.get("claude")?.content, "First")
})

// ── Timeout ──────────────────────────────────────────────────────────

test("handleTimeout marks remaining providers and transitions to timeout", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "notify_originator",
    timeoutMinutes: 5,
  })
  registry.start(group.id)

  registry.markCompleted(group.id, "claude", { messageId: "reply-1", content: "Done" })
  registry.handleTimeout(group.id)

  assert.equal(group.status, "timeout")
  assert.equal(group.pendingProviders.size, 0)
  assert.equal(group.completedResults.size, 2)
  assert.ok(group.completedResults.get("gemini")?.content.includes("timeout"))
})

test("handleTimeout is noop on terminal state", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude"],
    joinBehavior: "silent",
  })
  registry.start(group.id)
  registry.markCompleted(group.id, "claude", { messageId: "reply-1", content: "Done" })

  assert.equal(group.status, "done")
  registry.handleTimeout(group.id)
  assert.equal(group.status, "done")
})

// ── Failure ──────────────────────────────────────────────────────────

test("handleFailure transitions to failed", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude"],
    joinBehavior: "silent",
  })
  registry.start(group.id)

  registry.handleFailure(group.id)
  assert.equal(group.status, "failed")
})

// ── Anti-cascade ─────────────────────────────────────────────────────

test("isActiveTarget returns true for pending provider in running group", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "silent",
  })
  registry.start(group.id)

  assert.equal(registry.isActiveTarget("claude"), true)
  assert.equal(registry.isActiveTarget("gemini"), true)
  assert.equal(registry.isActiveTarget("codex"), false)
})

test("isActiveTarget returns false after provider completes", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude", "gemini"],
    joinBehavior: "silent",
  })
  registry.start(group.id)
  registry.markCompleted(group.id, "claude", { messageId: "reply-1", content: "Done" })

  assert.equal(registry.isActiveTarget("claude"), false)
  assert.equal(registry.isActiveTarget("gemini"), true)
})

// ── Idempotency ──────────────────────────────────────────────────────

test("create with same idempotencyKey returns existing group", () => {
  const registry = new ParallelGroupRegistry()
  const group1 = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude"],
    joinBehavior: "silent",
    idempotencyKey: "key-1",
  })

  const group2 = registry.create({
    parentMessageId: "msg-2",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["gemini"],
    joinBehavior: "silent",
    idempotencyKey: "key-1",
  })

  assert.equal(group1.id, group2.id)
})

test("create with different idempotencyKey returns new group", () => {
  const registry = new ParallelGroupRegistry()
  const group1 = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude"],
    joinBehavior: "silent",
    idempotencyKey: "key-1",
  })

  const group2 = registry.create({
    parentMessageId: "msg-2",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["gemini"],
    joinBehavior: "silent",
    idempotencyKey: "key-2",
  })

  assert.notEqual(group1.id, group2.id)
})

// ── remove ───────────────────────────────────────────────────────────

test("remove deletes the group and cleans idempotency index", () => {
  const registry = new ParallelGroupRegistry()
  const group = registry.create({
    parentMessageId: "msg-1",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["claude"],
    joinBehavior: "notify_originator",
    idempotencyKey: "key-1",
  })

  assert.ok(registry.get(group.id))
  registry.remove(group.id)
  assert.equal(registry.get(group.id), undefined)

  // After removal, same key creates new group
  const group2 = registry.create({
    parentMessageId: "msg-2",
    originatorAgentId: "Coder",
    originatorProvider: "codex",
    targetProviders: ["gemini"],
    joinBehavior: "silent",
    idempotencyKey: "key-1",
  })
  assert.notEqual(group.id, group2.id)
})
