import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./callbacks"

/**
 * F026 P1 Wiring Debt · T4 — post-message dedup gate
 *
 * R-205 实测：LLM 在 CLI final 之后又调 MCP `post_message` 把同段话重发了一遍
 * （前缀完全一致），服务端没拦截 → 重新写库 + 重入派发 → 用户看到双消息 + 重复
 * @ 触发。Prompt 教育（agent-prompts.ts:99-101）已经写明禁令但 LLM 不遵守，
 * 必须在协议层硬拦。
 *
 * Dedup 规则：post-message 收到内容时，比对该 thread 最近一条 assistant message：
 *   - 时间窗 ≤ 60s
 *   - 前 200 字符（或更短取较短者）精确相等且长度 ≥ 80 字符
 *   → 视为 LLM 重发，noop：不写库、不广播、不重入派发，返回 200 + deduped=true
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

type StubMessage = {
  id: string
  role: "assistant" | "user"
  content: string
  messageType: "final" | "progress"
  createdAt: string
}

function buildHarness(opts: {
  recentMessages: StubMessage[]
  appendCallId?: { id: string }
}) {
  const app = Fastify()
  const invocations = new InvocationRegistry<{ cancel: () => void }>()
  const identity = invocations.createInvocation("thread-1", "agent-1")

  const events: Array<{ type: string; payload: unknown }> = []
  let appendedCount = 0
  let dispatchCount = 0
  const appendId = opts.appendCallId?.id ?? "new-message"

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
        return { id: appendId }
      },
      listThreadsByGroup: () => [],
      listMessages: () => [],
      listRecentMessages: (threadId: string, limit: number) => {
        assert.equal(threadId, "thread-1")
        assert.ok(limit >= 1)
        return opts.recentMessages
      },
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

test("F026-P1-T4 · dedup: same prefix within 60s window returns noop (no append, no dispatch)", async () => {
  const finalContent =
    '**第1轮收尾！**\n\n重复桂芬：**"体验高于一切。"**\n\n---\n\n**第2轮开始！**\n\n我说：架构如棋局，落子无悔。' +
    "下一棒交给 @范德彪 你重复我这句话。"
  const recentFinalAt = new Date(Date.now() - 25_000).toISOString() // 25s ago, within 60s window

  const h = buildHarness({
    recentMessages: [
      {
        id: "final-1",
        role: "assistant",
        content: finalContent,
        messageType: "final",
        createdAt: recentFinalAt,
      },
    ],
  })

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: h.identity.invocationId,
      callbackToken: h.identity.callbackToken,
      content: finalContent, // identical content — LLM resending via post_message
    },
  })
  await h.app.close()

  assert.equal(res.statusCode, 200, "dedup must succeed (200), not error")
  const body = res.json() as { ok: boolean; deduped?: boolean; messageId: string }
  assert.equal(body.ok, true)
  assert.equal(body.deduped, true, "response must flag deduped=true so MCP caller can see it")
  assert.equal(body.messageId, "final-1", "messageId points at existing final, not a fresh row")
  assert.equal(h.counts.appended, 0, "no new message persisted")
  assert.equal(
    h.counts.dispatched,
    0,
    "no re-dispatch — the pre-existing final already triggered dispatch",
  )
  assert.equal(h.events.length, 0, "no broadcast — UI already has the final")
})

test("F026-P1-T4 · dedup: identical first-200-char prefix triggers noop even if tail differs", async () => {
  const prefix = "x".repeat(200) // ≥ threshold
  const recentAt = new Date(Date.now() - 5_000).toISOString()

  const h = buildHarness({
    recentMessages: [
      {
        id: "final-2",
        role: "assistant",
        content: prefix + " ORIGINAL TAIL",
        messageType: "final",
        createdAt: recentAt,
      },
    ],
  })

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: h.identity.invocationId,
      callbackToken: h.identity.callbackToken,
      content: prefix + " DIFFERENT TAIL but same head",
    },
  })
  await h.app.close()
  const body = res.json() as { ok: boolean; deduped?: boolean }
  assert.equal(body.deduped, true, "dedup keys on prefix, not full body")
  assert.equal(h.counts.appended, 0)
})

test("F026-P1-T4 · pass-through: different prefix (genuinely new message) appends + dispatches normally", async () => {
  const recentAt = new Date(Date.now() - 5_000).toISOString()

  const h = buildHarness({
    recentMessages: [
      {
        id: "final-3",
        role: "assistant",
        content:
          "**第1轮收尾！** 这是上一条 final，内容完全不同。架构如棋局，落子无悔。" +
          "x".repeat(100),
        messageType: "final",
        createdAt: recentAt,
      },
    ],
  })

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: h.identity.invocationId,
      callbackToken: h.identity.callbackToken,
      content: "@桂芬 现在请你接棒第 2 轮，重复刚才的话再加新一句。" + "y".repeat(100),
    },
  })
  await h.app.close()

  const body = res.json() as { ok: boolean; deduped?: boolean }
  assert.equal(res.statusCode, 200)
  assert.equal(body.deduped, undefined, "no dedup flag on genuine new content")
  assert.equal(h.counts.appended, 1, "must persist new message")
  assert.equal(h.counts.dispatched, 1, "must re-enter dispatch (downstream @ trigger)")
})

test("F026-P1-T4 · pass-through: identical content but >60s after final is NOT dedup (different turn)", async () => {
  const finalContent = "完整收尾，要重复 200+ 字才能命中前缀阈值。" + "x".repeat(200)
  const recentAt = new Date(Date.now() - 90_000).toISOString() // 90s — outside window

  const h = buildHarness({
    recentMessages: [
      {
        id: "final-4",
        role: "assistant",
        content: finalContent,
        messageType: "final",
        createdAt: recentAt,
      },
    ],
  })

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: h.identity.invocationId,
      callbackToken: h.identity.callbackToken,
      content: finalContent,
    },
  })
  await h.app.close()
  const body = res.json() as { ok: boolean; deduped?: boolean }
  assert.equal(
    body.deduped,
    undefined,
    "outside 60s window → not dedup (legitimate new turn could repeat phrasing)",
  )
  assert.equal(h.counts.appended, 1)
})

test("F026-P1-T4 · pass-through: short content (< 80 chars) is never dedup (avoid false positives on '收到'/'好的')", async () => {
  const shortContent = "好的，我明白了。"
  const recentAt = new Date(Date.now() - 5_000).toISOString()

  const h = buildHarness({
    recentMessages: [
      {
        id: "final-5",
        role: "assistant",
        content: shortContent,
        messageType: "final",
        createdAt: recentAt,
      },
    ],
  })

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: h.identity.invocationId,
      callbackToken: h.identity.callbackToken,
      content: shortContent,
    },
  })
  await h.app.close()
  const body = res.json() as { ok: boolean; deduped?: boolean }
  assert.equal(
    body.deduped,
    undefined,
    "short content can be legitimately repeated; protect intent over false positives",
  )
  assert.equal(h.counts.appended, 1)
})

test("F026-P1-T4 · pass-through: no recent messages (first post in thread) appends normally", async () => {
  const h = buildHarness({ recentMessages: [] })

  const res = await h.app.inject({
    method: "POST",
    url: "/api/callbacks/post-message",
    payload: {
      invocationId: h.identity.invocationId,
      callbackToken: h.identity.callbackToken,
      content:
        "first message in thread, very long content that exceeds threshold easily " +
        "z".repeat(100),
    },
  })
  await h.app.close()
  const body = res.json() as { ok: boolean; deduped?: boolean }
  assert.equal(res.statusCode, 200)
  assert.equal(body.deduped, undefined)
  assert.equal(h.counts.appended, 1)
})
