import type { RealtimeServerEvent } from "@multi-agent/shared"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { SessionRepository } from "../db/repositories"
import type { InvocationRegistry } from "../orchestrator/invocation-registry"
import type { SessionService } from "../services/session-service"
import type { RealtimeBroadcaster } from "./ws"

type CallbackBody = {
  invocationId?: string
  callbackToken?: string
  content?: string
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
    getTaskStatus?: (sessionGroupId: string, agentId?: string) => { agents: Array<{ agentId: string; running: boolean; queueDepth: number }> }
    createTask?: (sessionGroupId: string, params: { assignee: string; description: string; priority?: string; createdBy: string }) => { ok: true; taskId: string }
    triggerMention?: (sessionGroupId: string, params: { targetAlias: string; taskSnippet: string; sourceProvider: import("@multi-agent/shared").Provider; invocationId: string }) => Promise<void> | void
    getMemories?: (sessionGroupId: string, keyword?: string) => { memories: Array<{ id: string; summary: string; keywords: string; createdAt: string }> }
    requestDecision?: (sessionGroupId: string, params: {
      title: string
      description?: string
      options: Array<{ id: string; label: string; description?: string }>
      multiSelect: boolean
      sourceProvider: import("@multi-agent/shared").Provider
      sourceAlias: string
      anchorMessageId?: string
    }) => Promise<{ selectedIds: string[] }>
    parallelThink?: (sessionGroupId: string, params: {
      targets: string[]
      question: string
      callbackTo: string
      sourceProvider: import("@multi-agent/shared").Provider
      invocationId: string
      context?: string
      timeoutMinutes?: number
      idempotencyKey?: string
    }) => Promise<{ ok: true; groupId: string }> | { ok: true; groupId: string }
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

    // Persist first so snapshots and follow-up A2A hops see the same message id and timeline state.
    // Callback messages are intermediate results while the agent is still running.
    const message = options.repository.appendMessage(thread.id, "assistant", body.content.trim(), "", "progress")
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
        payload: { activeGroup },
      })
    }

    return {
      ok: true,
      messageId: message.id,
    }
  })

  app.get("/api/callbacks/thread-context", async (request: FastifyRequest, reply: FastifyReply) => {
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

    const limit = Math.max(1, Math.min(Number(query.limit ?? 40) || 40, 100))
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

  // --- New A2A callback routes ---

  app.get("/api/callbacks/task-status", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { invocationId?: string; callbackToken?: string; agentId?: string }
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
    const body = request.body as CallbackBody & { assignee?: string; description?: string; priority?: string }
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

  app.post("/api/callbacks/trigger-mention", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CallbackBody & { targetAgentId?: string; taskSnippet?: string }
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken)

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
      await options.triggerMention(thread.sessionGroupId, {
        targetAlias: body.targetAgentId.trim(),
        taskSnippet: body.taskSnippet.trim(),
        sourceProvider: thread.provider,
        invocationId: invocation.invocationId,
      })
    }

    return { ok: true }
  })

  app.get("/api/callbacks/memory", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { invocationId?: string; callbackToken?: string; keyword?: string }
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

  app.post("/api/callbacks/request-decision", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CallbackBody & {
      title?: string
      description?: string
      options?: Array<{ id: string; label: string; description?: string }>
      multiSelect?: boolean
      anchorMessageId?: string
    }
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken)

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
  })

  app.post("/api/callbacks/parallel-think", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CallbackBody & {
      targets?: string[]
      question?: string
      callbackTo?: string
      context?: string
      timeoutMinutes?: number
      idempotencyKey?: string
    }
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken)

    if (!invocation) {
      reply.code(401)
      return { error: "Invalid invocation identity." }
    }

    if (!body.targets?.length || !body.question?.trim() || !body.callbackTo?.trim()) {
      reply.code(400)
      return { error: "targets, question, and callbackTo are required." }
    }

    if (body.targets.length > 3) {
      reply.code(400)
      return { error: "Maximum 3 targets allowed." }
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

    if (options.parallelThink) {
      const result = await options.parallelThink(thread.sessionGroupId, {
        targets: body.targets,
        question: body.question.trim(),
        callbackTo: body.callbackTo.trim(),
        sourceProvider: thread.provider,
        invocationId: invocation.invocationId,
        context: body.context,
        timeoutMinutes: body.timeoutMinutes,
        idempotencyKey: body.idempotencyKey,
      })
      return result
    }

    return { ok: true, groupId: `group-${Date.now()}` }
  })

  app.post("/api/callbacks/request-permission", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as CallbackBody & { action?: string; reason?: string; context?: string }
    const invocation = assertInvocation(options.invocations, body.invocationId, body.callbackToken)

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
  })
}
