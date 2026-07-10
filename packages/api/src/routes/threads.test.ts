import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { InvalidTimelineCursorError } from "../services/session-service"
import { registerThreadRoutes } from "./threads"
import { GroupSequencer } from "./ws-sequencer"

function makeSessionsStub(hasPendingDispatches = false) {
  return {
    listSessionGroups: () => [],
    listProviderCatalog: () => [],
    createSessionGroup: () => "group-new",
    findThread: (threadId: string) =>
      threadId === "thread-1"
        ? { id: "thread-1", sessionGroupId: "group-1", alias: "黄仁勋", nativeSessionId: null }
        : null,
    getActiveGroup: (
      groupId: string,
      _runningIds: Set<string>,
      dispatchState?: { hasPendingDispatches: boolean; dispatchBarrierActive: boolean },
    ) => ({
      id: groupId,
      title: "Test",
      meta: "",
      timeline: [],
      hasPendingDispatches: dispatchState?.hasPendingDispatches ?? false,
      dispatchBarrierActive: dispatchState?.dispatchBarrierActive ?? false,
      providers: {},
    }),
    getActiveGroupPage: (
      groupId: string,
      _runningIds: Set<string>,
      dispatchState?: { hasPendingDispatches: boolean; dispatchBarrierActive: boolean },
    ) => ({
      activeGroup: {
        id: groupId,
        roomId: null,
        title: "Test",
        meta: "",
        timeline: [],
        hasPendingDispatches: dispatchState?.hasPendingDispatches ?? false,
        dispatchBarrierActive: dispatchState?.dispatchBarrierActive ?? false,
        providers: {},
      },
      timelinePage: { hasMore: false, nextCursor: null, limit: 100 },
    }),
    getActiveGroupTimelinePage: () => ({
      timeline: [],
      timelinePage: { hasMore: false, nextCursor: null, limit: 100 },
    }),
    updateThread: () => {},
  }
}

test("GET /api/session-groups/:groupId includes hasPendingDispatches from dispatch state", async () => {
  const app = Fastify()
  const pendingState = true

  registerThreadRoutes(app, {
    sessions: makeSessionsStub() as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    stopAgent: () => true,
    redisSummary: null,
    sequencer: new GroupSequencer(),
    getDispatchState: (_groupId) => ({
      hasPendingDispatches: pendingState,
      dispatchBarrierActive: false,
    }),
  })

  const response = await app.inject({ method: "GET", url: "/api/session-groups/group-1" })
  await app.close()

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().activeGroup.hasPendingDispatches, true)
  assert.deepEqual(response.json().timelinePage, {
    hasMore: false,
    nextCursor: null,
    limit: 100,
  })
})

test("F044 GET older timeline forwards the opaque cursor and returns page metadata", async () => {
  const app = Fastify()
  let received: { groupId: string; before: string | null; limit: number } | null = null
  const sessions = {
    ...makeSessionsStub(),
    getActiveGroupTimelinePage: (groupId: string, before: string | null, limit: number) => {
      received = { groupId, before, limit }
      return {
        timeline: [],
        timelinePage: { hasMore: true, nextCursor: "next-opaque", limit },
      }
    },
  }

  registerThreadRoutes(app, {
    sessions: sessions as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    redisSummary: null,
    sequencer: new GroupSequencer(),
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/session-groups/group-1/timeline?before=opaque-cursor",
  })
  await app.close()

  assert.equal(response.statusCode, 200)
  assert.deepEqual(received, { groupId: "group-1", before: "opaque-cursor", limit: 100 })
  assert.equal(response.json().timelinePage.nextCursor, "next-opaque")
})

test("F044 GET older timeline rejects an invalid cursor with 400", async () => {
  const app = Fastify()
  const sessions = {
    ...makeSessionsStub(),
    getActiveGroupTimelinePage: () => {
      throw new InvalidTimelineCursorError()
    },
  }

  registerThreadRoutes(app, {
    sessions: sessions as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    redisSummary: null,
    sequencer: new GroupSequencer(),
  })

  const response = await app.inject({
    method: "GET",
    url: "/api/session-groups/group-1/timeline?before=bad",
  })
  await app.close()

  assert.equal(response.statusCode, 400)
  assert.match(response.json().error, /invalid timeline cursor/i)
})

test("POST /api/threads/:threadId/model includes hasPendingDispatches from dispatch state", async () => {
  const app = Fastify()

  registerThreadRoutes(app, {
    sessions: makeSessionsStub() as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    stopAgent: () => true,
    redisSummary: null,
    sequencer: new GroupSequencer(),
    getDispatchState: (_groupId) => ({
      hasPendingDispatches: true,
      dispatchBarrierActive: false,
    }),
  })

  const response = await app.inject({
    method: "POST",
    url: "/api/threads/thread-1/model",
    payload: { model: "gpt-4" },
  })
  await app.close()

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().activeGroup.hasPendingDispatches, true)
})

test("POST /api/threads/:threadId/cancel/:agentId returns 200 when agent is running", async () => {
  const app = Fastify()

  registerThreadRoutes(app, {
    sessions: makeSessionsStub() as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    stopAgent: (_threadId, _agentId) => true,
    redisSummary: null,
    sequencer: new GroupSequencer(),
  })

  const response = await app.inject({
    method: "POST",
    url: "/api/threads/thread-1/cancel/claude",
  })
  await app.close()

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { ok: true })
})

test("POST /api/threads/:threadId/cancel/:agentId returns 409 when agent has no running invocation", async () => {
  const app = Fastify()

  registerThreadRoutes(app, {
    sessions: makeSessionsStub() as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    stopAgent: (_threadId, _agentId) => false,
    redisSummary: null,
    sequencer: new GroupSequencer(),
  })

  const response = await app.inject({
    method: "POST",
    url: "/api/threads/thread-1/cancel/gemini",
  })
  await app.close()

  assert.equal(response.statusCode, 409)
  assert.equal(response.json().error, "该 agent 没有运行中的调用。")
})

test("POST /api/threads/:threadId/cancel/:agentId returns 501 when stopAgent is not provided", async () => {
  const app = Fastify()

  registerThreadRoutes(app, {
    sessions: makeSessionsStub() as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    redisSummary: null,
    sequencer: new GroupSequencer(),
  })

  const response = await app.inject({
    method: "POST",
    url: "/api/threads/thread-1/cancel/claude",
  })
  await app.close()

  assert.equal(response.statusCode, 501)
  assert.equal(response.json().error, "精准取消未启用。")
})
