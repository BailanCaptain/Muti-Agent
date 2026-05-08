/**
 * F026 P2 Step 1A.2 · handleSendMessage 入口 wire 集成测试
 *
 * 锁住的契约（plan §Step 1）：
 *   user 在 thread 里发消息 → message-service 必须建 user-root call（issuerId="user",
 *   parentCallId=null）作为整棵 call tree 的源点；directTurn 路径下还要建 child call
 *   挂在 user-root 下，让 thread agent 自己回复也在 tree 上有节点（runThreadTurn 通过
 *   dispatchedCallId 透传后续 advance/settle/cleanup）。
 *
 * R-080 实证：在 1A.2 之前，user 入口不建任何 call，所有 mention 派发的 child call
 * 全是 orphan root —— 链尾闭环时无锚点回追 user，续推机制（Step 1B）也没 attach 点。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { Provider, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { CallRegistry } from "../orchestrator/call-registry"
import { DispatchOrchestrator } from "../orchestrator/dispatch"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { WorklistRegistry } from "../orchestrator/worklist-registry"
import { A2ALifecycleService } from "./a2a-lifecycle"
import { MessageService } from "./message-service"
import { WorklistExecutor } from "./worklist-executor"

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
      id: "thread-claude",
      sessionGroupId: "group-1",
      provider: "claude",
      alias: "Reviewer",
      currentModel: null,
      nativeSessionId: null,
    },
    {
      id: "thread-codex",
      sessionGroupId: "group-1",
      provider: "codex",
      alias: "Coder",
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
    isSessionGroupSendable: () => ({ sendable: true as const }),
    findThread: (threadId: string) => threads.find((t) => t.id === threadId) ?? null,
    findThreadByGroupAndProvider: (sessionGroupId: string, provider: Provider) =>
      threads.find((t) => t.sessionGroupId === sessionGroupId && t.provider === provider) ?? null,
    listGroupThreads: (sessionGroupId: string) =>
      threads.filter((t) => t.sessionGroupId === sessionGroupId),
    appendUserMessage: (threadId: string, content: string) => ({
      id: `user-${threadId}-${Date.now()}`,
      threadId,
      role: "user" as const,
      content,
      thinking: "",
      createdAt: new Date().toISOString(),
    }),
    appendAssistantMessage: (threadId: string) => ({
      id: `assistant-${threadId}-${Date.now()}`,
      threadId,
      role: "assistant" as const,
      content: "",
      thinking: "",
      createdAt: new Date().toISOString(),
    }),
    toTimelineMessage: (threadId: string, messageId: string) => ({
      id: messageId,
      provider: threads.find((t) => t.id === threadId)?.provider ?? "claude",
      alias: threads.find((t) => t.id === threadId)?.alias ?? "Reviewer",
      role: messageId.startsWith("user-") ? ("user" as const) : ("assistant" as const),
      content: "content",
      model: null,
      createdAt: new Date().toISOString(),
    }),
    overwriteMessage: () => {},
    updateThread: () => {},
    flushSessionPending: () => ({}),
    getActiveGroup: (groupId: string) => ({
      id: groupId,
      title: "Test Group",
      meta: "",
      timeline: [],
      hasPendingDispatches: false,
      dispatchBarrierActive: false,
      providers: {
        claude: {
          threadId: "thread-claude",
          alias: "Reviewer",
          currentModel: null,
          quotaSummary: "",
          preview: "",
          running: false,
        },
        codex: {
          threadId: "thread-codex",
          alias: "Coder",
          currentModel: null,
          quotaSummary: "",
          preview: "",
          running: false,
        },
        gemini: {
          threadId: "thread-gemini",
          alias: "Designer",
          currentModel: null,
          quotaSummary: "",
          preview: "",
          running: false,
        },
      },
    }),
    isFirstSnapshot: () => true,
    getActiveGroupDelta: () => ({
      newMessages: [],
      removedMessageIds: [],
      providers: {},
      invocationStats: [],
    }),
  }
}

function makeHarness(opts?: { wireWorklist?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-1a2-msgsvc-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  const registry = new CallRegistry({ db: store.db })
  const lifecycle = new A2ALifecycleService(registry)
  const worklistRegistry = new WorklistRegistry({ db: store.db })

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
  messageService.setA2ALifecycle(lifecycle)

  let worklistExecutor: WorklistExecutor | null = null
  if (opts?.wireWorklist) {
    worklistExecutor = new WorklistExecutor({
      callRegistry: registry,
      worklistRegistry,
    })
    messageService.setWorklistExecutor(worklistExecutor)
  }

  // Pre-fill invocations for thread-claude so runThreadTurn line 961 early-returns
  // (`thread.alias 已经在运行中`) without spawning a real CLI. handleSendMessage's
  // sync wire (openRootCall + openCall + dispatchedCallId pass-through) still runs —
  // the assertions below validate exactly that.
  const preIdentity = invocations.createInvocation("thread-claude", "Reviewer")
  invocations.attachRun("thread-claude", preIdentity.invocationId, {
    cancel: () => {},
    promise: new Promise(() => {}), // never resolves
  })

  return {
    store,
    registry,
    lifecycle,
    worklistRegistry,
    worklistExecutor,
    dispatch,
    invocations,
    messageService,
    close: () => {
      try {
        store.db.close()
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

test("F026 P2 1A.2 · handleSendMessage builds user-root call (issuerId='user', parentCallId=null)", async () => {
  const h = makeHarness()
  try {
    const events: RealtimeServerEvent[] = []
    h.messageService.handleClientEvent(
      {
        type: "send_message",
        payload: {
          threadId: "thread-claude",
          provider: "claude",
          alias: "Reviewer",
          content: "hello reviewer no mention here",
        },
      },
      (e) => events.push(e),
    )

    // Let handleSendMessage's sync portion + runThreadTurn microtask flush
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const rows = h.store.db
      .prepare(
        "SELECT call_id, parent_call_id, root_call_id, issuer_id, status, session_group_id FROM a2a_calls ORDER BY created_at ASC, rowid ASC",
      )
      .all() as Array<{
      call_id: string
      parent_call_id: string | null
      root_call_id: string
      issuer_id: string
      status: string
      session_group_id: string
    }>

    assert.ok(rows.length >= 1, "must build at least the user-root call")

    const userRoot = rows[0]
    assert.equal(userRoot.parent_call_id, null, "user-root has no parent")
    assert.equal(userRoot.root_call_id, userRoot.call_id, "user-root self-references as root")
    assert.equal(userRoot.issuer_id, "user", "user-root issuer is 'user'")
    assert.equal(userRoot.session_group_id, "group-1")
    assert.equal(userRoot.status, "pending")
  } finally {
    h.close()
  }
})

test("F026 P2 1A.2 · handleSendMessage in directTurn path also builds child call linked to user-root", async () => {
  const h = makeHarness()
  try {
    const events: RealtimeServerEvent[] = []
    h.messageService.handleClientEvent(
      {
        type: "send_message",
        payload: {
          threadId: "thread-claude",
          provider: "claude",
          alias: "Reviewer",
          content: "no mention — direct turn path",
        },
      },
      (e) => events.push(e),
    )

    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const rows = h.store.db
      .prepare(
        "SELECT call_id, parent_call_id, root_call_id, issuer_id FROM a2a_calls ORDER BY created_at ASC, rowid ASC",
      )
      .all() as Array<{
      call_id: string
      parent_call_id: string | null
      root_call_id: string
      issuer_id: string
    }>

    assert.equal(
      rows.length,
      2,
      "directTurn path must produce exactly 2 calls: user-root + directTurn child",
    )

    const userRoot = rows[0]
    const directTurnChild = rows[1]

    assert.equal(userRoot.parent_call_id, null)
    assert.equal(userRoot.root_call_id, userRoot.call_id)
    assert.equal(userRoot.issuer_id, "user")

    assert.equal(
      directTurnChild.parent_call_id,
      userRoot.call_id,
      "directTurn child must link to user-root as parent",
    )
    assert.equal(
      directTurnChild.root_call_id,
      userRoot.call_id,
      "directTurn child shares user-root as rootCallId (call tree 接通)",
    )
    assert.equal(
      directTurnChild.issuer_id,
      "user",
      "directTurn issuer is 'user' (user dispatches thread agent to reply)",
    )
  } finally {
    h.close()
  }
})

test("F026 P2 1A.2 · without setA2ALifecycle, handleSendMessage path stays identical to pre-1A.2 (zero a2a_calls writes)", async () => {
  // Regression guard: existing message-service tests that don't wire lifecycle must
  // continue to pass. The optional-chained openRootCall / openCall + parentCallId
  // pass-through must be a no-op when a2aLifecycle is null.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-1a2-noLifecycle-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  try {
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
    // intentionally NOT calling setA2ALifecycle

    const preIdentity = invocations.createInvocation("thread-claude", "Reviewer")
    invocations.attachRun("thread-claude", preIdentity.invocationId, {
      cancel: () => {},
      promise: new Promise(() => {}),
    })

    // Bootstrap a2a_calls schema in this DB so a SELECT later doesn't blow up if
    // lifecycle were (incorrectly) writing through some other code path.
    new CallRegistry({ db: store.db })

    const events: RealtimeServerEvent[] = []
    messageService.handleClientEvent(
      {
        type: "send_message",
        payload: {
          threadId: "thread-claude",
          provider: "claude",
          alias: "Reviewer",
          content: "no lifecycle wired",
        },
      },
      (e) => events.push(e),
    )
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const count = (
      store.db.prepare("SELECT COUNT(*) AS n FROM a2a_calls").get() as { n: number }
    ).n
    assert.equal(count, 0, "without lifecycle wired, no a2a_calls rows must be written")
  } finally {
    try {
      store.db.close()
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

test("F026 P2 v2 review#1 · user 入口含 mention 时同步注册 root worklist (parent=userRootCall, items=enqueueResult.queued aliases)", async () => {
  // 范德彪 review P1 finding：handleSendMessage user 入口 enqueuePublicMentions 后只透
  // parentCallId 给 gateway，没有调 worklistExecutor.registerForDispatch —— root worklist
  // 缺失，后续 onChildFinished 找 worklist 必空 → cascade 死锁，drain-based settle 失效。
  //
  // 修复：在 enqueueResult.queued.length > 0 时，user 入口也走一遍 registerForDispatch
  // 把 root worklist 写进 a2a_worklists（parent=userRootCall, items=queued aliases）。
  const h = makeHarness({ wireWorklist: true })
  try {
    h.messageService.handleClientEvent(
      {
        type: "send_message",
        payload: {
          threadId: "thread-claude",
          provider: "claude",
          alias: "Reviewer",
          content: "@Coder 修一下这个 bug",
        },
      },
      () => {},
    )
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // user-root call 应该已经建好（issuer=user, parent=null）
    const callRows = h.store.db
      .prepare(
        "SELECT call_id, parent_call_id, issuer_id FROM a2a_calls WHERE parent_call_id IS NULL",
      )
      .all() as Array<{ call_id: string; parent_call_id: string | null; issuer_id: string }>
    assert.equal(callRows.length, 1, "user-root call 必须建（前置）")
    const userRootCallId = callRows[0]!.call_id

    // 关键断言：root worklist 必须已注册，parentCallId=userRootCallId, parentWorklistId=null
    const rootWl = h.worklistRegistry.findActiveByParentCallId(userRootCallId)
    assert.ok(rootWl, "user 入口含 mention → 必须注册 root worklist 挂在 user-root call 下")
    assert.equal(
      rootWl!.parentWorklistId,
      null,
      "user 入口注册的是 root worklist (parentWorklistId IS NULL)",
    )
    assert.equal(rootWl!.rootCallId, userRootCallId, "rootCallId 链回 user-root")
    assert.equal(rootWl!.status, "active")
    assert.deepEqual(
      rootWl!.items.map((it) => it.alias),
      ["Coder"],
      "items 来自 enqueueResult.queued（user @Coder → Coder）",
    )
    assert.deepEqual(
      rootWl!.items.map((it) => it.status),
      ["pending"],
      "items 初始全 pending",
    )
  } finally {
    h.close()
  }
})

test("F026 P2 v2 review#1 · user 入口无 mention 时不注册 worklist（避免空 worklist 污染）", async () => {
  // registerForDispatch 内部 queued 空 → 早退 return null，不写 a2a_worklists。
  // 这是范德彪 review 修复的副作用兜底：避免 user 单纯 directTurn（无 mention）也注册 worklist。
  const h = makeHarness({ wireWorklist: true })
  try {
    h.messageService.handleClientEvent(
      {
        type: "send_message",
        payload: {
          threadId: "thread-claude",
          provider: "claude",
          alias: "Reviewer",
          content: "no mention here, plain directTurn",
        },
      },
      () => {},
    )
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const wlCount = (
      h.store.db.prepare("SELECT COUNT(*) AS n FROM a2a_worklists").get() as { n: number }
    ).n
    assert.equal(wlCount, 0, "无 mention → 0 worklist 写入")
  } finally {
    h.close()
  }
})
