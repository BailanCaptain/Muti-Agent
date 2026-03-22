import assert from "node:assert/strict"
import test from "node:test"
import { DispatchOrchestrator } from "./dispatch"

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

test("dedupes the same target provider across different messages within one root chain", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, {
    codex: "范德彪",
    claude: "黄仁勋",
    gemini: "桂芬",
  })

  dispatch.registerUserRoot("root-1", "group-1")

  const fromUserMessage = dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手",
    matchMode: "anywhere",
  })

  const fromAssistantMessage = dispatch.enqueuePublicMentions({
    messageId: "assistant-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请继续",
    matchMode: "line-start",
  })

  assert.equal(fromUserMessage.queued.length, 1)
  assert.equal(fromAssistantMessage.queued.length, 0)
  assert.equal(dispatch.takeNextQueuedDispatch("group-1", new Set())?.targetProvider, "gemini")
  assert.equal(dispatch.takeNextQueuedDispatch("group-1", new Set()), null)
})

test("cancels a session group barrier, clears queued hops, and blocks later mentions until the next user root", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, {
    codex: "范德彪",
    claude: "黄仁勋",
    gemini: "桂芬",
  })

  dispatch.registerUserRoot("root-1", "group-1")
  const firstQueue = dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@桂芬 请接手",
    matchMode: "anywhere",
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
  })

  assert.equal(firstQueue.queued.length, 1)
  assert.equal(cancelled.clearedCount, 1)
  assert.equal(dispatch.hasQueuedDispatches("group-1"), false)
  assert.equal(dispatch.isSessionGroupCancelled("group-1"), true)
  assert.equal(blocked.queued.length, 0)
  assert.deepEqual(
    blocked.blocked.map((entry) => ({
      reason: entry.reason,
      targetProvider: entry.targetProvider,
    })),
    [{ reason: "group_cancelled", targetProvider: "gemini" }],
  )
  assert.equal(dispatch.takeNextQueuedDispatch("group-1", new Set()), null)

  dispatch.registerUserRoot("root-2", "group-1")

  assert.equal(dispatch.isSessionGroupCancelled("group-1"), false)
})

test("cancelSessionGroup invalidates all active invocations via registry", () => {
  const cancelledIds: string[] = []
  const mockRegistry = {
    invalidateInvocation: (id: string) => { cancelledIds.push(id) },
  }

  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, {
    codex: "范德彪",
    claude: "黄仁勋",
    gemini: "桂芬",
  }, mockRegistry)

  dispatch.registerUserRoot("root-1", "group-1")
  dispatch.bindInvocation("inv-a", { rootMessageId: "root-1", sessionGroupId: "group-1", sourceProvider: "claude" })
  dispatch.bindInvocation("inv-b", { rootMessageId: "root-1", sessionGroupId: "group-1", sourceProvider: "codex" })

  const result = dispatch.cancelSessionGroup("group-1")

  assert.equal(result.cancelledActiveCount, 2)
  assert.equal(cancelledIds.length, 2)
  assert.ok(cancelledIds.includes("inv-a"))
  assert.ok(cancelledIds.includes("inv-b"))
})

test("releaseInvocation removes invocation from active tracking before cancel", () => {
  const cancelledIds: string[] = []
  const mockRegistry = { invalidateInvocation: (id: string) => { cancelledIds.push(id) } }

  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, {
    codex: "范德彪",
    claude: "黄仁勋",
    gemini: "桂芬",
  }, mockRegistry)

  dispatch.registerUserRoot("root-1", "group-1")
  dispatch.bindInvocation("inv-a", { rootMessageId: "root-1", sessionGroupId: "group-1", sourceProvider: "claude" })
  dispatch.bindInvocation("inv-b", { rootMessageId: "root-1", sessionGroupId: "group-1", sourceProvider: "codex" })

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
    aliases[`p${i}`] = `Provider ${i}`
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
  })

  assert.equal(result.queued.length, 0, "16th hop should be blocked by MAX_HOPS")
  assert.equal(result.blocked.length, 0, "Should not be blocked by barrier, just ignored")
})
