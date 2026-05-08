import assert from "node:assert/strict"
import test from "node:test"
import type { RealtimeServerEvent } from "@multi-agent/shared"
import Fastify from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./callbacks"

/**
 * F026 P0 Day3 · Task4 · trigger_mention 业务失败冒泡（P14 AC）
 *
 * HTTP 200 合约不变，但：
 *   - triggerMention throws → body.ok=false + body.error=<msg> + 广播 status 事件
 *   - triggerMention 正常 → body.ok=true（原行为）
 * 让 MCP 调用方和前端 console 都能看见"目标 alias 不存在 / 派发被拒"这类业务失败。
 */

function minimalActiveGroup() {
  return {
    id: "group-1",
    title: "t",
    meta: "",
    timeline: [],
    hasPendingDispatches: false,
    dispatchBarrierActive: false,
    providers: {} as never,
  }
}

test("trigger-mention · business failure surfaces as ok:false + status event", async () => {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")
  const events: RealtimeServerEvent[] = []

  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-1",
        sessionGroupId: "group-1",
        provider: "codex",
      }),
      appendMessage: () => ({ id: "m1" }),
      listThreadsByGroup: () => [],
      listMessages: () => [],
    } as never,
    sessions: { getActiveGroup: () => minimalActiveGroup() } as never,
    broadcaster: { broadcast: (ev) => events.push(ev) },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    triggerMention: async () => {
      throw new Error("target alias not found")
    },
  })

  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/trigger-mention",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      targetAgentId: "@幽灵",
      taskSnippet: "x",
    },
  })

  await app.close()

  assert.equal(res.statusCode, 200, "HTTP 200 合约不变")
  const body = res.json() as { ok: boolean; error?: string }
  assert.equal(body.ok, false)
  assert.match(body.error ?? "", /target alias not found/)

  const statusEv = events.find(
    (ev) =>
      ev.type === "status" &&
      typeof (ev.payload as { message?: string }).message === "string" &&
      /trigger[_ ]mention/i.test((ev.payload as { message: string }).message),
  )
  assert.ok(statusEv, "必须 broadcast 一个 status 事件，让前端 console 看得到")
  assert.equal((statusEv.payload as { sessionGroupId?: string }).sessionGroupId, "group-1")
})

test("trigger-mention · happy path still returns ok:true", async () => {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")
  const events: RealtimeServerEvent[] = []
  let seenParams: { targetAlias?: string } | null = null

  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-1",
        sessionGroupId: "group-1",
        provider: "codex",
      }),
      appendMessage: () => ({ id: "m1" }),
      listThreadsByGroup: () => [],
      listMessages: () => [],
    } as never,
    sessions: { getActiveGroup: () => minimalActiveGroup() } as never,
    broadcaster: { broadcast: (ev) => events.push(ev) },
    getRunningThreadIds: () => new Set<string>(),
    invocations,
    isSessionGroupCancelled: () => false,
    triggerMention: async (_sgid, params) => {
      seenParams = params
    },
  })

  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/trigger-mention",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      targetAgentId: "@范德彪",
      taskSnippet: "做一下 x",
    },
  })

  await app.close()

  assert.equal(res.statusCode, 200)
  const body = res.json() as { ok: boolean }
  assert.equal(body.ok, true)
  assert.equal((seenParams as { targetAlias?: string } | null)?.targetAlias, "@范德彪")
  assert.equal(
    events.some((ev) => ev.type === "status"),
    false,
    "happy path 不应 emit status 事件",
  )
})
