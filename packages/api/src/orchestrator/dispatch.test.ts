import assert from "node:assert/strict"
import test from "node:test"
import type { ContextMessage } from "./context-snapshot"
import { DispatchOrchestrator } from "./dispatch"
import type { QueueEntry, BlockedDispatch } from "./dispatch"

function createSessionsStub() {
  const threads = [
    {
      id: "thread-codex",
      sessionGroupId: "group-1",
      provider: "codex",
      alias: "范德彪",
    },
    {
      id: "thread-claude",
      sessionGroupId: "group-1",
      provider: "claude",
      alias: "黄仁勋",
    },
    {
      id: "thread-gemini",
      sessionGroupId: "group-1",
      provider: "gemini",
      alias: "桂芬",
    },
  ]

  return {
    findThread: (threadId: string) => threads.find((thread) => thread.id === threadId) ?? null,
    findThreadByGroupAndProvider: (sessionGroupId: string, provider: string) =>
      threads.find(
        (thread) => thread.sessionGroupId === sessionGroupId && thread.provider === provider,
      ) ?? null,
    listGroupThreads: (sessionGroupId: string) =>
      threads.filter((thread) => thread.sessionGroupId === sessionGroupId),
  }
}

const defaultAliases = {
  codex: "范德彪",
  claude: "黄仁勋",
  gemini: "桂芬",
}

// Stub callbacks for buildSnapshot / extractSnippet
const stubBuildSnapshot = () => []
const stubExtractSnippet = (content: string) => content.slice(0, 200)

test("dedupes the same target provider across different messages within one root chain", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)

  dispatch.registerUserRoot("root-1", "group-1")

  const fromUserMessage = dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手",
    matchMode: "anywhere",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  const fromAssistantMessage = dispatch.enqueuePublicMentions({
    messageId: "assistant-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请继续",
    matchMode: "line-start",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(fromUserMessage.queued.length, 1)
  assert.equal(fromAssistantMessage.queued.length, 0)
  const next = dispatch.takeNextQueuedDispatch("group-1")
  assert.ok(next)
  assert.equal(next.to.provider, "gemini")
  assert.equal(dispatch.takeNextQueuedDispatch("group-1"), null)
})

test("cancels a session group barrier, clears queued hops, and blocks later mentions until the next user root", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)

  dispatch.registerUserRoot("root-1", "group-1")
  const firstQueue = dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手",
    matchMode: "anywhere",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  const cancelled = dispatch.cancelSessionGroup("group-1")
  const blocked = dispatch.enqueuePublicMentions({
    messageId: "assistant-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 继续",
    matchMode: "line-start",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(firstQueue.queued.length, 1)
  assert.equal(cancelled.clearedCount, 1)
  assert.equal(dispatch.hasQueuedDispatches("group-1"), false)
  assert.equal(dispatch.isSessionGroupCancelled("group-1"), true)
  assert.equal(blocked.queued.length, 0)
  assert.deepEqual(
    blocked.blocked.map((entry) => ({
      reason: entry.reason,
      targetProvider: entry.to.provider,
    })),
    [{ reason: "group_cancelled", targetProvider: "gemini" }],
  )
  assert.equal(dispatch.takeNextQueuedDispatch("group-1"), null)

  dispatch.registerUserRoot("root-2", "group-1")

  assert.equal(dispatch.isSessionGroupCancelled("group-1"), false)
})

test("cancelSessionGroup invalidates all active invocations via registry", () => {
  const cancelledIds: string[] = []
  const mockRegistry = {
    invalidateInvocation: (id: string) => {
      cancelledIds.push(id)
    },
  }

  const dispatch = new DispatchOrchestrator(
    createSessionsStub() as never,
    defaultAliases,
    mockRegistry,
  )

  dispatch.registerUserRoot("root-1", "group-1")
  dispatch.bindInvocation("inv-a", {
    rootMessageId: "root-1",
    sessionGroupId: "group-1",
    sourceProvider: "claude",
    parentInvocationId: null,
  })
  dispatch.bindInvocation("inv-b", {
    rootMessageId: "root-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    parentInvocationId: null,
  })

  const result = dispatch.cancelSessionGroup("group-1")

  assert.equal(result.cancelledActiveCount, 2)
  assert.equal(cancelledIds.length, 2)
  assert.ok(cancelledIds.includes("inv-a"))
  assert.ok(cancelledIds.includes("inv-b"))
})

test("releaseInvocation removes invocation from active tracking before cancel", () => {
  const cancelledIds: string[] = []
  const mockRegistry = {
    invalidateInvocation: (id: string) => {
      cancelledIds.push(id)
    },
  }

  const dispatch = new DispatchOrchestrator(
    createSessionsStub() as never,
    defaultAliases,
    mockRegistry,
  )

  dispatch.registerUserRoot("root-1", "group-1")
  dispatch.bindInvocation("inv-a", {
    rootMessageId: "root-1",
    sessionGroupId: "group-1",
    sourceProvider: "claude",
    parentInvocationId: null,
  })
  dispatch.bindInvocation("inv-b", {
    rootMessageId: "root-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    parentInvocationId: null,
  })

  // inv-a 正常完成已 release；inv-b 仍在运行
  dispatch.releaseInvocation("inv-a")
  dispatch.cancelSessionGroup("group-1")

  assert.equal(cancelledIds.length, 1)
  assert.equal(cancelledIds[0], "inv-b")
})

test("enforces MAX_HOPS and blocks the 16th mention", () => {
  const sessions = {
    findThreadByGroupAndProvider: (_group: string, _provider: string) => ({ id: "target" }),
    listGroupThreads: () => [],
  }
  const aliases: any = {}
  for (let i = 0; i < 20; i++) {
    aliases[`p${i}`] = `@p${i}`
  }

  const dispatch = new DispatchOrchestrator(sessions as any, aliases)
  const rootId = dispatch.registerUserRoot("root-1", "group-1")

  // Enqueue 15 mentions one by one to reach MAX_HOPS
  for (let i = 0; i < 15; i++) {
    const result = dispatch.enqueuePublicMentions({
      messageId: `msg-${i}`,
      sessionGroupId: "group-1",
      sourceProvider: "root" as any,
      sourceAlias: "Root",
      rootMessageId: rootId,
      content: `@p${i} go`,
      matchMode: "line-start",
      buildSnapshot: stubBuildSnapshot,
      extractSnippet: stubExtractSnippet,
    })
    assert.equal(result.queued.length, 1, `Should queue hop ${i}`)
  }

  // Attempt the 16th — should be blocked by MAX_HOPS
  const result = dispatch.enqueuePublicMentions({
    messageId: "msg-16",
    sessionGroupId: "group-1",
    sourceProvider: "root" as any,
    sourceAlias: "Root",
    rootMessageId: rootId,
    content: "@p16 stop",
    matchMode: "line-start",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(result.queued.length, 0, "16th hop should be blocked by MAX_HOPS")
  assert.equal(result.blocked.length, 0, "Should not be blocked by barrier, just ignored")
})

// ===== New tests for QueueEntry structure =====

test("QueueEntry carries structured from/to identity", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "msg-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手任务",
    matchMode: "anywhere",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(result.queued.length, 1)
  const entry = result.queued[0] as QueueEntry
  // Verify structured from
  assert.equal(entry.from.agentId, "范德彪")
  assert.equal(entry.from.messageId, "msg-1")
  assert.equal(entry.from.provider, "codex")
  // Verify structured to
  assert.equal(entry.to.agentId, "桂芬")
  assert.equal(entry.to.provider, "gemini")
  // Verify id exists
  assert.ok(entry.id, "QueueEntry should have an id")
  assert.equal(entry.sessionGroupId, "group-1")
  assert.equal(entry.rootMessageId, "root-1")
})

test("hopIndex increments per chain depth", () => {
  const sessions = {
    findThreadByGroupAndProvider: (_group: string, _provider: string) => ({ id: "target" }),
    listGroupThreads: () => [],
  }
  const aliases: any = { root: "@root", p0: "@p0", p1: "@p1", p2: "@p2" }

  const dispatch = new DispatchOrchestrator(sessions as any, aliases)
  dispatch.registerUserRoot("root-1", "group-1")

  // Hop 0
  const r0 = dispatch.enqueuePublicMentions({
    messageId: "msg-0",
    sessionGroupId: "group-1",
    sourceProvider: "root" as any,
    sourceAlias: "Root",
    rootMessageId: "root-1",
    content: "@p0 go",
    matchMode: "line-start",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })
  assert.equal(r0.queued.length, 1)
  assert.equal((r0.queued[0] as QueueEntry).hopIndex, 0)

  // Hop 1
  const r1 = dispatch.enqueuePublicMentions({
    messageId: "msg-1",
    sessionGroupId: "group-1",
    sourceProvider: "p0" as any,
    sourceAlias: "Agent0",
    rootMessageId: "root-1",
    content: "@p1 continue",
    matchMode: "line-start",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })
  assert.equal(r1.queued.length, 1)
  assert.equal((r1.queued[0] as QueueEntry).hopIndex, 1)

  // Hop 2
  const r2 = dispatch.enqueuePublicMentions({
    messageId: "msg-2",
    sessionGroupId: "group-1",
    sourceProvider: "p1" as any,
    sourceAlias: "Agent1",
    rootMessageId: "root-1",
    content: "@p2 finish",
    matchMode: "line-start",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })
  assert.equal(r2.queued.length, 1)
  assert.equal((r2.queued[0] as QueueEntry).hopIndex, 2)
})

test("parentInvocationId is null for user-initiated, non-null for agent-initiated", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  // User-initiated: no parentInvocationId
  const userResult = dispatch.enqueuePublicMentions({
    messageId: "user-msg",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请处理",
    matchMode: "anywhere",
    parentInvocationId: null,
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(userResult.queued.length, 1)
  assert.equal((userResult.queued[0] as QueueEntry).parentInvocationId, null)

  // Agent-initiated: has parentInvocationId
  dispatch.registerUserRoot("root-2", "group-1")
  const agentResult = dispatch.enqueuePublicMentions({
    messageId: "agent-msg",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-2",
    content: "@黄仁勋 请 review",
    matchMode: "line-start",
    parentInvocationId: "inv-abc-123",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(agentResult.queued.length, 1)
  assert.equal((agentResult.queued[0] as QueueEntry).parentInvocationId, "inv-abc-123")
})

test("BlockedDispatch includes reason field with group_cancelled", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  dispatch.cancelSessionGroup("group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "msg-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手",
    matchMode: "anywhere",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(result.blocked.length, 1)
  const blocked = result.blocked[0] as BlockedDispatch
  assert.equal(blocked.reason, "group_cancelled")
  assert.equal(blocked.from.agentId, "范德彪")
  assert.equal(blocked.from.messageId, "msg-1")
  assert.equal(blocked.from.provider, "codex")
  assert.equal(blocked.to.agentId, "桂芬")
  assert.equal(blocked.to.provider, "gemini")
  assert.equal(blocked.sessionGroupId, "group-1")
  assert.ok(blocked.taskSnippet, "BlockedDispatch should have taskSnippet")
})

test("QueueEntry includes contextSnapshot from buildSnapshot callback", () => {
  const mockSnapshot: ContextMessage[] = [
    {
      id: "msg-0",
      role: "assistant",
      agentId: "范德彪",
      content: "Hello world",
      createdAt: new Date().toISOString(),
    },
    {
      id: "msg-1",
      role: "assistant",
      agentId: "桂芬",
      content: "Hi there",
      createdAt: new Date().toISOString(),
    },
  ]
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "msg-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手",
    matchMode: "anywhere",
    buildSnapshot: () => mockSnapshot,
    extractSnippet: (c: string) => c,
  })

  assert.equal(result.queued.length, 1)
  const entry = result.queued[0] as QueueEntry
  assert.deepEqual(entry.contextSnapshot, mockSnapshot)
  assert.equal(entry.taskSnippet, "@桂芬 请接手")
})

// ===== Phase 2: Per-Slot Concurrency & Invocation-Scoped Dedup =====

test("takeNextQueuedDispatch skips busy provider and returns next available", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  // Queue entries for gemini and claude
  dispatch.enqueuePublicMentions({
    messageId: "msg-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 @黄仁勋 请接手",
    matchMode: "anywhere",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  // Mark gemini as busy
  assert.equal(dispatch.acquireSlot("group-1", "gemini"), true)

  // takeNext should skip gemini and return claude
  const next = dispatch.takeNextQueuedDispatch("group-1")
  assert.ok(next)
  assert.equal(next.to.provider, "claude")
})

test("per-slot lock allows different providers to run concurrently", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)

  assert.equal(dispatch.acquireSlot("group-1", "codex"), true)
  assert.equal(dispatch.acquireSlot("group-1", "claude"), true)
})

test("per-slot lock blocks same provider from running twice", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)

  assert.equal(dispatch.acquireSlot("group-1", "codex"), true)
  assert.equal(dispatch.acquireSlot("group-1", "codex"), false)
})

test("releaseSlot allows provider to be dispatched again", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)

  assert.equal(dispatch.acquireSlot("group-1", "codex"), true)
  dispatch.releaseSlot("group-1", "codex")
  assert.equal(dispatch.acquireSlot("group-1", "codex"), true)
})

test("invocation-scoped dedup: same provider in different invocation chains is allowed", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  // Enqueue from parentInvocationId=A targeting gemini
  const resultA = dispatch.enqueuePublicMentions({
    messageId: "msg-a",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手",
    matchMode: "anywhere",
    parentInvocationId: "inv-A",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  // Enqueue from parentInvocationId=B targeting gemini
  const resultB = dispatch.enqueuePublicMentions({
    messageId: "msg-b",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请继续",
    matchMode: "anywhere",
    parentInvocationId: "inv-B",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(resultA.queued.length, 1)
  assert.equal(resultB.queued.length, 1, "Different invocation chain should allow same provider")
})

test("invocation-scoped dedup: same provider in same invocation chain is blocked", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  // First enqueue from parentInvocationId=A targeting gemini
  const result1 = dispatch.enqueuePublicMentions({
    messageId: "msg-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手",
    matchMode: "anywhere",
    parentInvocationId: "inv-A",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  // Second enqueue from same parentInvocationId=A targeting gemini
  const result2 = dispatch.enqueuePublicMentions({
    messageId: "msg-2",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请继续",
    matchMode: "anywhere",
    parentInvocationId: "inv-A",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(result1.queued.length, 1)
  assert.equal(result2.queued.length, 0, "Same invocation chain should block duplicate provider")
})

test("user-initiated multi-mention includes panel provider in queue", () => {
  // Regression: user @s 3 agents from claude panel. Old logic skipped sourceProvider=claude,
  // so parallel group only had 2 targets. claude ran as directTurn outside the group, and
  // fan-in fired after 2/3 completed while the 3rd was still thinking. Fix: when user
  // initiates with 2+ mentions, include sourceProvider in the queue so it joins the group.
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "user-msg",
    sessionGroupId: "group-1",
    sourceProvider: "claude", // panel thread is claude/黄仁勋
    sourceAlias: "user",
    rootMessageId: "root-1",
    content: "@黄仁勋 @范德彪 @桂芬 一起想",
    matchMode: "anywhere",
    parentInvocationId: null,
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(result.queued.length, 3, "all 3 mentioned providers should queue")
  const queuedProviders = result.queued.map((e) => e.to.provider).sort()
  assert.deepEqual(queuedProviders, ["claude", "codex", "gemini"])
})

test("user-initiated single-mention still skips sourceProvider", () => {
  // Single-@ case: user sends from claude panel to @范德彪 only. sourceProvider (claude)
  // is not mentioned, so nothing to skip. Just verifying the fan-out carve-out doesn't
  // break single-mention routing.
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "user-msg",
    sessionGroupId: "group-1",
    sourceProvider: "claude",
    sourceAlias: "user",
    rootMessageId: "root-1",
    content: "@范德彪 帮个忙",
    matchMode: "anywhere",
    parentInvocationId: null,
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(result.queued.length, 1)
  assert.equal(result.queued[0].to.provider, "codex")
})

test("agent-initiated multi-mention still skips sourceProvider", () => {
  // Agent fan-out should not loop back to itself — keep existing skip behavior.
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  dispatch.registerUserRoot("root-1", "group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "agent-msg",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@范德彪 @黄仁勋 @桂芬",
    matchMode: "anywhere",
    parentInvocationId: "inv-A",
    buildSnapshot: stubBuildSnapshot,
    extractSnippet: stubExtractSnippet,
  })

  assert.equal(result.queued.length, 2, "agent should not self-dispatch")
  const queuedProviders = result.queued.map((e) => e.to.provider).sort()
  assert.deepEqual(queuedProviders, ["claude", "gemini"])
})
