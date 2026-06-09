/**
 * F027 #286 FU-1 · 自动召回接线级测试 —— 穿透到 assembleDirectTurnPrompt 的端到端断言。
 *
 * 背景（B1-b receive P3 follow-up，b-1 P3-3 + b-2 P3-2/P3-3 合并）：
 * 既有 harness（message-service.user-root-call.test.ts:189-197）靠预填 invocation 让
 * runThreadTurn 早返，到不了 assembly —— [Recall Pack] 是否真落 prompt envelope 此前
 * 只有 helper 单测（message-service.direct-recall.test.ts）+ codex 人肉核 liveness。
 *
 * 本文件补穿透：注入 fake BaseCliRuntime（复用 runTurn 既有 `runtime` test hook，
 * cli-orchestrator.ts:72/112），捕获 AgentRunInput.prompt（= assembleDirectTurnPrompt
 * 产出的 content envelope），直接断言 [Recall Pack — Reference Only] 注入与否：
 *   1. 冷启（nativeSessionId===null）+ search 命中 → envelope 含 [Recall Pack] + hit path
 *   2. wake_up（nativeSessionId 非空）+ coordinator 命中 → envelope 含 [Recall Pack]
 *   3. direct_turn（普通用户问答）→ coordinator scenario_skip → envelope 无 [Recall Pack]
 *
 * MessageService 侧新增 setCliRuntimeOverride 测试缝（仅转发到 runTurn options.runtime，
 * 生产不调零行为变化）。
 */

import assert from "node:assert/strict"
import test from "node:test"
import type { Provider, RealtimeServerEvent } from "@multi-agent/shared"
import { DispatchOrchestrator } from "../orchestrator/dispatch"
import { AdaptiveRecallCoordinator } from "../orchestrator/adaptive-recall-coordinator"
import { InvocationRegistry } from "../orchestrator/invocation-registry"
import type { AgentRunInput, BaseCliRuntime } from "../runtime/base-runtime"
import type { ExecuteOutput, ExecutorDeps } from "../wiki/adaptive-recall/types"
import type { RecallHit, WikiSearchProvider } from "../wiki/memory-preflight/types"
import { MessageService } from "./message-service"

type ThreadRecord = {
  id: string
  sessionGroupId: string
  provider: Provider
  alias: string
  currentModel: string | null
  nativeSessionId: string | null
  sopBookmark?: string | null
  lastFillRatio?: number | null
  backlogItemId?: string | null
}

function createThreads(): ThreadRecord[] {
  return [
    {
      id: "thread-claude",
      sessionGroupId: "group-1",
      provider: "claude",
      alias: "Reviewer",
      currentModel: null,
      nativeSessionId: null,
    },
  ]
}

/** 与 user-root-call harness 同型的 sessions stub，多补 direct-turn 全链路要用的方法。 */
function createSessionsStub(threads: ThreadRecord[]) {
  return {
    isSessionGroupSendable: () => ({ sendable: true as const }),
    findThread: (threadId: string) => threads.find((t) => t.id === threadId) ?? null,
    findThreadByGroupAndProvider: (sessionGroupId: string, provider: Provider) =>
      threads.find((t) => t.sessionGroupId === sessionGroupId && t.provider === provider) ?? null,
    listGroupThreads: (sessionGroupId: string) =>
      threads.filter((t) => t.sessionGroupId === sessionGroupId),
    listThreadMessages: () => [],
    appendUserMessage: (threadId: string, content: string) => ({
      id: `user-${threadId}-${Date.now()}`,
      threadId,
      role: "user" as const,
      content,
      thinking: "",
      createdAt: new Date().toISOString(),
    }),
    appendAssistantMessage: (threadId: string) => ({
      id: `assistant-${threadId}-${Date.now()}`,
      threadId,
      role: "assistant" as const,
      content: "",
      thinking: "",
      createdAt: new Date().toISOString(),
    }),
    appendSystemNoticeMessage: (threadId: string, content: string) => ({
      id: `notice-${threadId}-${Date.now()}`,
      threadId,
      role: "assistant" as const,
      content,
      thinking: "",
      createdAt: new Date().toISOString(),
    }),
    appendAgentEvent: () => {},
    toTimelineMessage: (threadId: string, messageId: string) => ({
      id: messageId,
      provider: threads.find((t) => t.id === threadId)?.provider ?? "claude",
      alias: threads.find((t) => t.id === threadId)?.alias ?? "Reviewer",
      role: messageId.startsWith("user-") ? ("user" as const) : ("assistant" as const),
      content: "content",
      model: null,
      createdAt: new Date().toISOString(),
    }),
    overwriteMessage: () => {},
    updateThread: () => {},
    flushSessionPending: () => ({}),
    getContentBlocksJson: () => "[]",
    getThreadMemory: () => null,
    getRoomId: () => "R-201",
    getSessionChainIndex: () => 0,
    getActiveGroup: (groupId: string) => ({
      id: groupId,
      title: "Test Group",
      meta: "",
      timeline: [],
      hasPendingDispatches: false,
      dispatchBarrierActive: false,
      providers: {
        claude: {
          threadId: "thread-claude",
          alias: "Reviewer",
          currentModel: null,
          quotaSummary: "",
          preview: "",
          running: false,
        },
      },
    }),
    isFirstSnapshot: () => true,
    getActiveGroupDelta: () => ({
      newMessages: [],
      removedMessageIds: [],
      providers: {},
      invocationStats: [],
    }),
  }
}

/**
 * Fake BaseCliRuntime：不 spawn 任何进程，捕获 AgentRunInput（prompt = content envelope，
 * env.MULTI_AGENT_SYSTEM_PROMPT = systemPrompt），promise 立即以空输出 resolve。
 * cli-orchestrator 的 parse* 方法只在 onStdoutLine 内被调，fake 不产 stdout 行 → 不会触达。
 */
function makeFakeRuntime() {
  const captured: AgentRunInput[] = []
  let resolveFirstRun: (() => void) | null = null
  const firstRun = new Promise<void>((resolve) => {
    resolveFirstRun = resolve
  })
  const runtime = {
    agentId: "fake-cli",
    async afterRun() {},
    run(input: AgentRunInput) {
      return this.runStream(input).promise
    },
    runStream(input: AgentRunInput) {
      captured.push(input)
      resolveFirstRun?.()
      return {
        cancel() {},
        promise: Promise.resolve({
          finalText: "",
          rawStdout: "",
          rawStderr: "",
          exitCode: 0,
          stopReason: "complete" as const,
        }),
      }
    },
  }
  return { runtime: runtime as unknown as BaseCliRuntime, captured, firstRun }
}

function makeHit(path: string, score: number): RecallHit {
  return { path, score, excerpt: `excerpt for ${path}` }
}

function makeExecuteOutput(hits: RecallHit[]): ExecuteOutput {
  return {
    recallPath: 2,
    recallSatisfied: true,
    hits,
    totalMs: 1,
    critiqueCalls: 0,
    budgetExceeded: false,
    attempts: [{ level: 2, hitsCount: hits.length, satisfied: true, ms: 1, reason: "ok" }],
  }
}

function makeStubDeps(): ExecutorDeps {
  return {
    critique: { evaluate: async () => ({ satisfied: true, reason: "stub" }) },
    level2: { searchWiki: async () => [] },
    level3: { queryMessages: async () => [] },
    level4: { readWiki: async () => null },
    level5: { escalate: async () => {} },
  }
}

function makeHarness() {
  const threads = createThreads()
  const sessions = createSessionsStub(threads)
  const dispatch = new DispatchOrchestrator(sessions as never, {
    claude: "Reviewer",
    codex: "Coder",
    gemini: "Designer",
  })
  const invocations = new InvocationRegistry<{
    cancel: () => void
    promise: Promise<{
      content: string
      currentModel: string | null
      nativeSessionId: string | null
      exitCode: number | null
    }>
  }>()
  const messageService = new MessageService(
    sessions as never,
    dispatch,
    invocations as never,
    { emit() {} } as never,
    "http://localhost:8787",
  )
  const fake = makeFakeRuntime()
  messageService.setCliRuntimeOverride(fake.runtime)
  return { threads, sessions, dispatch, invocations, messageService, fake }
}

test("FU-1 · 冷启（nativeSessionId=null）+ search 命中 → [Recall Pack] 真落 content envelope", async () => {
  const h = makeHarness()
  const search: WikiSearchProvider = {
    search: async () => [makeHit("wiki/concepts/F027.md", 0.95)],
  }
  h.messageService.setMemoryPreflightSearch(search)
  // FU-3 · 冷启 audit 结构化字段：录制 writer 断言 session_bootstrap patch 真落 audit 行
  const auditRows: Array<Record<string, unknown>> = []
  h.messageService.setPromptAuditWriter({
    write: (input) => {
      auditRows.push(input as unknown as Record<string, unknown>)
      return { id: auditRows.length }
    },
  })

  const events: RealtimeServerEvent[] = []
  h.messageService.handleClientEvent(
    {
      type: "send_message",
      payload: {
        threadId: "thread-claude",
        provider: "claude",
        alias: "Reviewer",
        content: "F027 统一记忆架构 自动召回 wiring 进展如何",
      },
    },
    (e) => events.push(e),
  )

  await h.fake.firstRun
  assert.equal(h.fake.captured.length, 1, "fake runtime 应被调一次（CLI 没真 spawn）")
  const input = h.fake.captured[0]!
  assert.match(
    input.prompt,
    /\[Recall Pack — Reference Only\]/,
    "冷启命中 → assembleDirectTurnPrompt 必须把 [Recall Pack] 注入 content envelope",
  )
  assert.ok(
    input.prompt.includes("wiki/concepts/F027.md"),
    "Recall Pack 应包含命中 hit 的 path",
  )
  assert.match(input.prompt, /\[\/Recall Pack\]/, "Recall Pack 区段应闭合")

  // FU-3 · 冷启 audit 行：recall 结构化字段不再全空（B1-b-2 P3-6 观测 debt 闭环）
  assert.equal(auditRows.length, 1, "direct turn 应写一行 prompt_audit")
  const row = auditRows[0]!
  assert.equal(row.recallTrigger, "session_bootstrap", "冷启 trigger 应为 session_bootstrap")
  assert.equal(row.recallRequired, true, "search 已注入且冷启 gate 触发 → required=true")
  assert.equal(row.recallSatisfied, true, "有高置信命中 → satisfied=true")
  assert.equal(row.topScore, 0.95, "topScore = 命中最高分")
  assert.equal(row.recallPath, null, "轻量 Pack 非 coordinator executor → path 不冒充")
})

test("FU-1 · wake_up（nativeSessionId 非空）+ coordinator 命中 → [Recall Pack] 注入", async () => {
  const h = makeHarness()
  // wake_up auto-resume 必有 nativeSession（与冷启互斥）
  h.threads[0]!.nativeSessionId = "native-session-1"
  let executorCalled = false
  h.messageService.setAdaptiveRecallCoordinator(
    new AdaptiveRecallCoordinator({
      enabled: true,
      executorDeps: makeStubDeps(),
      executor: async () => {
        executorCalled = true
        return makeExecuteOutput([makeHit("wiki/concepts/seal-resume.md", 0.9)])
      },
    }),
  )

  // wake_up 生产入口 = seal auto-resume（message-service 内部），公开 API 不可达；
  // 这里直接调 private runThreadTurn 显式传 scenario（与生产 caller 同参数形状）。
  const rootMessageId = h.dispatch.registerUserRoot("user-msg-wake", "group-1")
  const result = await (
    h.messageService as unknown as {
      runThreadTurn: (o: {
        threadId: string
        content: string
        emit: (e: RealtimeServerEvent) => void
        rootMessageId: string
        scenario: "wake_up"
      }) => Promise<{ messageId: string; content: string } | null>
    }
  ).runThreadTurn({
    threadId: "thread-claude",
    content: "[auto-resume] 续推上下文",
    emit: () => {},
    rootMessageId,
    scenario: "wake_up",
  })

  assert.notEqual(result, null, "fake runtime 下 turn 应正常完成")
  assert.equal(executorCalled, true, "wake_up 在 coordinator 白名单内，executor 应被调")
  assert.equal(h.fake.captured.length, 1)
  const input = h.fake.captured[0]!
  assert.match(
    input.prompt,
    /\[Recall Pack — Reference Only\]/,
    "wake_up 命中 → [Recall Pack] 必须注入 content envelope",
  )
  assert.ok(input.prompt.includes("wiki/concepts/seal-resume.md"))
})

test("FU-1 · direct_turn（普通用户问答，nativeSessionId 非空）→ scenario_skip → 无 [Recall Pack]", async () => {
  const h = makeHarness()
  h.threads[0]!.nativeSessionId = "native-session-2"
  let executorCalled = false
  h.messageService.setAdaptiveRecallCoordinator(
    new AdaptiveRecallCoordinator({
      enabled: true,
      executorDeps: makeStubDeps(),
      executor: async () => {
        executorCalled = true
        return makeExecuteOutput([makeHit("wiki/x.md", 0.9)])
      },
    }),
  )

  h.messageService.handleClientEvent(
    {
      type: "send_message",
      payload: {
        threadId: "thread-claude",
        provider: "claude",
        alias: "Reviewer",
        content: "继续",
      },
    },
    () => {},
  )

  await h.fake.firstRun
  assert.equal(executorCalled, false, "direct_turn 不在白名单，executor 不该被调（spec line 96）")
  const input = h.fake.captured[0]!
  assert.ok(
    !input.prompt.includes("[Recall Pack"),
    "direct_turn 不召回 → envelope 不得出现 [Recall Pack]",
  )
})
