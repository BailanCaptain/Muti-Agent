import type { RealtimeServerEvent } from "@multi-agent/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { SessionRepository } from "../db/repositories"
import {
  FeatureIdMismatchError,
  OptimisticLockError,
} from "../db/repositories/workflow-sop-repository"
import type { InvocationRegistry } from "../orchestrator/invocation-registry"
import type { SessionService } from "../services/session-service"
import type { WorkflowSopService } from "../services/workflow-sop-service"
import { WorkflowSopValidationError, validateUpdateSopBody } from "../services/workflow-sop-service"
import type { UpdateSopInput } from "../services/workflow-sop-types"
import type { WikiAction } from "../wiki/acl-types"
import { WikiPathInvalidError, safeWikiPath } from "../wiki/path-containment"
import type { WikiServices } from "../wiki/wiki-services"
import type { RealtimeBroadcaster } from "./ws"

type CallbackBody = {
  invocationId?: string
  callbackToken?: string
  content?: string
}

// F026 P1 Wiring · T4 dedup constants. Tuned from R-205 evidence: LLM resends
// happened 8–25s after the natural final, full body re-sent verbatim. 60s window
// covers observed delays with safety margin; 80-char prefix avoids false hits on
// short ack-style messages (e.g. "好的我明白了") that LLMs may legitimately repeat.
const POST_MESSAGE_DEDUP_WINDOW_MS = 60_000
const POST_MESSAGE_DEDUP_PREFIX_LEN = 200
const POST_MESSAGE_DEDUP_MIN_LEN = 80

type RecentMessageLike = {
  id: string
  role: string
  content: string
  createdAt: string
}

function detectPostMessageResend(
  recent: ReadonlyArray<RecentMessageLike>,
  incoming: string,
  now: number = Date.now(),
): { id: string } | null {
  if (incoming.length < POST_MESSAGE_DEDUP_MIN_LEN) {
    return null
  }
  const last = recent.find((m) => m.role === "assistant")
  if (!last) {
    return null
  }
  const ageMs = now - new Date(last.createdAt).getTime()
  if (!Number.isFinite(ageMs) || ageMs > POST_MESSAGE_DEDUP_WINDOW_MS || ageMs < 0) {
    return null
  }
  const incomingPrefix = incoming.slice(0, POST_MESSAGE_DEDUP_PREFIX_LEN)
  const lastPrefix = last.content.slice(0, POST_MESSAGE_DEDUP_PREFIX_LEN)
  if (incomingPrefix.length < POST_MESSAGE_DEDUP_MIN_LEN) {
    return null
  }
  if (incomingPrefix !== lastPrefix) {
    return null
  }
  return { id: last.id }
}

function assertInvocation(
  registry: InvocationRegistry<{ cancel: () => void }>,
  invocationId: string | undefined,
  callbackToken: string | undefined,
) {
  if (!invocationId || !callbackToken) {
    return null
  }

  // Callback routes only trust the short-lived identity created for the current CLI turn.
  return registry.verifyInvocation(invocationId, callbackToken)
}

export function registerCallbackRoutes(
  app: FastifyInstance,
  options: {
    repository: SessionRepository
    sessions: SessionService
    broadcaster: RealtimeBroadcaster
    getRunningThreadIds: () => Set<string>
    invocations: InvocationRegistry<{ cancel: () => void }>
    isSessionGroupCancelled: (sessionGroupId: string) => boolean
    emitThreadSnapshot?: (sessionGroupId: string) => void
    onPublicMessage?: (options: {
      threadId: string
      messageId: string
      content: string
      invocationId: string
      emit: (event: RealtimeServerEvent) => void
    }) => Promise<void> | void
    getRoomSummary?: (sessionGroupId: string) => { summary: string | null }
    getTaskStatus?: (
      sessionGroupId: string,
      agentId?: string,
    ) => { agents: Array<{ agentId: string; running: boolean; queueDepth: number }> }
    createTask?: (
      sessionGroupId: string,
      params: { assignee: string; description: string; priority?: string; createdBy: string },
    ) => { ok: true; taskId: string }
    triggerMention?: (
      sessionGroupId: string,
      params: {
        targetAlias: string
        taskSnippet: string
        sourceProvider: import("@multi-agent/shared").Provider
        invocationId: string
      },
    ) => Promise<void> | void
    getMemories?: (
      sessionGroupId: string,
      keyword?: string,
    ) => { memories: Array<{ id: string; summary: string; keywords: string; createdAt: string }> }
    // F018 P5 AC6.3: semantic recall tool backend
    // B019 review-2 (LL-023 scope 对齐): scope 从单 thread 扩到 sessionGroup
    // 内所有 threads (clowder-ai thread = 我们 sessionGroup, 抄实现没抄语义层级)
    searchRecall?: (params: {
      threadIds: string[]
      query: string
      topK: number
    }) => Promise<{
      text: string
      hits: Array<{ messageId: string; chunkText: string; score: number }>
    }>
    // F027 P14.b: messages_fts BM25 召回（搭配 recall_similar_context 语义召回的另一路）
    // scope = roomId 维度（同 session group）；threadId / role 可选过滤。
    queryMessages?: (params: {
      roomId: string
      query: string
      topK: number
      threadId?: string
      role?: string
    }) => {
      hits: Array<{
        messageId: string
        threadId: string
        role: string
        content: string
        createdAt: string
        bm25Rank: number
        score: number
      }>
    }
    // F027 wiring · search_wiki MCP — BM25 over wiki_entity_index（全 wiki scope，可选单桶 scope）。
    // 与 queryMessages 互补：那个搜 raw messages 字面，这个搜已编译 wiki 知识实体。
    searchWiki?: (params: {
      query: string
      topK: number
      scope?: string
    }) => Promise<{
      hits: Array<{ path: string; score: number; excerpt: string }>
    }>
    requestDecision?: (
      sessionGroupId: string,
      params: {
        title: string
        description?: string
        options: Array<{ id: string; label: string; description?: string }>
        multiSelect: boolean
        sourceProvider: import("@multi-agent/shared").Provider
        sourceAlias: string
        anchorMessageId?: string
      },
    ) => Promise<{ selectedIds: string[] }>
    requestPermission?: (params: {
      invocationId: string
      provider: import("@multi-agent/shared").Provider
      agentAlias: string
      threadId: string
      sessionGroupId: string
      action: string
      reason: string
      context?: string
    }) => Promise<{ status: "granted" | "denied" | "timeout" }>
    takeScreenshot?: (params: {
      threadId: string
      sessionGroupId: string
      url?: string
      alt?: string
    }) => Promise<{ ok: true; imageUrl: string }>
    /** F019 P3: WorkflowSop 告示牌引擎. Used by /api/callbacks/update-workflow-sop. */
    workflowSopService?: WorkflowSopService
    /** F027 P3: chap 6 update_wiki MCP — ACL/CAS/lease/fencing 全套。 */
    wikiServices?: WikiServices
  },
) {
  app.post("/api/callbacks/post-message", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CallbackBody
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken)

    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    if (!body.content?.trim()) {
      reply.code(400)
      return { error: "Content is required." }
    }

    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }

    if (options.isSessionGroupCancelled(thread.sessionGroupId)) {
      reply.code(403)
      return { error: "Session group has been cancelled." }
    }

    // F026 P1 Wiring · T5 post-final lockout (R-205+R-048 双发根因)
    // Once the invocation has emitted its final assistant message
    // (markFinalEmitted called from runThreadTurn try-success), any
    // subsequent post_message for the same invocation is a violation of
    // the contract: final is the last word, post_message is for mid-task
    // progress only. Hard-noop here — no append, no broadcast, no
    // re-dispatch. This catches "美化重发" cases that prefix-dedup misses
    // because the LLM rephrased emoji/punctuation. Next @-trigger spawns
    // a fresh invocation; the lockout flag does not carry over.
    if (options.invocations.isFinalEmitted(invocation.invocationId)) {
      return { ok: true, locked: true, reason: "final_already_emitted" }
    }

    // F026 P1 Wiring · T4 dedup gate (R-205 双消息根因)
    // LLM occasionally re-sends its already-final answer via MCP `post_message`
    // (prompt rule violated). Without a hard guard the callback re-persists +
    // re-dispatches, surfacing as duplicate UI bubbles + repeat @-triggers.
    // Rule: if the most recent assistant message in this thread shares ≥80-char
    // prefix and was written within 60s, treat as resend → 200 noop.
    const incomingTrimmed = body.content.trim()
    const dedupHit = detectPostMessageResend(
      options.repository.listRecentMessages?.(thread.id, 1) ?? [],
      incomingTrimmed,
    )
    if (dedupHit) {
      return { ok: true, deduped: true, messageId: dedupHit.id }
    }

    // Persist first so snapshots and follow-up A2A hops see the same message id and timeline state.
    // Callback messages are intermediate results while the agent is still running.
    const message = options.repository.appendMessage(
      thread.id,
      "assistant",
      incomingTrimmed,
      "",
      "progress",
    )
    const activeGroup = options.sessions.getActiveGroup(
      thread.sessionGroupId,
      options.getRunningThreadIds(),
    )
    const timelineMessage = activeGroup.timeline.find(
      (item: { id: string }) => item.id === message.id,
    )

    if (timelineMessage) {
      const event: RealtimeServerEvent = {
        type: "message.created",
        payload: {
          threadId: thread.id,
          sessionGroupId: thread.sessionGroupId,
          message: timelineMessage,
        },
      }
      options.broadcaster.broadcast(event)
    }

    // Public callback messages re-enter dispatch so an agent can @mention the next agent in the chain.
    await options.onPublicMessage?.({
      threadId: thread.id,
      messageId: message.id,
      content: body.content.trim(),
      invocationId: invocation.invocationId,
      emit: options.broadcaster.broadcast,
    })

    if (options.emitThreadSnapshot) {
      options.emitThreadSnapshot(thread.sessionGroupId)
    } else {
      options.broadcaster.broadcast({
        type: "thread_snapshot",
        payload: { sessionGroupId: thread.sessionGroupId, activeGroup },
      })
    }

    return {
      ok: true,
      messageId: message.id,
    }
  })

  app.get("/api/callbacks/room-context", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { invocationId?: string; callbackToken?: string; limit?: string }
    const invocation = assertInvocation(
      options.invocations,
      query.invocationId,
      query.callbackToken,
    )

    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }

    const limit = Math.max(1, Math.min(Number(query.limit ?? 20) || 20, 200))
    const threads = options.repository.listThreadsByGroup(thread.sessionGroupId)
    const messages = threads
      .flatMap((t) =>
        options.repository.listMessages(t.id).map((message) => ({
          id: message.id,
          role: message.role,
          agentId: message.role === "assistant" ? t.alias : undefined,
          content: message.content,
          createdAt: message.createdAt,
        })),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit)

    return {
      threadId: thread.id,
      agentId: invocation.agentId,
      expiresAt: invocation.expiresAt,
      messages,
    }
  })

  app.get("/api/callbacks/room-summary", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { invocationId?: string; callbackToken?: string }
    const invocation = assertInvocation(
      options.invocations,
      query.invocationId,
      query.callbackToken,
    )

    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }

    if (options.getRoomSummary) {
      return options.getRoomSummary(thread.sessionGroupId)
    }

    return { summary: null }
  })

  app.get(
    "/api/callbacks/search-memories",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        invocationId?: string
        callbackToken?: string
        keyword?: string
      }
      const invocation = assertInvocation(
        options.invocations,
        query.invocationId,
        query.callbackToken,
      )

      if (!invocation) {
        reply.code(401)
        return { error: "Invalid invocation identity." }
      }

      if (!query.keyword?.trim()) {
        reply.code(400)
        return { error: "keyword is required." }
      }

      const thread = options.repository.getThreadById(invocation.threadId)
      if (!thread) {
        reply.code(404)
        return { error: "Thread not found." }
      }

      if (options.getMemories) {
        return options.getMemories(thread.sessionGroupId, query.keyword.trim())
      }

      return { memories: [] }
    },
  )

  // F018 P5 AC6.3: recall_similar_context backend — semantic search across
  // the current thread's embedding store (time-decayed cosine), returns
  // `text` (reference-only 闭合段 formatted string) + `hits` (raw).
  app.get(
    "/api/callbacks/recall-similar-context",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        invocationId?: string
        callbackToken?: string
        query?: string
        topK?: string
      }
      const invocation = assertInvocation(
        options.invocations,
        query.invocationId,
        query.callbackToken,
      )
      if (!invocation) {
        reply.code(401)
        return { error: "Invalid invocation identity." }
      }

      const q = query.query?.trim()
      if (!q) {
        reply.code(400)
        return { error: "query is required." }
      }

      const topKParsed = query.topK ? Number.parseInt(query.topK, 10) : 5
      const topK = Number.isFinite(topKParsed) && topKParsed > 0 ? Math.min(topKParsed, 10) : 5

      const thread = options.repository.getThreadById(invocation.threadId)
      if (!thread) {
        reply.code(404)
        return { error: "Thread not found." }
      }

      if (options.searchRecall) {
        // B019 review-2: scope = sessionGroup 内所有 threads
        // (clowder-ai thread 等价我们 sessionGroup, F018 抄实现没抄语义层级 → LL-023 修复)
        const groupThreads = options.repository.listThreadsByGroup(thread.sessionGroupId)
        const threadIds = groupThreads.map((t) => t.id)
        const result = await options.searchRecall({ threadIds, query: q, topK })
        // Codex P5 Round 1 HIGH #1: the endpoint is the last boundary before recall
        // data reaches the agent. Sanitize hits[].chunkText regardless of whether
        // searchRecall already did — Codex/Gemini direct-fetch path only sees hits,
        // not text, so raw historical text would bypass reference-only otherwise.
        const { sanitizeRecallChunk } = await import("../services/embedding-service")
        return {
          text: result.text,
          hits: result.hits.map((h) => ({
            ...h,
            chunkText: sanitizeRecallChunk(h.chunkText),
          })),
        }
      }

      // searchRecall not wired (e.g. pre-P5 deploy) → graceful empty response
      return { text: "(no relevant context found)", hits: [] }
    },
  )

  // F027 P14.b: query_messages MCP backend — BM25 全文召回（搭配 recall_similar_context
  // 语义召回，两路语义/字面）。scope 默认 = 当前 invocation 所在 room；threadId / role
  // 可选过滤。返回 hits 列表给 agent 消费，sanitize 处理同 recall_similar_context。
  app.get("/api/callbacks/query-messages", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      invocationId?: string
      callbackToken?: string
      query?: string
      topK?: string
      threadId?: string
      role?: string
    }
    const invocation = assertInvocation(
      options.invocations,
      query.invocationId,
      query.callbackToken,
    )
    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    const q = query.query?.trim()
    if (!q) {
      reply.code(400)
      return { error: "query is required." }
    }

    const topKParsed = query.topK ? Number.parseInt(query.topK, 10) : 10
    const topK = Number.isFinite(topKParsed) && topKParsed > 0 ? Math.min(topKParsed, 100) : 10

    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }

    const sessionGroup = options.repository.getSessionGroupById(thread.sessionGroupId)
    const roomId = (sessionGroup as { roomId?: string | null } | undefined)?.roomId
    if (!roomId) {
      // session_group 没 roomId（极少；F022 backfillRoomIds 启动时回填，正常路径不应触发）。
      // 范-r1 P3-2：不静默吃；记 warn 让运维能定位 backfill 失漏。返 hits=[] 不阻塞 caller。
      app.log.warn(
        { sessionGroupId: thread.sessionGroupId, threadId: thread.id },
        "F027 P14.b query_messages: session_group missing roomId (F022 backfill drift?) — returning empty",
      )
      return { hits: [] }
    }

    if (options.queryMessages) {
      return options.queryMessages({
        roomId,
        query: q,
        topK,
        threadId: query.threadId?.trim() || undefined,
        role: query.role?.trim() || undefined,
      })
    }

    // queryMessages not wired → graceful empty
    return { hits: [] }
  })

  // F027 wiring · search_wiki MCP backend — BM25 over wiki_entity_index（全 wiki scope）。
  app.get("/api/callbacks/search-wiki", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      invocationId?: string
      callbackToken?: string
      query?: string
      topK?: string
      scope?: string
    }
    const invocation = assertInvocation(options.invocations, query.invocationId, query.callbackToken)
    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    const q = query.query?.trim()
    if (!q) {
      reply.code(400)
      return { error: "query is required." }
    }

    const topKParsed = query.topK ? Number.parseInt(query.topK, 10) : 5
    const topK = Number.isFinite(topKParsed) && topKParsed > 0 ? Math.min(topKParsed, 50) : 5

    if (options.searchWiki) {
      return options.searchWiki({ query: q, topK, scope: query.scope?.trim() || undefined })
    }

    // searchWiki not wired → graceful empty
    return { hits: [] }
  })

  // --- New A2A callback routes ---

  app.get("/api/callbacks/task-status", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      invocationId?: string
      callbackToken?: string
      agentId?: string
    }
    const invocation = assertInvocation(
      options.invocations,
      query.invocationId,
      query.callbackToken,
    )

    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }

    if (options.getTaskStatus) {
      return options.getTaskStatus(thread.sessionGroupId, query.agentId)
    }

    return { agents: [] }
  })

  app.post("/api/callbacks/create-task", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CallbackBody & {
      assignee?: string
      description?: string
      priority?: string
    }
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken)

    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    if (!body.assignee?.trim() || !body.description?.trim()) {
      reply.code(400)
      return { error: "assignee and description are required." }
    }

    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }

    if (options.createTask) {
      return options.createTask(thread.sessionGroupId, {
        assignee: body.assignee.trim(),
        description: body.description.trim(),
        priority: body.priority,
        createdBy: invocation.agentId,
      })
    }

    return { ok: true as const, taskId: `task-${Date.now()}` }
  })

  app.post(
    "/api/callbacks/trigger-mention",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CallbackBody & { targetAgentId?: string; taskSnippet?: string }
      const invocation = assertInvocation(
        options.invocations,
        body.invocationId,
        body.callbackToken,
      )

      if (!invocation) {
        reply.code(401)
        return { error: "Invalid invocation identity." }
      }

      if (!body.targetAgentId?.trim() || !body.taskSnippet?.trim()) {
        reply.code(400)
        return { error: "targetAgentId and taskSnippet are required." }
      }

      const thread = options.repository.getThreadById(invocation.threadId)
      if (!thread) {
        reply.code(404)
        return { error: "Thread not found." }
      }

      if (options.triggerMention) {
        try {
          await options.triggerMention(thread.sessionGroupId, {
            targetAlias: body.targetAgentId.trim(),
            taskSnippet: body.taskSnippet.trim(),
            sourceProvider: thread.provider,
            invocationId: invocation.invocationId,
          })
        } catch (err) {
          // F026 P0 Task4 · P14 痛点：业务失败（目标 alias 不存在 / 派发拒绝）必须冒泡，
          // HTTP 200 合约不变但 body.ok=false；同时 broadcast status 事件让前端 console 可见。
          const msg = err instanceof Error ? err.message : String(err)
          options.broadcaster.broadcast({
            type: "status",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              message: `trigger_mention 失败：${msg}`,
            },
          })
          return { ok: false as const, error: msg }
        }
      }

      return { ok: true as const }
    },
  )

  app.get("/api/callbacks/memory", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as {
      invocationId?: string
      callbackToken?: string
      keyword?: string
    }
    const invocation = assertInvocation(
      options.invocations,
      query.invocationId,
      query.callbackToken,
    )

    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }

    if (options.getMemories) {
      return options.getMemories(thread.sessionGroupId, query.keyword)
    }

    return { memories: [] }
  })

  app.post(
    "/api/callbacks/request-decision",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CallbackBody & {
        title?: string
        description?: string
        options?: Array<{ id: string; label: string; description?: string }>
        multiSelect?: boolean
        anchorMessageId?: string
      }
      const invocation = assertInvocation(
        options.invocations,
        body.invocationId,
        body.callbackToken,
      )

      if (!invocation) {
        reply.code(401)
        return { error: "Invalid invocation identity." }
      }

      if (!body.title?.trim() || !body.options?.length) {
        reply.code(400)
        return { error: "title and options are required." }
      }

      const thread = options.repository.getThreadById(invocation.threadId)
      if (!thread) {
        reply.code(404)
        return { error: "Thread not found." }
      }

      if (options.requestDecision) {
        const result = await options.requestDecision(thread.sessionGroupId, {
          title: body.title.trim(),
          description: body.description,
          options: body.options,
          multiSelect: body.multiSelect ?? false,
          sourceProvider: thread.provider,
          sourceAlias: thread.alias,
          anchorMessageId: body.anchorMessageId,
        })
        return { ok: true, selectedIds: result.selectedIds }
      }

      return { ok: true, selectedIds: body.options.length > 0 ? [body.options[0].id] : [] }
    },
  )

  app.post(
    "/api/callbacks/request-permission",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CallbackBody & {
        action?: string
        reason?: string
        context?: string
      }
      const invocation = assertInvocation(
        options.invocations,
        body.invocationId,
        body.callbackToken,
      )

      if (!invocation) {
        reply.code(401)
        return { error: "Invalid invocation identity." }
      }

      if (!body.action?.trim() || !body.reason?.trim()) {
        reply.code(400)
        return { error: "action and reason are required." }
      }

      const thread = options.repository.getThreadById(invocation.threadId)
      if (!thread) {
        reply.code(404)
        return { error: "Thread not found." }
      }

      if (!options.requestPermission) {
        return { status: "granted" as const }
      }

      const result = await options.requestPermission({
        invocationId: invocation.invocationId,
        provider: thread.provider,
        agentAlias: thread.alias,
        threadId: thread.id,
        sessionGroupId: thread.sessionGroupId,
        action: body.action.trim(),
        reason: body.reason.trim(),
        context: body.context?.slice(0, 5000),
      })

      return result
    },
  )

  app.post(
    "/api/callbacks/take-screenshot",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as CallbackBody & { url?: string; alt?: string }
      const invocation = assertInvocation(
        options.invocations,
        body.invocationId,
        body.callbackToken,
      )

      if (!invocation) {
        reply.code(401)
        return { error: "Invalid invocation identity." }
      }

      const thread = options.repository.getThreadById(invocation.threadId)
      if (!thread) {
        reply.code(404)
        return { error: "Thread not found." }
      }

      if (!options.takeScreenshot) {
        reply.code(501)
        return { error: "Screenshot capability not configured." }
      }

      try {
        const result = await options.takeScreenshot({
          threadId: thread.id,
          sessionGroupId: thread.sessionGroupId,
          url: body.url,
          alt: body.alt,
        })
        return result
      } catch (err) {
        reply.code(500)
        return { error: err instanceof Error ? err.message : "Screenshot failed" }
      }
    },
  )

  // F019 P3: WorkflowSop 告示牌 state machine 推进入口（HTTP 通道；MCP
  // 对等工具在 Task 3.4 挂）。auth 同 post-message；失败映射：
  // 401（auth）/ 400（参数）/ 403（越权）/ 404（thread 不存在）/ 409（写冲突）/ 500（DB 错）
  app.post(
    "/api/callbacks/update-workflow-sop",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = request.body as (CallbackBody & Record<string, unknown>) | undefined
      const invocation = assertInvocation(
        options.invocations,
        rawBody?.invocationId,
        rawBody?.callbackToken,
      )
      if (!invocation) {
        reply.code(401)
        return { error: "Invalid invocation identity." }
      }

      // F019 review-P2 (Codex Finding 3): full-body validation + normalization at
      // the boundary. Upstream agents pass untrusted JSON; validateUpdateSopBody
      // trims IDs, rejects invalid enums, type-checks resumeCapsule/checks/
      // expectedVersion shapes. The service+repo layers trust their input.
      let input: UpdateSopInput
      try {
        input = validateUpdateSopBody({
          ...(rawBody ?? {}),
          // updatedBy is derived from authenticated identity, not caller-supplied
          updatedBy: invocation.agentId,
        })
      } catch (err) {
        if (err instanceof WorkflowSopValidationError) {
          reply.code(400)
          return { error: err.message }
        }
        throw err
      }

      // F019 review-P1 (Codex Finding 1): thread-scope + session-cancelled guards.
      // The caller's invocation can only write to the feature its thread is bound
      // to. Unbound threads and cancelled sessions must be rejected before any
      // DB write — otherwise any valid callback token could mutate foreign SOP rows.
      const thread = options.repository.getThreadById(invocation.threadId)
      if (!thread) {
        reply.code(404)
        return { error: "Thread not found." }
      }
      if (!thread.backlogItemId) {
        reply.code(403)
        return {
          error: "Thread is not bound to any feature; cannot update workflow SOP.",
        }
      }
      if (thread.backlogItemId !== input.backlogItemId) {
        reply.code(403)
        return {
          error: `Thread is bound to "${thread.backlogItemId}", request does not match.`,
        }
      }
      if (options.isSessionGroupCancelled(thread.sessionGroupId)) {
        reply.code(403)
        return { error: "Session group has been cancelled." }
      }

      if (!options.workflowSopService) {
        reply.code(503)
        return { error: "WorkflowSopService not wired" }
      }

      try {
        const sop = options.workflowSopService.upsert(input)
        return { ok: true, sop }
      } catch (err) {
        if (err instanceof OptimisticLockError) {
          reply.code(409)
          return { error: err.message }
        }
        if (err instanceof FeatureIdMismatchError) {
          reply.code(409)
          return { error: err.message }
        }
        if (err instanceof WorkflowSopValidationError) {
          // Defense-in-depth: service-level validation (e.g. invalid stage) should
          // have been caught at the boundary, but map to 400 if it slips through.
          reply.code(400)
          return { error: err.message }
        }
        reply.code(500)
        return { error: err instanceof Error ? err.message : "update-workflow-sop failed" }
      }
    },
  )

  // ─── F027 P3 chap 6 update_wiki MCP: 3 endpoint ──────────────────────────────

  app.post("/api/callbacks/acquire-wiki-lease", async (request, reply) => {
    const body = request.body as {
      invocationId?: string
      callbackToken?: string
      path?: string
      ttlSeconds?: number
    }
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken)
    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }
    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }
    if (!options.wikiServices) {
      reply.code(503)
      return { error: "WikiServices not wired" }
    }
    if (typeof body.path !== "string" || body.path.length === 0) {
      reply.code(400)
      return { error: "path is required" }
    }
    // [范-r1 P1] path containment 早 reject —— 拿到合法 path 才能进 lease 表
    try {
      safeWikiPath(options.wikiServices.wikiRoot, body.path)
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        reply.code(400)
        return { status: "path_invalid", error: err.message }
      }
      throw err
    }
    const lease = options.wikiServices.leases.acquireLease({
      path: body.path,
      ownerAlias: thread.alias,
      ttlSeconds: typeof body.ttlSeconds === "number" ? body.ttlSeconds : 30,
      // P3.5 之前 hardcoded；service.leaderTerm() 才是 wiki_events 写入用的实际 term
      leaderTerm: "term-1",
    })
    if (!lease) {
      reply.code(409)
      return { status: "lease_held", error: "path currently leased by another owner" }
    }
    return { status: "ok", fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }
  })

  app.get("/api/callbacks/read-wiki", async (request, reply) => {
    const query = request.query as {
      invocationId?: string
      callbackToken?: string
      path?: string
    }
    const invocation = assertInvocation(
      options.invocations,
      query.invocationId,
      query.callbackToken,
    )
    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }
    if (!options.wikiServices) {
      reply.code(503)
      return { error: "WikiServices not wired" }
    }
    if (typeof query.path !== "string" || query.path.length === 0) {
      reply.code(400)
      return { error: "path is required" }
    }
    // [范-r1 P1] path containment —— 防 ../../../etc/passwd 通过 fs.readFileSync 暴露
    let abs: string
    try {
      abs = safeWikiPath(options.wikiServices.wikiRoot, query.path)
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        reply.code(400)
        return { status: "path_invalid", error: err.message }
      }
      throw err
    }
    // 简化读：直接 fs 拿 + 算 hash；正式 P4 后用 read_wiki service（含 ACL read 校验）
    const fs = await import("node:fs")
    const crypto = await import("node:crypto")
    try {
      const content = fs.readFileSync(abs, "utf8")
      const hash = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`
      return { status: "ok", content, hash }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "not_found", content: null, hash: null }
      }
      reply.code(500)
      return { error: (err as Error).message }
    }
  })

  app.post("/api/callbacks/update-wiki", async (request, reply) => {
    const body = request.body as {
      invocationId?: string
      callbackToken?: string
      path?: string
      action?: WikiAction
      baseHash?: string | null
      content?: string
      fencingToken?: string
      reason?: string
      sourceMessageIds?: string[]
    }
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken)
    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }
    const thread = options.repository.getThreadById(invocation.threadId)
    if (!thread) {
      reply.code(404)
      return { error: "Thread not found." }
    }
    if (!options.wikiServices) {
      reply.code(503)
      return { error: "WikiServices not wired" }
    }
    if (
      typeof body.path !== "string" ||
      typeof body.action !== "string" ||
      typeof body.content !== "string" ||
      typeof body.fencingToken !== "string"
    ) {
      reply.code(400)
      return { error: "path, action, content, fencingToken are required" }
    }
    const isService = thread.alias.startsWith("system-auto-")
    const result = options.wikiServices.updateWiki.updateWiki(
      {
        path: body.path,
        action: body.action,
        baseHash: body.baseHash ?? null,
        content: body.content,
        fencingToken: body.fencingToken,
        reason: body.reason,
        sourceMessageIds: body.sourceMessageIds,
      },
      { alias: thread.alias, isServiceIdentity: isService },
    )
    if (result.status !== "ok") {
      // 把 service-level reject 映射到 4xx/5xx，让 MCP client 能区分
      const code =
        result.status === "denied_acl"
          ? 403
          : result.status === "lease_expired" || result.status === "stale_token"
            ? 409
            : result.status === "conflict"
              ? 409
              : result.status === "not_implemented"
                ? 501
                : result.status === "internal"
                  ? 500 // [范-r1 P3] atomic_write_failed 走 5xx，不再返 4xx 让 client 按 CAS 重试
                  : 400 // path_invalid / schema_invalid / 缺参
      reply.code(code)
    }
    return result
  })
}
