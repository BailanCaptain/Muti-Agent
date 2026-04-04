import assert from "node:assert/strict"
import test from "node:test"
import type { Provider, RealtimeServerEvent } from "@multi-agent/shared"
import { DispatchOrchestrator } from "../orchestrator/dispatch"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { MessageService } from "./message-service"

type ThreadRecord = {
  id: string
  sessionGroupId: string
  provider: Provider
  alias: string
  currentModel: string | null
  nativeSessionId: string | null
}

function createThreads(): ThreadRecord[] {
  return [
    {
      id: "thread-codex",
      sessionGroupId: "group-1",
      provider: "codex",
      alias: "Coder",
      currentModel: null,
      nativeSessionId: null,
    },
    {
      id: "thread-claude",
      sessionGroupId: "group-1",
      provider: "claude",
      alias: "Reviewer",
      currentModel: null,
      nativeSessionId: null,
    },
    {
      id: "thread-gemini",
      sessionGroupId: "group-1",
      provider: "gemini",
      alias: "Designer",
      currentModel: null,
      nativeSessionId: null,
    },
  ]
}

function createSessionsStub(threads: ThreadRecord[]) {
  return {
    findThread: (threadId: string) => threads.find((thread) => thread.id === threadId) ?? null,
    findThreadByGroupAndProvider: (sessionGroupId: string, provider: Provider) =>
      threads.find(
        (thread) => thread.sessionGroupId === sessionGroupId && thread.provider === provider,
      ) ?? null,
    listGroupThreads: (sessionGroupId: string) =>
      threads.filter((thread) => thread.sessionGroupId === sessionGroupId),
    appendUserMessage: (threadId: string, content: string) => ({
      id: `user-${threadId}`,
      threadId,
      role: "user" as const,
      content,
      thinking: "",
      createdAt: new Date().toISOString(),
    }),
    appendAssistantMessage: (threadId: string, content: string, thinking = "") => ({
      id: `assistant-${threadId}`,
      threadId,
      role: "assistant" as const,
      content,
      thinking,
      createdAt: new Date().toISOString(),
    }),
    toTimelineMessage: (threadId: string, messageId: string) => ({
      id: messageId,
      provider: threads.find((thread) => thread.id === threadId)?.provider ?? "codex",
      alias: threads.find((thread) => thread.id === threadId)?.alias ?? "Coder",
      role: messageId.startsWith("user-") ? ("user" as const) : ("assistant" as const),
      content: "content",
      model: null,
      createdAt: new Date().toISOString(),
    }),
    overwriteMessage: () => {},
    updateThread: () => {},
    getActiveGroup: (
      groupId: string,
      runningThreadIds: Set<string>,
      dispatchState?: { hasPendingDispatches: boolean; dispatchBarrierActive: boolean },
    ) => ({
      id: groupId,
      title: "Test Group",
      meta: "meta",
      timeline: [],
      hasPendingDispatches: dispatchState?.hasPendingDispatches ?? false,
      dispatchBarrierActive: dispatchState?.dispatchBarrierActive ?? false,
      providers: {
        codex: {
          threadId: "thread-codex",
          alias: "Coder",
          currentModel: null,
          quotaSummary: "",
          preview: "",
          running: runningThreadIds.has("thread-codex"),
        },
        claude: {
          threadId: "thread-claude",
          alias: "Reviewer",
          currentModel: null,
          quotaSummary: "",
          preview: "",
          running: runningThreadIds.has("thread-claude"),
        },
        gemini: {
          threadId: "thread-gemini",
          alias: "Designer",
          currentModel: null,
          quotaSummary: "",
          preview: "",
          running: runningThreadIds.has("thread-gemini"),
        },
      },
    }),
  }
}

function createMessageService() {
  const threads = createThreads()
  const sessions = createSessionsStub(threads)
  const dispatch = new DispatchOrchestrator(sessions as never, {
    codex: "Coder",
    claude: "Reviewer",
    gemini: "Designer",
  })
  const invocations = new InvocationRegistry<{
    cancel: () => void
    promise: Promise<{
      content: string
      currentModel: string | null
      nativeSessionId: string | null
      exitCode: number | null
    }>
  }>()
  const messageService = new MessageService(
    sessions as never,
    dispatch,
    invocations as never,
    { emit() {} } as never,
    "http://localhost:8787",
  )

  return { dispatch, invocations, messageService }
}

test("cancelThreadChain revokes callback identities and clears invocation contexts immediately", () => {
  const { dispatch, invocations, messageService } = createMessageService()
  dispatch.registerUserRoot("root-1", "group-1")
  dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "Coder",
    rootMessageId: "root-1",
    content: "@Designer please continue",
    matchMode: "anywhere",
  })

  const codexIdentity = invocations.createInvocation("thread-codex", "Coder")
  const geminiIdentity = invocations.createInvocation("thread-gemini", "Designer")
  dispatch.bindInvocation(codexIdentity.invocationId, {
    rootMessageId: "root-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    parentInvocationId: null,
  })
  dispatch.bindInvocation(geminiIdentity.invocationId, {
    rootMessageId: "root-1",
    sessionGroupId: "group-1",
    sourceProvider: "gemini",
    parentInvocationId: null,
  })
  const cancelCalls: string[] = []

  invocations.attachRun("thread-codex", codexIdentity.invocationId, {
    cancel: () => cancelCalls.push("thread-codex"),
    promise: Promise.resolve({
      content: "",
      currentModel: null,
      nativeSessionId: null,
      exitCode: 0,
    }),
  })
  invocations.attachRun("thread-gemini", geminiIdentity.invocationId, {
    cancel: () => cancelCalls.push("thread-gemini"),
    promise: Promise.resolve({
      content: "",
      currentModel: null,
      nativeSessionId: null,
      exitCode: 0,
    }),
  })

  const events: RealtimeServerEvent[] = []
  const cancelled = messageService.cancelThreadChain("thread-codex", (event) => {
    events.push(event)
  })

  assert.equal(cancelled, true)
  assert.deepEqual(cancelCalls.sort(), ["thread-codex", "thread-gemini"])
  assert.equal(dispatch.hasQueuedDispatches("group-1"), false)
  assert.equal(dispatch.isSessionGroupCancelled("group-1"), true)
  assert.equal(
    invocations.verifyInvocation(codexIdentity.invocationId, codexIdentity.callbackToken),
    null,
  )
  assert.equal(
    invocations.verifyInvocation(geminiIdentity.invocationId, geminiIdentity.callbackToken),
    null,
  )
  assert.equal(dispatch.resolveInvocation(codexIdentity.invocationId), null)
  assert.equal(dispatch.resolveInvocation(geminiIdentity.invocationId), null)
  assert.ok(events.some((event) => event.type === "status"))
  assert.ok(
    events.some(
      (event) =>
        event.type === "thread_snapshot" &&
        event.payload.activeGroup.hasPendingDispatches === false &&
        event.payload.activeGroup.dispatchBarrierActive === true,
    ),
  )
})

test("handleAgentPublicMessage emits a dispatch-blocked event when the group barrier rejects a follow-up mention", async () => {
  const { dispatch, messageService } = createMessageService()
  dispatch.registerUserRoot("root-1", "group-1")
  dispatch.bindInvocation("invocation-1", {
    rootMessageId: "root-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    parentInvocationId: null,
  })
  dispatch.cancelSessionGroup("group-1")

  const events: RealtimeServerEvent[] = []
  await messageService.handleAgentPublicMessage({
    threadId: "thread-codex",
    messageId: "message-1",
    content: "@Designer please continue",
    invocationId: "invocation-1",
    emit: (event) => {
      events.push(event)
    },
  })

  assert.ok(
    events.some(
      (event) =>
        event.type === "dispatch.blocked" &&
        event.payload.attempts.some(
          (attempt) => attempt.reason === "group_cancelled" && attempt.to.provider === "gemini",
        ),
    ),
  )
})

test("handleSendMessage allows sending to a different provider while another is running (per-slot concurrency)", () => {
  const { dispatch, messageService, invocations } = createMessageService()

  // Simulate codex running by acquiring its slot
  dispatch.acquireSlot("group-1", "codex")
  const codexIdentity = invocations.createInvocation("thread-codex", "Coder")
  invocations.attachRun("thread-codex", codexIdentity.invocationId, {
    cancel: () => {},
    promise: new Promise(() => {}),
  })

  const events: RealtimeServerEvent[] = []
  messageService.handleClientEvent(
    {
      type: "send_message",
      payload: {
        threadId: "thread-claude",
        provider: "claude",
        alias: "Reviewer",
        content: "Hello Claude",
      },
    },
    (event) => {
      events.push(event)
    },
  )

  // Should NOT see a blocking status message since claude slot is free
  assert.ok(
    !events.some(
      (event) => event.type === "status" && event.payload.message.includes("已在此房间运行"),
    ),
  )
})

test("handleSendMessage rejects when the same provider slot is busy", () => {
  const { dispatch, messageService, invocations } = createMessageService()

  // Simulate claude running by acquiring its slot
  dispatch.acquireSlot("group-1", "claude")

  const events: RealtimeServerEvent[] = []
  messageService.handleClientEvent(
    {
      type: "send_message",
      payload: {
        threadId: "thread-claude",
        provider: "claude",
        alias: "Reviewer",
        content: "Hello Claude",
      },
    },
    (event) => {
      events.push(event)
    },
  )

  assert.ok(
    events.some(
      (event) => event.type === "status" && event.payload.message.includes("已经在运行中"),
    ),
  )
})
