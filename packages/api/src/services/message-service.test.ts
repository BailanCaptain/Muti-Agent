import assert from "node:assert/strict"
import test from "node:test"
import type { Provider, RealtimeServerEvent } from "@multi-agent/shared"
import { ChainStarterResolver } from "../orchestrator/chain-starter-resolver"
import { DecisionBoard, type DecisionBoardEntry } from "../orchestrator/decision-board"
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

type SendableState =
  | { sendable: true }
  | { sendable: false; reason: "archived" | "deleted" }

function createSessionsStub(
  threads: ThreadRecord[],
  opts: { sendable?: SendableState } = {},
) {
  return {
    isSessionGroupSendable: (_groupId: string): SendableState =>
      opts.sendable ?? { sendable: true },
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
    isFirstSnapshot: () => true,
    getActiveGroupDelta: () => ({ newMessages: [], removedMessageIds: [], providers: {}, invocationStats: [] }),
  }
}

function createMessageService(opts: { sendable?: SendableState } = {}) {
  const threads = createThreads()
  const sessions = createSessionsStub(threads, opts)
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

// ── review 2nd round P1: 服务端 archived/deleted send guard ──────────

test("review P1: handleSendMessage rejects when session group is archived", () => {
  const { messageService } = createMessageService({
    sendable: { sendable: false, reason: "archived" },
  })

  const events: RealtimeServerEvent[] = []
  messageService.handleClientEvent(
    {
      type: "send_message",
      payload: {
        threadId: "thread-claude",
        provider: "claude",
        alias: "Reviewer",
        content: "这条消息不该进去",
      },
    },
    (event) => {
      events.push(event)
    },
  )

  const status = events.find((e) => e.type === "status")
  assert.ok(status, "应发 status 通知用户")
  assert.ok(
    status.payload.message.includes("归档") || status.payload.message.includes("archived"),
    `status 应提示归档原因，实际: ${status.payload.message}`,
  )
  // 没有真正写入消息 — 不应看到 message.created
  assert.ok(
    !events.some((e) => e.type === "message.created"),
    "归档会话不应落库 message.created",
  )
})

test("review P1: handleSendMessage rejects when session group is soft-deleted", () => {
  const { messageService } = createMessageService({
    sendable: { sendable: false, reason: "deleted" },
  })

  const events: RealtimeServerEvent[] = []
  messageService.handleClientEvent(
    {
      type: "send_message",
      payload: {
        threadId: "thread-claude",
        provider: "claude",
        alias: "Reviewer",
        content: "这条消息不该进去",
      },
    },
    (event) => {
      events.push(event)
    },
  )

  const status = events.find((e) => e.type === "status")
  assert.ok(status, "应发 status 通知用户")
  assert.ok(
    status.payload.message.includes("删除") || status.payload.message.includes("deleted"),
    `status 应提示删除原因，实际: ${status.payload.message}`,
  )
  assert.ok(
    !events.some((e) => e.type === "message.created"),
    "软删会话不应落库 message.created",
  )
})

// ── F002: Decision Board integration ─────────────────────────────────

test("collectDecisionsIntoBoard routes [拍板] items into DecisionBoard (no emit)", () => {
  const { messageService } = createMessageService()
  const board = new DecisionBoard()
  messageService.setDecisionBoard(board)

  const emitted: RealtimeServerEvent[] = []
  messageService.collectDecisionsIntoBoard(
    {
      id: "thread-claude",
      provider: "claude",
      alias: "Reviewer",
      sessionGroupId: "group-1",
    },
    "msg-1",
    "这是我的回答\n[拍板] 数据库用 PG 吗\n[A] 是\n[B] 否",
    (event) => emitted.push(event),
  )

  assert.equal(board.size("group-1"), 1)
  assert.equal(
    emitted.filter((e) => e.type === "decision.request").length,
    0,
    "inline [拍板] must NOT emit decision.request (board holds it instead)",
  )
  const entries = board.getPending("group-1")
  assert.equal(entries[0].question, "数据库用 PG 吗")
  assert.equal(entries[0].options.length, 2)
})

test("collectDecisionsIntoBoard with [撤销拍板] removes matching board entry", () => {
  const { messageService } = createMessageService()
  const board = new DecisionBoard()
  messageService.setDecisionBoard(board)

  board.add({
    sessionGroupId: "group-1",
    raiser: {
      threadId: "thread-claude",
      provider: "claude",
      alias: "Reviewer",
      raisedAt: "2026-04-10T10:00:00Z",
    },
    question: "数据库选型问题",
    options: [],
  })
  assert.equal(board.size("group-1"), 1)

  messageService.collectDecisionsIntoBoard(
    {
      id: "thread-claude",
      provider: "claude",
      alias: "Reviewer",
      sessionGroupId: "group-1",
    },
    "msg-2",
    "和 Coder 讨论后\n[撤销拍板] 数据库",
    () => {},
  )

  assert.equal(board.size("group-1"), 0)
})

test("collectDecisionsIntoBoard is no-op when no DecisionBoard attached", () => {
  const { messageService } = createMessageService()
  const emitted: RealtimeServerEvent[] = []
  messageService.collectDecisionsIntoBoard(
    {
      id: "thread-claude",
      provider: "claude",
      alias: "Reviewer",
      sessionGroupId: "group-1",
    },
    "msg-3",
    "[拍板] 无 board 时也不应抛错",
    (event) => emitted.push(event),
  )
  assert.equal(
    emitted.filter((e) => e.type === "decision.request").length,
    0,
    "must not fall back to old direct-emit path",
  )
})

test("flushDecisionBoard drains the board, stashes entries, and emits one decision.board_flush event", () => {
  const { messageService } = createMessageService()
  const board = new DecisionBoard()
  messageService.setDecisionBoard(board)

  const broadcasts: RealtimeServerEvent[] = []
  messageService.setBroadcaster((event) => broadcasts.push(event))

  board.add({
    sessionGroupId: "group-1",
    raiser: {
      threadId: "thread-claude",
      provider: "claude",
      alias: "Reviewer",
      raisedAt: "2026-04-10T10:00:00Z",
    },
    question: "数据库用 PG 吗",
    options: [
      { id: "opt_0", label: "是" },
      { id: "opt_1", label: "否" },
    ],
  })
  board.add({
    sessionGroupId: "group-1",
    raiser: {
      threadId: "thread-codex",
      provider: "codex",
      alias: "Coder",
      raisedAt: "2026-04-10T10:00:10Z",
    },
    question: "要不要加 Redis 缓存",
    options: [],
  })

  messageService.flushDecisionBoard("group-1")

  assert.equal(board.size("group-1"), 0, "board must be drained after flush")

  const flushEvents = broadcasts.filter((e) => e.type === "decision.board_flush")
  assert.equal(flushEvents.length, 1, "exactly one board_flush event must be emitted")

  const payload = (flushEvents[0] as Extract<RealtimeServerEvent, { type: "decision.board_flush" }>)
    .payload
  assert.equal(payload.sessionGroupId, "group-1")
  assert.equal(payload.items.length, 2)
  assert.ok(payload.flushedAt, "flushedAt must be populated")

  for (const item of payload.items) {
    assert.ok(item.id)
    assert.ok(item.question)
    assert.ok(Array.isArray(item.options))
    assert.ok(Array.isArray(item.raisers))
    assert.ok(item.firstRaisedAt)
  }

  assert.equal(
    messageService.getPendingFlushEntries("group-1")?.length,
    2,
    "flushed entries must be stashed for the respond handler",
  )
})

test("flushDecisionBoard is a no-op when the board has no pending entries", () => {
  const { messageService } = createMessageService()
  const board = new DecisionBoard()
  messageService.setDecisionBoard(board)
  const broadcasts: RealtimeServerEvent[] = []
  messageService.setBroadcaster((event) => broadcasts.push(event))

  messageService.flushDecisionBoard("group-empty")

  assert.equal(
    broadcasts.filter((e) => e.type === "decision.board_flush").length,
    0,
    "empty board must not emit a flush event",
  )
  assert.equal(messageService.getPendingFlushEntries("group-empty"), undefined)
})

// ── F002 P2.T4: handleDecisionBoardRespond ──────────────────────────

function makeEntry(
  overrides: Partial<DecisionBoardEntry> & { id: string; question: string },
): DecisionBoardEntry {
  return {
    id: overrides.id,
    questionHash: overrides.questionHash ?? `h-${overrides.id}`,
    question: overrides.question,
    options: overrides.options ?? [],
    raisers: overrides.raisers ?? [
      {
        threadId: "thread-claude",
        provider: "claude",
        alias: "Reviewer",
        raisedAt: "2026-04-10T10:00:00Z",
      },
    ],
    sessionGroupId: overrides.sessionGroupId ?? "group-1",
    firstRaisedAt: overrides.firstRaisedAt ?? "2026-04-10T10:00:00Z",
    converged: overrides.converged ?? false,
  }
}

test("buildDecisionSummary formats option + custom choices with multi-raiser attribution", () => {
  const { messageService } = createMessageService()
  const entries: DecisionBoardEntry[] = [
    makeEntry({
      id: "e1",
      question: "数据库选型？",
      options: [
        { id: "A", label: "PG" },
        { id: "B", label: "Mongo" },
      ],
    }),
    makeEntry({
      id: "e2",
      question: "需要 Redis 缓存吗？",
      options: [{ id: "A", label: "是" }],
      raisers: [
        {
          threadId: "thread-claude",
          provider: "claude",
          alias: "Reviewer",
          raisedAt: "2026-04-10T10:00:00Z",
        },
        {
          threadId: "thread-codex",
          provider: "codex",
          alias: "Coder",
          raisedAt: "2026-04-10T10:00:05Z",
        },
      ],
    }),
  ]
  const summary = messageService.buildDecisionSummary(entries, [
    { itemId: "e1", choice: { kind: "option", optionId: "A" } },
    { itemId: "e2", choice: { kind: "custom", text: "暂时用内存" } },
  ])
  assert.ok(summary.includes("数据库选型？"))
  assert.ok(summary.includes("PG"))
  assert.ok(summary.includes("需要 Redis 缓存吗？"))
  assert.ok(summary.includes("暂时用内存"))
  assert.ok(
    summary.includes("Reviewer") && summary.includes("Coder"),
    "multi-raiser attribution missing",
  )
})

test("buildSkippedSummary mentions every question and lists raisers", () => {
  const { messageService } = createMessageService()
  const entries: DecisionBoardEntry[] = [
    makeEntry({ id: "e1", question: "Q1" }),
    makeEntry({
      id: "e2",
      question: "Q2",
      raisers: [
        {
          threadId: "thread-codex",
          provider: "codex",
          alias: "Coder",
          raisedAt: "2026-04-10T10:00:10Z",
        },
      ],
    }),
  ]
  const summary = messageService.buildSkippedSummary(entries)
  assert.ok(summary.includes("产品暂未"))
  assert.ok(summary.includes("Q1"))
  assert.ok(summary.includes("Q2"))
  assert.ok(summary.includes("Reviewer"))
  assert.ok(summary.includes("Coder"))
})

test("handleDecisionBoardRespond appends summary to chain-starter thread and emits resolved events", async () => {
  const { messageService, invocations } = createMessageService()

  const board = new DecisionBoard()
  messageService.setDecisionBoard(board)

  // Stub resolver that pins the target to thread-claude (the chain starter).
  const fakeResolver = new ChainStarterResolver({
    listThreadsByGroup: () => [
      { id: "thread-claude", provider: "claude", alias: "Reviewer", sessionGroupId: "group-1" },
      { id: "thread-codex", provider: "codex", alias: "Coder", sessionGroupId: "group-1" },
    ],
    listMessages: (threadId) => {
      if (threadId === "thread-claude") {
        return [
          {
            id: "m-user-1",
            role: "user",
            createdAt: "2026-04-10T10:00:00Z",
            threadId: "thread-claude",
          },
          {
            id: "m-claude-1",
            role: "assistant",
            createdAt: "2026-04-10T10:00:05Z",
            threadId: "thread-claude",
          },
        ]
      }
      if (threadId === "thread-codex") {
        return [
          {
            id: "m-codex-1",
            role: "assistant",
            createdAt: "2026-04-10T10:00:10Z",
            threadId: "thread-codex",
          },
        ]
      }
      return []
    },
    getThread: () => null,
  })
  messageService.setChainStarterResolver(fakeResolver)

  const broadcasts: RealtimeServerEvent[] = []
  messageService.setBroadcaster((event) => broadcasts.push(event))

  // Pre-acquire an active invocation on thread-claude so runThreadTurn exits
  // early with the "already running" status (we're testing the side-effects
  // before the real CLI turn spawn, not the spawn itself).
  const identity = invocations.createInvocation("thread-claude", "Reviewer")
  invocations.attachRun("thread-claude", identity.invocationId, {
    cancel: () => {},
    promise: new Promise(() => {}),
  })

  board.add({
    sessionGroupId: "group-1",
    raiser: {
      threadId: "thread-claude",
      provider: "claude",
      alias: "Reviewer",
      raisedAt: "2026-04-10T10:00:00Z",
    },
    question: "Q1",
    options: [{ id: "A", label: "PG" }],
  })
  board.add({
    sessionGroupId: "group-1",
    raiser: {
      threadId: "thread-codex",
      provider: "codex",
      alias: "Coder",
      raisedAt: "2026-04-10T10:00:10Z",
    },
    question: "Q2",
    options: [],
  })
  messageService.flushDecisionBoard("group-1")

  const e1Id = messageService.getPendingFlushEntries("group-1")?.[0]?.id
  const e2Id = messageService.getPendingFlushEntries("group-1")?.[1]?.id
  assert.ok(e1Id && e2Id)

  await messageService.handleDecisionBoardRespond({
    sessionGroupId: "group-1",
    decisions: [
      { itemId: e1Id!, choice: { kind: "option", optionId: "A" } },
      { itemId: e2Id!, choice: { kind: "custom", text: "走 B 方案" } },
    ],
  })

  assert.equal(
    messageService.getPendingFlushEntries("group-1"),
    undefined,
    "pending flush entries must be consumed after respond",
  )

  // Exactly two item_resolved events (one per entry).
  const resolved = broadcasts.filter((e) => e.type === "decision.board_item_resolved")
  assert.equal(resolved.length, 2)
  const resolvedIds = resolved.map(
    (e) =>
      (e as Extract<RealtimeServerEvent, { type: "decision.board_item_resolved" }>).payload.itemId,
  )
  assert.ok(resolvedIds.includes(e1Id!))
  assert.ok(resolvedIds.includes(e2Id!))

  // A user-role message.created was emitted on thread-claude (chain starter).
  // Our stub's toTimelineMessage hardcodes content to "content", so we check
  // on role + threadId rather than content; summary is verified by the pure
  // builder tests above.
  const userCreated = broadcasts.find(
    (e) =>
      e.type === "message.created" &&
      e.payload.threadId === "thread-claude" &&
      e.payload.message.role === "user",
  )
  assert.ok(userCreated, "expected a user message.created on thread-claude")
})

test("handleDecisionBoardRespond with skipped=true still consumes entries and emits resolved events", async () => {
  const { messageService, invocations } = createMessageService()
  const board = new DecisionBoard()
  messageService.setDecisionBoard(board)

  messageService.setChainStarterResolver(
    new ChainStarterResolver({
      listThreadsByGroup: () => [
        { id: "thread-claude", provider: "claude", alias: "Reviewer", sessionGroupId: "group-1" },
      ],
      listMessages: () => [
        {
          id: "m-user",
          role: "user",
          createdAt: "2026-04-10T10:00:00Z",
          threadId: "thread-claude",
        },
        {
          id: "m-a",
          role: "assistant",
          createdAt: "2026-04-10T10:00:05Z",
          threadId: "thread-claude",
        },
      ],
      getThread: () => null,
    }),
  )

  const broadcasts: RealtimeServerEvent[] = []
  messageService.setBroadcaster((event) => broadcasts.push(event))

  const identity = invocations.createInvocation("thread-claude", "Reviewer")
  invocations.attachRun("thread-claude", identity.invocationId, {
    cancel: () => {},
    promise: new Promise(() => {}),
  })

  board.add({
    sessionGroupId: "group-1",
    raiser: {
      threadId: "thread-claude",
      provider: "claude",
      alias: "Reviewer",
      raisedAt: "2026-04-10T10:00:00Z",
    },
    question: "Q1",
    options: [],
  })
  messageService.flushDecisionBoard("group-1")

  await messageService.handleDecisionBoardRespond({
    sessionGroupId: "group-1",
    decisions: [],
    skipped: true,
  })

  assert.equal(messageService.getPendingFlushEntries("group-1"), undefined)
  assert.equal(
    broadcasts.filter((e) => e.type === "decision.board_item_resolved").length,
    1,
  )
})

test("handleDecisionBoardRespond is a no-op when no flush is pending", async () => {
  const { messageService } = createMessageService()
  messageService.setDecisionBoard(new DecisionBoard())
  const broadcasts: RealtimeServerEvent[] = []
  messageService.setBroadcaster((e) => broadcasts.push(e))

  await messageService.handleDecisionBoardRespond({
    sessionGroupId: "group-nothing",
    decisions: [],
  })

  assert.equal(broadcasts.length, 0)
})

test("hasRunningTurn reflects dispatch slot state", () => {
  const { dispatch, messageService } = createMessageService()
  assert.equal(messageService.hasRunningTurn("group-1"), false)
  dispatch.acquireSlot("group-1", "codex")
  assert.equal(messageService.hasRunningTurn("group-1"), true)
  assert.equal(messageService.hasRunningTurn("group-2"), false)
  dispatch.releaseSlot("group-1", "codex")
  assert.equal(messageService.hasRunningTurn("group-1"), false)
})

test("buildDecisionSummary writes converged items as '已收敛' not '未决定'", () => {
  const { messageService } = createMessageService()
  const entries: DecisionBoardEntry[] = [
    makeEntry({ id: "e-conv", question: "数据库选型？", converged: true }),
    makeEntry({
      id: "e-div",
      question: "需要 Redis 吗？",
      options: [{ id: "A", label: "是" }, { id: "B", label: "否" }],
      converged: false,
    }),
  ]
  const summary = messageService.buildDecisionSummary(entries, [
    { itemId: "e-div", choice: { kind: "option", optionId: "A" } },
  ])
  assert.ok(
    summary.includes("已收敛"),
    "converged item must be labeled 已收敛",
  )
  assert.ok(
    !summary.includes("未决定"),
    "converged item must NOT be labeled 未决定",
  )
  assert.ok(summary.includes("是"), "divergent item decision must appear")
})
