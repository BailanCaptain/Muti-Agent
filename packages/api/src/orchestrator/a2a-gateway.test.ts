import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { assertValidEnvelopeV1, isBetaTask } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { type A2AGatewayDeps, planBetaDispatch, planGammaDispatch } from "./a2a-gateway"
import { CallRegistry } from "./call-registry"
import { MentionRateLimiter, type ProviderAliases } from "./mention-router"

const aliases: ProviderAliases = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

function harness(): A2AGatewayDeps & { close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-gateway-"))
  const store = new SqliteStore(path.join(dir, "db.sqlite"))
  const clock = Date.parse("2026-04-23T13:00:00.000Z")
  const now = () => new Date(clock).toISOString()
  const registry = new CallRegistry({ db: store.db, now })
  const rateLimiter = new MentionRateLimiter({ now: () => clock })
  return {
    db: store.db,
    registry,
    rateLimiter,
    aliases,
    now,
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

test("F026 Gateway β: 行首 @X + 动词 → 1 dispatch + envelope 合法", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-1",
      content: "@范德彪 帮我 review PR",
      sessionGroupId: "g",
    })
    assert.equal(r.dispatched.length, 1)
    assert.equal(r.blocked.length, 0)
    const plan = r.dispatched[0]
    assertValidEnvelopeV1(plan.envelope)
    assert.ok(isBetaTask(plan.envelope.task))
    assert.equal(plan.envelope.protocol.call_id, plan.callId)
    assert.equal(plan.envelope.protocol.issuer_id, "黄仁勋")
  } finally {
    h.close()
  }
})

test("F026 Gateway β + on-behalf: 『@范德彪 帮小孙 review』→ convener=小孙, on_behalf_of=小孙", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-behalf",
      content: "@范德彪 帮小孙 review 这个 PR",
      sessionGroupId: "g",
    })
    assert.equal(r.dispatched.length, 1)
    const env = r.dispatched[0].envelope
    assert.equal(env.protocol.on_behalf_of, "小孙")
    assert.equal(env.protocol.convener_id, "小孙")
    assert.equal(env.protocol.issuer_id, "黄仁勋")
  } finally {
    h.close()
  }
})

test("F026 Gateway β: hard-negative (code block) → 0 dispatch", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-codeblock",
      content: "示例:\n```\n@范德彪 帮我 review\n```",
      sessionGroupId: "g",
    })
    assert.deepEqual(r.dispatched, [])
  } finally {
    h.close()
  }
})

test("F026 Gateway β: 单消息内重复 @X → 1 dispatch + 1 blocked(duplicate-in-message)", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-dup",
      content: "@范德彪 帮我 review\n@范德彪 看这个",
      sessionGroupId: "g",
    })
    assert.equal(r.dispatched.length, 1)
    assert.equal(r.blocked.length, 1)
    assert.equal(r.blocked[0].reason, "duplicate-in-message")
  } finally {
    h.close()
  }
})

test("F026 Gateway β: nested displayMode when parentCallId 提供", () => {
  const h = harness()
  try {
    const rootId = h.registry.openCall({
      issuerId: "小孙",
      convenerId: "小孙",
      replyTo: "user:小孙",
      sessionGroupId: "g",
      deadlineAt: "2026-04-23T14:00:00.000Z",
    })
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-nested",
      content: "@范德彪 帮我 review",
      sessionGroupId: "g",
      parentCallId: rootId,
    })
    assert.equal(r.dispatched.length, 1)
    assert.equal(r.dispatched[0].envelope.task.render.displayMode, "nested")
    assert.equal(r.dispatched[0].envelope.protocol.parent_call_id, rootId)
    assert.equal(r.dispatched[0].envelope.protocol.root_call_id, rootId)
  } finally {
    h.close()
  }
})

test("F026 Gateway γ: skill-driven structured handoff 产出 gamma envelope", () => {
  const h = harness()
  try {
    const r = planGammaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      sessionGroupId: "g",
      convenerId: "黄仁勋",
      task: "review",
      taskInput: { patch: "..." },
      expectedOutput: "approve / request-changes",
      constraints: ["30min"],
    })
    assertValidEnvelopeV1(r.envelope)
    assert.equal(r.envelope.task.task, "review")
    assert.equal(r.envelope.protocol.call_id, r.callId)
  } finally {
    h.close()
  }
})

test("F026 Gateway β: gray-zone NOT dispatched, only recorded for observability (ADR-003 默认不派)", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-gray",
      content: "然后 @范德彪", // 孤零零 @X → gray
      sessionGroupId: "g",
    })
    assert.equal(r.dispatched.length, 0) // ADR-003 layer 3 默认不派
    assert.equal(r.blocked.length, 0) // 不算 blocked，是 gray 静默
    assert.equal(r.grayZone.length, 1) // 仅记录分类信号供观测
    assert.equal(r.grayZone[0].alias, "范德彪")
  } finally {
    h.close()
  }
})

test("F026 P5 T2 · gray-zone 灰区命中 → broadcaster.broadcast(mention.gray_zone) emit", () => {
  const h = harness()
  const events: Array<{ type: string; payload: unknown }> = []
  try {
    const r = planBetaDispatch(
      { ...h, broadcaster: { broadcast: (e) => events.push(e) } },
      {
        sourceAgentId: "user:小孙",
        sourceReplyTo: "user:小孙",
        messageId: "msg-gray-emit",
        content: "然后 @桂芬", // 孤零零段中 @X → gray
        sessionGroupId: "g",
      },
    )
    assert.equal(r.dispatched.length, 0)
    assert.equal(r.grayZone.length, 1)
    // emit 一次 mention.gray_zone WS 事件
    assert.equal(events.length, 1)
    assert.equal(events[0].type, "mention.gray_zone")
    const payload = events[0].payload as Record<string, unknown>
    assert.equal(payload.sessionGroupId, "g")
    assert.equal(payload.source, "user:小孙")
    assert.equal(payload.sourceMessageId, "msg-gray-emit")
    assert.equal(payload.target, "桂芬")
    assert.equal(payload.targetProvider, "gemini")
    assert.equal(payload.decision, "skip")
    assert.ok(
      typeof payload.traceId === "string" && (payload.traceId as string).startsWith("gray-"),
    )
    assert.ok(typeof payload.contentSample === "string")
    assert.ok(typeof payload.occurredAt === "string")
  } finally {
    h.close()
  }
})

test("F026 P5 T2 · gray-zone 多命中 → 多次 broadcast 一一对应", () => {
  const h = harness()
  const events: Array<{ type: string; payload: unknown }> = []
  try {
    const r = planBetaDispatch(
      { ...h, broadcaster: { broadcast: (e) => events.push(e) } },
      {
        sourceAgentId: "user:小孙",
        sourceReplyTo: "user:小孙",
        messageId: "msg-gray-multi",
        content: "然后 @范德彪。另外 @桂芬", // 两处 gray
        sessionGroupId: "g",
      },
    )
    assert.equal(r.dispatched.length, 0)
    assert.equal(r.grayZone.length, 2)
    assert.equal(events.length, 2)
    const targets = events.map((e) => (e.payload as Record<string, unknown>).target).sort()
    assert.deepEqual(targets, ["桂芬", "范德彪"])
    // traceId 唯一
    const traceIds = events.map((e) => (e.payload as Record<string, unknown>).traceId)
    assert.notEqual(traceIds[0], traceIds[1])
  } finally {
    h.close()
  }
})

test("F026 P5 T2 · 缺省 broadcaster fallback console.warn 兼容旧 harness（无 emit）", () => {
  const h = harness()
  const calls: string[] = []
  const origWarn = console.warn
  console.warn = (msg: unknown) => {
    calls.push(String(msg))
  }
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "user:小孙",
      sourceReplyTo: "user:小孙",
      messageId: "msg-gray-warn",
      content: "然后 @范德彪",
      sessionGroupId: "g",
    })
    assert.equal(r.grayZone.length, 1)
    // fallback console.warn 仍 work
    assert.equal(calls.length, 1)
    assert.match(calls[0], /gray-zone NOT dispatched/)
  } finally {
    console.warn = origWarn
    h.close()
  }
})

test("F026 P5 T4 · gray-zone 命中持久化到 agent_events 表（invocation_id=NULL）", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(
      { ...h, broadcaster: { broadcast: () => {} } },
      {
        sourceAgentId: "user:小孙",
        sourceReplyTo: "user:小孙",
        messageId: "msg-gray-persist",
        content: "然后 @桂芬",
        sessionGroupId: "g",
      },
    )
    assert.equal(r.grayZone.length, 1)

    const rows = h.db
      .prepare("SELECT * FROM agent_events WHERE event_type = 'mention_gray_zone'")
      .all() as Array<Record<string, unknown>>
    assert.equal(rows.length, 1)
    assert.equal(rows[0].invocation_id, null)
    assert.equal(rows[0].agent_id, "user:小孙")
    const persisted = JSON.parse(rows[0].payload as string)
    assert.equal(persisted.target, "桂芬")
    assert.equal(persisted.targetProvider, "gemini")
    assert.equal(persisted.decision, "skip")
    assert.equal(persisted.sourceMessageId, "msg-gray-persist")
  } finally {
    h.close()
  }
})

test("F026 P5 T2 · hard-pos dispatch 不触发 broadcaster.broadcast", () => {
  const h = harness()
  const events: Array<{ type: string }> = []
  try {
    const r = planBetaDispatch(
      { ...h, broadcaster: { broadcast: (e) => events.push(e) } },
      {
        sourceAgentId: "user:小孙",
        sourceReplyTo: "user:小孙",
        messageId: "msg-hardpos-no-emit",
        content: "@范德彪 帮我 review PR",
        sessionGroupId: "g",
      },
    )
    assert.equal(r.dispatched.length, 1)
    assert.equal(r.grayZone.length, 0)
    assert.equal(events.length, 0)
  } finally {
    h.close()
  }
})

test("F026 Gateway β: 段中 @ + 第三人称转述（让 @X ...）不应派发（R-040 误派回归）", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-r040-regression",
      content:
        "@范德彪 请把上面这句话一字不差重复一遍，然后你自己再说一句新的话，让 @桂芬 重复你的那句。",
      sessionGroupId: "g",
    })
    // 行首 @范德彪 + 祈使（请...重复）→ 派发
    // 段中 让 @桂芬 重复... → 灰区静默
    assert.equal(r.dispatched.length, 1)
    assert.equal(r.dispatched[0].mention.alias, "范德彪")
    const guifenDispatched = r.dispatched.some((d) => d.mention.alias === "桂芬")
    assert.equal(guifenDispatched, false, "桂芬不应被派发（段中转述）")
  } finally {
    h.close()
  }
})

// ---------------------------------------------------------------------------
// F026 方案 X · 双契约 source role guard
// ---------------------------------------------------------------------------

test("F026 方案 X · assistant + [Call: @X] 句中 → 1 dispatch（位置无关）", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-call-tag-mid",
      content: "我先看下 PR 整体结构，然后 [Call: @桂芬 看下视觉] 收个尾。",
      sessionGroupId: "g",
      sourceRole: "assistant",
    })
    assert.equal(r.dispatched.length, 1)
    assert.equal(r.dispatched[0].mention.alias, "桂芬")
    assert.equal(r.dispatched[0].mention.onBehalfOf, null)
    assertValidEnvelopeV1(r.dispatched[0].envelope)
    assert.equal(r.grayZone.length, 0)
  } finally {
    h.close()
  }
})

test("F026 方案 X · assistant + 自由文本 @X（无 tag）→ 不派发（白名单废弃）", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-no-tag",
      content: "@范德彪 帮我 review PR\n我刚和 @桂芬 聊过这事。",
      sessionGroupId: "g",
      sourceRole: "assistant",
    })
    assert.equal(r.dispatched.length, 0, "assistant 自由文本 @ 全部静默")
    assert.equal(r.blocked.length, 0)
    assert.equal(r.grayZone.length, 0, "方案 X 不再分类 gray —— 没标签就是没意图")
  } finally {
    h.close()
  }
})

test("F026 方案 X · assistant + [Call: @X] 重复 → 1 dispatch + 1 blocked(duplicate-in-message)", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-dup",
      content: "[Call: @桂芬 任务A]\n中间一些其他话\n[Call: @桂芬 任务B]",
      sessionGroupId: "g",
      sourceRole: "assistant",
    })
    assert.equal(r.dispatched.length, 1, "同消息内同 target 仅首条派发")
    assert.equal(r.blocked.length, 1)
    assert.equal(r.blocked[0].reason, "duplicate-in-message")
  } finally {
    h.close()
  }
})

test("F026 方案 X · user 路径不受影响（line-start @X 仍派发）", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "user",
      sourceReplyTo: "user:小孙",
      messageId: "msg-user-linestart",
      content: "@范德彪 请你 review",
      sessionGroupId: "g",
      sourceRole: "user",
    })
    assert.equal(r.dispatched.length, 1)
    assert.equal(r.dispatched[0].mention.alias, "范德彪")
  } finally {
    h.close()
  }
})

test("F026 方案 X · 默认（未传 sourceRole）走 user 路径（向后兼容）", () => {
  const h = harness()
  try {
    const r = planBetaDispatch(h, {
      sourceAgentId: "黄仁勋",
      sourceReplyTo: "agent:黄仁勋",
      messageId: "msg-no-role",
      content: "@范德彪 帮我 review PR",
      sessionGroupId: "g",
      // 不传 sourceRole — 现有 8 个测试都不传
    })
    assert.equal(r.dispatched.length, 1, "未传 role → 走旧 ADR-003 路径不破坏现有测试")
  } finally {
    h.close()
  }
})
