import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./callbacks"

function createActiveGroup(hasPendingDispatches: boolean) {
  return {
    id: "group-1",
    title: "Test Group",
    meta: "meta",
    timeline: [],
    hasPendingDispatches,
    dispatchBarrierActive: false,
    providers: {
      codex: {
        threadId: "thread-codex",
        alias: "Coder",
        currentModel: null,
        quotaSummary: "",
        preview: "",
        running: false,
      },
      claude: {
        threadId: "thread-claude",
        alias: "Reviewer",
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
  }
}

test("post-message emits the snapshot after dispatch state has been updated", async () => {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")
  const events: Array<{
    type: string
    payload: { activeGroup?: { hasPendingDispatches: boolean } }
  }> = []
  let hasPendingDispatches = false

  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-1",
        sessionGroupId: "group-1",
      }),
      appendMessage: () => ({
        id: "message-1",
      }),
      listThreadsByGroup: () => [],
      listMessages: () => [],
    } as never,
    sessions: {
      getActiveGroup: () => createActiveGroup(hasPendingDispatches),
    } as never,
    broadcaster: {
      broadcast(event) {
        events.push(event as never)
      },
    },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    emitThreadSnapshot: (sessionGroupId) => {
      events.push({
        type: "thread_snapshot",
        payload: {
          activeGroup: createActiveGroup(hasPendingDispatches && sessionGroupId === "group-1"),
        },
      })
    },
    onPublicMessage: async () => {
      hasPendingDispatches = true
    },
  })

  await app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      content: "@Designer take over",
    },
  })

  await app.close()

  const snapshot = events.find((event) => event.type === "thread_snapshot")
  assert.ok(snapshot, "Expected a thread snapshot to be broadcast")
  assert.equal(snapshot.payload.activeGroup?.hasPendingDispatches, true)
})

test("POST /api/callbacks/post-message returns 403 Forbidden if the session group is cancelled", async () => {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")
  let cancelled = false

  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-1",
        sessionGroupId: "group-1",
      }),
      appendMessage: () => {
        throw new Error("Should not be called")
      },
    } as never,
    sessions: {} as never,
    broadcaster: { broadcast: () => {} },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: (sessionGroupId) => sessionGroupId === "group-1" && cancelled,
  })

  cancelled = true

  const response = await app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      content: "Delayed message",
    },
  })

  assert.equal(response.statusCode, 403)
  assert.deepEqual(response.json(), { error: "Session group has been cancelled." })

  await app.close()
})
