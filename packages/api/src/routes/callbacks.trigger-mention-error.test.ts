import assert from "node:assert/strict"
import test from "node:test"
import type { RealtimeServerEvent } from "@multi-agent/shared"
import Fastify from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes, resolveMentionTarget } from "./callbacks"

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
      // B025 后：目标必须过归一化闸门（未知目标另有专测），这里用合法花名
      // 保住"下游 triggerMention throw → ok:false 冒泡"路径的覆盖。
      targetAgentId: "范德彪",
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
  // B025：带 @ 前缀必须归一成裸花名——原样透传会拼出 [Call: @@范德彪 ...] 双 @ 静默死
  assert.equal((seenParams as { targetAlias?: string } | null)?.targetAlias, "范德彪")
  assert.equal(
    events.some((ev) => ev.type === "status"),
    false,
    "happy path 不应 emit status 事件",
  )
})

/**
 * B025 · targetAgentId 契约歧义修复：路由层归一化 + 未知目标 fail-closed。
 * 真机实锤：agent 照参数名传 "codex" → [Call: @codex] 网关解析不出 → 静默零派发
 * 但工具返回 ok:true 假成功。修复后 provider id 归一花名，未知目标 ok:false 冒泡。
 */

test("B025 · resolveMentionTarget 归一化矩阵", () => {
  // 裸花名精确命中
  assert.deepEqual(resolveMentionTarget("范德彪"), { ok: true, alias: "范德彪" })
  // provider id → 花名（真机事故的原始输入）
  assert.deepEqual(resolveMentionTarget("codex"), { ok: true, alias: "范德彪" })
  assert.deepEqual(resolveMentionTarget("claude"), { ok: true, alias: "黄仁勋" })
  assert.deepEqual(resolveMentionTarget("gemini"), { ok: true, alias: "桂芬" })
  // 大小写不敏感
  assert.deepEqual(resolveMentionTarget("CODEX"), { ok: true, alias: "范德彪" })
  // @ 前缀（含多重）剥掉
  assert.deepEqual(resolveMentionTarget("@范德彪"), { ok: true, alias: "范德彪" })
  assert.deepEqual(resolveMentionTarget("@@范德彪"), { ok: true, alias: "范德彪" })
  assert.deepEqual(resolveMentionTarget("@codex"), { ok: true, alias: "范德彪" })
  // 未知目标 → 报错文案含可用名单（agent 自纠依据）
  const unknown = resolveMentionTarget("幽灵")
  assert.equal(unknown.ok, false)
  if (!unknown.ok) {
    assert.match(unknown.error, /范德彪/)
    assert.match(unknown.error, /codex/)
  }
  // 空/纯 @ → 拒绝
  assert.equal(resolveMentionTarget("  ").ok, false)
  assert.equal(resolveMentionTarget("@").ok, false)
})

test("B025 · 路由：provider id 'codex' 归一成 '范德彪' 后派发", async () => {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")
  let seenParams: { targetAlias?: string } | null = null

  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-1",
        sessionGroupId: "group-1",
        provider: "claude",
      }),
      appendMessage: () => ({ id: "m1" }),
      listThreadsByGroup: () => [],
      listMessages: () => [],
    } as never,
    sessions: { getActiveGroup: () => minimalActiveGroup() } as never,
    broadcaster: { broadcast: () => {} },
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
      targetAgentId: "codex",
      taskSnippet: "小孙在叫你",
    },
  })

  await app.close()

  assert.equal(res.statusCode, 200)
  assert.equal((res.json() as { ok: boolean }).ok, true)
  assert.equal((seenParams as { targetAlias?: string } | null)?.targetAlias, "范德彪")
})

test("B025 · 路由：未知目标 → ok:false + status 广播 + 不调 triggerMention", async () => {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")
  const events: RealtimeServerEvent[] = []
  let triggerCalled = false

  registerCallbackRoutes(app, {
    repository: {
      getThreadById: () => ({
        id: "thread-1",
        sessionGroupId: "group-1",
        provider: "claude",
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
      triggerCalled = true
    },
  })

  const res = await app.inject({
    method: "POST",
    url: "/api/callbacks/trigger-mention",
    payload: {
      invocationId: identity.invocationId,
      callbackToken: identity.callbackToken,
      targetAgentId: "幽灵",
      taskSnippet: "x",
    },
  })

  await app.close()

  assert.equal(res.statusCode, 200, "HTTP 200 合约不变")
  const body = res.json() as { ok: boolean; error?: string }
  assert.equal(body.ok, false)
  assert.match(body.error ?? "", /未知目标/)
  assert.match(body.error ?? "", /范德彪/, "错误文案必须给出可用名单供 agent 自纠")
  assert.equal(triggerCalled, false, "未知目标不得触发派发（不落死 [Call:] 消息）")

  const statusEv = events.find(
    (ev) =>
      ev.type === "status" &&
      /trigger[_ ]mention/i.test((ev.payload as { message?: string }).message ?? ""),
  )
  assert.ok(statusEv, "必须 broadcast status 事件让前端 console 可见")
})
