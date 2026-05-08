import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./callbacks"

/**
 * F026 P1 Wiring · T5 — post-final lockout
 *
 * R-205 + R-048 实测：Claude CLI 在 final 之后会再调一次 MCP `post_message`
 * 把同段话"美化重发"（emoji / 标点 / 列表格式微调）。T4 的 prefix-dedup 只
 * 能挡 verbatim 重发，"美化版"前缀第 71+ 字符就分叉，被放过。
 *
 * 本规则在 invocation 注册的 finalEmittedAt 上做硬拦：一旦
 * runThreadTurn 的 try-success 路径写完 final 并调 markFinalEmitted，
 * 同一 invocation 后续所有 post_message 全部 200 noop（不写库 / 不广播 /
 * 不重入派发）。下一次 @ 唤起是新 invocation，规则重置。
 */

function createActiveGroup() {
  return {
    id: "group-1",
    title: "Test Group",
    meta: "meta",
    timeline: [],
    hasPendingDispatches: false,
    dispatchBarrierActive: false,
    providers: {},
  }
}

function buildHarness() {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")

  const events: Array<{ type: string; payload: unknown }> = []
  let appendedCount = 0
  let dispatchCount = 0

  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-1",
        sessionGroupId: "group-1",
        provider: "claude",
        alias: "Reviewer",
      }),
      appendMessage: () => {
        appendedCount++
        return { id: "fresh-msg" }
      },
      listThreadsByGroup: () => [],
      listMessages: () => [],
      // No recent messages → dedup gate would always pass; lockout must still cut.
      listRecentMessages: () => [],
    } as never,
    sessions: {
      getActiveGroup: () => createActiveGroup(),
    } as never,
    broadcaster: {
      broadcast(event) {
        events.push(event as never)
      },
    },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    emitThreadSnapshot: () => {
      events.push({ type: "thread_snapshot", payload: {} })
    },
    onPublicMessage: async () => {
      dispatchCount++
    },
  })

  return {
    app,
    invocations,
    identity,
    counts: {
      get appended() {
        return appendedCount
      },
      get dispatched() {
        return dispatchCount
      },
    },
    events,
  }
}

test("F026-P1-T5 · lockout: post_message after markFinalEmitted is 200 noop (no append, no dispatch, no broadcast)", async () => {
  const h = buildHarness()

  // Simulate runThreadTurn writing final + flagging the invocation.
  h.invocations.markFinalEmitted(h.identity.invocationId)

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: h.identity.invocationId,
      callbackToken: h.identity.callbackToken,
      content:
        "美化重发版 — Claude CLI final 后又用 post_message 把同段话润色重发，前缀变了" +
        "z".repeat(100),
    },
  })
  await h.app.close()

  assert.equal(res.statusCode, 200, "lockout returns 200 noop, not error")
  const body = res.json() as { ok: boolean; locked?: boolean; reason?: string }
  assert.equal(body.ok, true)
  assert.equal(body.locked, true, "response must flag locked=true so MCP caller can see it")
  assert.equal(body.reason, "final_already_emitted")
  assert.equal(h.counts.appended, 0, "no new message persisted")
  assert.equal(h.counts.dispatched, 0, "no re-dispatch")
  assert.equal(h.events.length, 0, "no broadcast — UI already has the final")
})

test("F026-P1-T5 · pass-through: invocation without markFinalEmitted appends + dispatches normally", async () => {
  const h = buildHarness()
  // Do NOT call markFinalEmitted — this is a legitimate mid-task progress post.

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: h.identity.invocationId,
      callbackToken: h.identity.callbackToken,
      content: "I'm running the long test suite, will report back in a minute. " + "y".repeat(100),
    },
  })
  await h.app.close()

  const body = res.json() as { ok: boolean; locked?: boolean; deduped?: boolean }
  assert.equal(res.statusCode, 200)
  assert.equal(body.locked, undefined, "no lockout flag on a normal mid-task post")
  assert.equal(body.deduped, undefined)
  assert.equal(h.counts.appended, 1)
  assert.equal(h.counts.dispatched, 1)
})

test("F026-P1-T5 · lockout takes priority over dedup logic (no listRecentMessages call)", async () => {
  // If lockout fires first, the dedup helper should not even read recent
  // messages. We assert by making listRecentMessages throw — if it gets
  // invoked, the test fails loudly.
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-2", "agent-2")
  invocations.markFinalEmitted(identity.invocationId)

  let recentLookups = 0
  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-2",
        sessionGroupId: "group-2",
        provider: "claude",
        alias: "X",
      }),
      appendMessage: () => ({ id: "should-not-be-called" }),
      listThreadsByGroup: () => [],
      listMessages: () => [],
      listRecentMessages: () => {
        recentLookups++
        throw new Error("dedup must not run when lockout fires")
      },
    } as never,
    sessions: {
      getActiveGroup: () => createActiveGroup(),
    } as never,
    broadcaster: { broadcast: () => {} },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    onPublicMessage: async () => {},
  })

  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      content:
        "anything goes here, very long body so dedup would otherwise care " + "x".repeat(200),
    },
  })
  await app.close()

  assert.equal(res.statusCode, 200)
  const body = res.json() as { locked?: boolean }
  assert.equal(body.locked, true)
  assert.equal(recentLookups, 0, "dedup must not run when lockout fires")
})

test("F026-P1-T5 · lockout requires valid invocation (401 on unknown id, regardless of finalEmitted state)", async () => {
  const h = buildHarness()
  // mark on the real id, but post with a different invocationId
  h.invocations.markFinalEmitted(h.identity.invocationId)

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: "bogus-id",
      callbackToken: "bogus-token",
      content: "anything " + "x".repeat(120),
    },
  })
  await h.app.close()

  assert.equal(res.statusCode, 401, "auth path runs first; lockout cannot bypass identity check")
})
