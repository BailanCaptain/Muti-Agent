/**
 * F026 · dispatch-gateway wire
 *
 * Verifies that when a gateway hook is installed,
 * DispatchOrchestrator.enqueuePublicMentions delegates mention resolution to
 * the hook (which runs the 3-layer mention router + rate-limiter + on-behalf
 * inference + call-registry.openCall → envelope).
 *
 * Without an installed hook, the classic regex-based `resolveMentions` path
 * is used unchanged (回归基线保护).
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Provider } from "@multi-agent/shared"

import {
  type A2AGatewayHook,
  type A2AGatewayPlanInput,
  type A2AGatewayPlanResult,
  DispatchOrchestrator,
} from "../dispatch"

function createSessionsStub() {
  const threads = [
    { id: "thread-codex", sessionGroupId: "group-1", provider: "codex", alias: "范德彪" },
    { id: "thread-claude", sessionGroupId: "group-1", provider: "claude", alias: "黄仁勋" },
    { id: "thread-gemini", sessionGroupId: "group-1", provider: "gemini", alias: "桂芬" },
  ]
  return {
    findThread: (id: string) => threads.find((t) => t.id === id) ?? null,
    findThreadByGroupAndProvider: (sg: string, p: string) =>
      threads.find((t) => t.sessionGroupId === sg && t.provider === p) ?? null,
    listGroupThreads: (sg: string) => threads.filter((t) => t.sessionGroupId === sg),
  }
}

const defaultAliases = { codex: "范德彪", claude: "黄仁勋", gemini: "桂芬" } as const

function stubHook(plan: (input: A2AGatewayPlanInput) => A2AGatewayPlanResult): {
  hook: A2AGatewayHook
  calls: A2AGatewayPlanInput[]
} {
  const calls: A2AGatewayPlanInput[] = []
  const hook: A2AGatewayHook = {
    planMentions(input) {
      calls.push(input)
      return plan(input)
    },
  }
  return { hook, calls }
}

test("F026 · hook installed: gateway plan replaces resolveMentions", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  const { hook, calls } = stubHook(() => ({
    mentions: [{ provider: "claude" as Provider, alias: "黄仁勋", callId: "call-123" }],
    blockedByGateway: [],
  }))
  dispatch.setA2AGatewayHook(hook)
  dispatch.registerUserRoot("root-1", "group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@黄仁勋 帮小孙 review 一下",
  })

  assert.equal(calls.length, 1, "hook must be invoked exactly once")
  assert.equal(calls[0]!.content, "@黄仁勋 帮小孙 review 一下")
  assert.equal(result.queued.length, 1)
  assert.equal(result.queued[0]!.to.provider, "claude")
  assert.equal(result.queued[0]!.callId, "call-123", "QueueEntry must carry callId from gateway")
})

test("F026 · hook NOT installed: fallback path used (回归基线保护)", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  // no setA2AGatewayHook
  dispatch.registerUserRoot("root-1", "group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "[Call: @黄仁勋 看下]",
    matchMode: "anywhere",
  })

  assert.equal(result.queued.length, 1, "falls back to call-tag parser when hook absent")
  assert.equal(result.queued[0]!.callId, undefined)
})

test("F026 · gateway blockedByGateway (gray-zone / rate-limit) surfaces in result", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  const { hook } = stubHook(() => ({
    mentions: [],
    blockedByGateway: [{ provider: "claude" as Provider, alias: "黄仁勋", reason: "gray-zone" }],
  }))
  dispatch.setA2AGatewayHook(hook)
  dispatch.registerUserRoot("root-1", "group-1")

  const result = dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@黄仁勋 是个好同事",
  })

  assert.equal(result.queued.length, 0, "gray-zone blocks dispatch")
  assert.ok(
    result.blockedByGateway && result.blockedByGateway.length === 1,
    "blockedByGateway must surface for observability",
  )
  assert.equal(result.blockedByGateway![0]!.reason, "gray-zone")
})

test("F026 · gateway rate-limit blocks second dispatch within window", () => {
  const dispatch = new DispatchOrchestrator(createSessionsStub() as never, defaultAliases)
  let callIdx = 0
  const { hook } = stubHook(() => {
    callIdx += 1
    if (callIdx === 1) {
      return {
        mentions: [{ provider: "claude" as Provider, alias: "黄仁勋", callId: "call-1" }],
        blockedByGateway: [],
      }
    }
    return {
      mentions: [],
      blockedByGateway: [
        { provider: "claude" as Provider, alias: "黄仁勋", reason: "rate-limit" },
      ],
    }
  })
  dispatch.setA2AGatewayHook(hook)
  dispatch.registerUserRoot("root-1", "group-1")

  const first = dispatch.enqueuePublicMentions({
    messageId: "user-1",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@黄仁勋 go",
  })
  const second = dispatch.enqueuePublicMentions({
    messageId: "user-2",
    sessionGroupId: "group-1",
    sourceProvider: "codex",
    sourceAlias: "范德彪",
    rootMessageId: "root-1",
    content: "@黄仁勋 go",
  })

  assert.equal(first.queued.length, 1)
  assert.equal(second.queued.length, 0)
  assert.equal(second.blockedByGateway?.[0]!.reason, "rate-limit")
})
