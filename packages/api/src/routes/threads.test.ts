import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerThreadRoutes } from "./threads"

function makeSessionsStub(hasPendingDispatches = false) {
  return {
    listSessionGroups: () => [],
    listProviderCatalog: () => [],
    createSessionGroup: () => "group-new",
    findThread: (threadId: string) =>
      threadId === "thread-1"
        ? { id: "thread-1", sessionGroupId: "group-1", alias: "黄仁勋", nativeSessionId: null }
        : null,
    getActiveGroup: (groupId: string, _runningIds: Set<string>, dispatchState?: { hasPendingDispatches: boolean; dispatchBarrierActive: boolean }) => ({
      id: groupId,
      title: "Test",
      meta: "",
      timeline: [],
      hasPendingDispatches: dispatchState?.hasPendingDispatches ?? false,
      dispatchBarrierActive: dispatchState?.dispatchBarrierActive ?? false,
      providers: {},
    }),
    updateThread: () => {},
  }
}

test("GET /api/session-groups/:groupId includes hasPendingDispatches from dispatch state", async () => {
  const app = Fastify()
  let pendingState = true

  registerThreadRoutes(app, {
    sessions: makeSessionsStub() as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    redisSummary: null,
    getDispatchState: (_groupId) => ({
      hasPendingDispatches: pendingState,
      dispatchBarrierActive: false,
    }),
  })

  const response = await app.inject({ method: "GET", url: "/api/session-groups/group-1" })
  await app.close()

  assert.equal(response.statusCode, 200)
  assert.equal(response.json().activeGroup.hasPendingDispatches, true)
})

test("POST /api/threads/:threadId/model includes hasPendingDispatches from dispatch state", async () => {
  const app = Fastify()

  registerThreadRoutes(app, {
    sessions: makeSessionsStub() as never,
    getRunningThreadIds: () => new Set<string>(),
    stopThread: () => true,
    redisSummary: null,
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
