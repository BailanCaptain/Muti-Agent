/**
 * F026 P5 in-flight bug · R-104 反证：LLM 主链路 final flush 派发后 0 条 connector message
 *
 * 根因（room ctx 02:20 钉死）：
 *   `appendConnectorMessage` 唯一生产 call site 在 `message-service.ts:797-833`
 *   handleAgentPublicMessage（MCP / CLI hook 路径）。LLM 主链路 runThreadTurn
 *   final flush :1962 enqueuePublicMentions 后没写 connector header → 前端
 *   ConnectorBubble / AtPill / OriginCapsule 全部没载体（hairs.4/4 R-104 timeline
 *   全 final 0 connector）。
 *
 * 修法（小孙拍 B · 抽函数）：把 :797-833 抽成 module-level pure function
 * `writeConnectorHeadersForQueue(sessions, enqueueResult, emit)`，:797 + :1962
 * 双调用点共用，杜绝两条派发入口的写入逻辑不对称。
 *
 * 本测试锁住 helper 行为契约：每条 queued entry 写一行 connector message
 * + emit 一次 message.created，target thread 缺失 / queued 为空 / callId
 * undefined 三个边界都不抛。
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { ConnectorSource, Provider, RealtimeServerEvent } from "@multi-agent/shared"
import type { EnqueueMentionsResult, QueueEntry } from "../orchestrator/dispatch"
import { writeConnectorHeadersForQueue } from "./message-service"

type AppendCall = {
  threadId: string
  content: string
  source: ConnectorSource
  groupId: string | null
  groupRole: "header" | "member" | "convergence" | null
  a2aCallId: string | null
}

function createSessionsSpy(targetThreads: Record<string, string>) {
  const appendCalls: AppendCall[] = []
  const sessions = {
    findThreadByGroupAndProvider: (sessionGroupId: string, provider: Provider) => {
      const id = targetThreads[provider]
      if (!id) return null
      return {
        id,
        sessionGroupId,
        provider,
        alias: provider,
        currentModel: null,
        nativeSessionId: null,
      }
    },
    appendConnectorMessage: (
      threadId: string,
      content: string,
      source: ConnectorSource,
      groupId: string | null,
      groupRole: "header" | "member" | "convergence" | null,
      a2aCallId: string | null,
    ) => {
      appendCalls.push({ threadId, content, source, groupId, groupRole, a2aCallId })
      return {
        id: `connector-msg-${appendCalls.length}`,
        threadId,
        role: "assistant" as const,
        content,
        thinking: "",
        createdAt: new Date().toISOString(),
      }
    },
    toTimelineMessage: (threadId: string, messageId: string) => ({
      id: messageId,
      provider: "gemini" as Provider,
      alias: "Designer",
      role: "assistant" as const,
      content: "",
      messageType: "connector" as const,
      model: null,
      createdAt: new Date().toISOString(),
    }),
  }
  return { sessions, appendCalls }
}

function makeQueueEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "msg-1",
    sessionGroupId: "group-1",
    rootMessageId: "root-1",
    from: {
      agentId: "Coder",
      messageId: "src-msg-1",
      provider: "codex",
    },
    to: {
      agentId: "Designer",
      provider: "gemini",
    },
    taskSnippet: "[Call: @Designer review]",
    contextSnapshot: [],
    parentInvocationId: "inv-1",
    hopIndex: 1,
    callId: "call-abc",
    ...overrides,
  }
}

test("F026 P5 in-flight (R-104) · writeConnectorHeadersForQueue: 1 queued → 1 connector emit (header role + callId 透传)", () => {
  const { sessions, appendCalls } = createSessionsSpy({ gemini: "thread-gemini" })
  const events: RealtimeServerEvent[] = []

  const result: EnqueueMentionsResult = {
    queued: [makeQueueEntry()],
    blocked: [],
  }

  writeConnectorHeadersForQueue(sessions as never, result, (e) => events.push(e))

  assert.equal(appendCalls.length, 1, "appendConnectorMessage called once")
  assert.equal(appendCalls[0].threadId, "thread-gemini")
  assert.equal(appendCalls[0].groupRole, "header")
  assert.equal(appendCalls[0].a2aCallId, "call-abc")
  assert.equal(appendCalls[0].source.kind, "multi_mention_result")
  assert.equal((appendCalls[0].source as { fromAlias: string }).fromAlias, "Coder")
  assert.equal((appendCalls[0].source as { toAlias: string }).toAlias, "Designer")

  const created = events.filter((e) => e.type === "message.created")
  assert.equal(created.length, 1, "must emit exactly 1 connector message.created")
})

test("F026 P5 in-flight (R-104) · writeConnectorHeadersForQueue: 0 queued → 0 emits / 0 appends", () => {
  const { sessions, appendCalls } = createSessionsSpy({ gemini: "thread-gemini" })
  const events: RealtimeServerEvent[] = []

  writeConnectorHeadersForQueue(
    sessions as never,
    { queued: [], blocked: [] },
    (e) => events.push(e),
  )

  assert.equal(appendCalls.length, 0)
  assert.equal(events.length, 0)
})

test("F026 P5 in-flight (R-104) · writeConnectorHeadersForQueue: 2 queued → 2 connector emits, distinct callIds 透传", () => {
  const { sessions, appendCalls } = createSessionsSpy({
    gemini: "thread-gemini",
    claude: "thread-claude",
  })
  const events: RealtimeServerEvent[] = []

  const result: EnqueueMentionsResult = {
    queued: [
      makeQueueEntry({
        id: "msg-a",
        to: { agentId: "Designer", provider: "gemini" },
        callId: "call-a",
      }),
      makeQueueEntry({
        id: "msg-b",
        to: { agentId: "Reviewer", provider: "claude" },
        callId: "call-b",
      }),
    ],
    blocked: [],
  }

  writeConnectorHeadersForQueue(sessions as never, result, (e) => events.push(e))

  assert.equal(appendCalls.length, 2)
  assert.equal(appendCalls[0].a2aCallId, "call-a")
  assert.equal(appendCalls[1].a2aCallId, "call-b")
  assert.equal(events.filter((e) => e.type === "message.created").length, 2)
})

test("F026 P5 in-flight (R-104) · writeConnectorHeadersForQueue: target thread 缺失 → skip 不抛", () => {
  const { sessions, appendCalls } = createSessionsSpy({}) // no targets
  const events: RealtimeServerEvent[] = []

  writeConnectorHeadersForQueue(
    sessions as never,
    { queued: [makeQueueEntry()], blocked: [] },
    (e) => events.push(e),
  )

  assert.equal(appendCalls.length, 0)
  assert.equal(events.length, 0)
})

test("F026 P5 in-flight (R-104) · writeConnectorHeadersForQueue: entry.callId undefined → a2aCallId 传 null", () => {
  const { sessions, appendCalls } = createSessionsSpy({ gemini: "thread-gemini" })
  const events: RealtimeServerEvent[] = []

  const entry = makeQueueEntry()
  delete (entry as { callId?: string }).callId

  writeConnectorHeadersForQueue(
    sessions as never,
    { queued: [entry], blocked: [] },
    (e) => events.push(e),
  )

  assert.equal(appendCalls.length, 1)
  assert.equal(appendCalls[0].a2aCallId, null)
})
