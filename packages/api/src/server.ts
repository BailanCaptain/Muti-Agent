import crypto from "node:crypto"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import { PROVIDER_ALIASES } from "@multi-agent/shared"
import Fastify from "fastify"
import { SessionRepository } from "./db/repositories"
import { SqliteStore } from "./db/sqlite"
import { AppEventBus } from "./events/event-bus"
import { registerMcpServer } from "./mcp/server"
import { ApprovalManager } from "./orchestrator/approval-manager"
import { DispatchOrchestrator } from "./orchestrator/dispatch"
import { InvocationRegistry } from "./orchestrator/invocation-registry"
import { registerCallbackRoutes } from "./routes/callbacks"
import { registerMessageRoutes } from "./routes/messages"
import { registerThreadRoutes } from "./routes/threads"
import { type RealtimeBroadcaster, registerWsRoute } from "./routes/ws"
import { listProviderProfiles } from "./runtime/provider-profiles"
import { getRedisReservation } from "./runtime/redis"
import { awaitRunsToStop } from "./runtime/shutdown"
import { MemoryService } from "./services/memory-service"
import { MessageService } from "./services/message-service"
import { SessionService } from "./services/session-service"
import { SkillRegistry } from "./skills/registry"
import { SopTracker } from "./skills/sop-tracker"

export async function createApiServer(options: {
  apiBaseUrl: string
  sqlitePath: string
  corsOrigin: string
  redisUrl: string
}) {
  const app = Fastify({ logger: true })
  const providerProfiles = listProviderProfiles()
  const sqlite = new SqliteStore(options.sqlitePath)
  const repository = new SessionRepository(sqlite)
  const sessions = new SessionService(repository, providerProfiles)
  const eventBus = new AppEventBus()
  const broadcaster: RealtimeBroadcaster = {
    broadcast: () => {},
  }
  const invocations = new InvocationRegistry<
    ReturnType<typeof import("./runtime/cli-orchestrator").runTurn>
  >()
  const dispatch = new DispatchOrchestrator(sessions, PROVIDER_ALIASES, invocations)
  const messages = new MessageService(sessions, dispatch, invocations, eventBus, options.apiBaseUrl)
  const memoryService = new MemoryService(repository)
  const approvals = new ApprovalManager((event) => broadcaster.broadcast(event))
  messages.setApprovalManager(approvals)
  const skillRegistry = new SkillRegistry()
  const manifestPath = new URL("../../../multi-agent-skills/manifest.yaml", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")
  skillRegistry.loadManifest(manifestPath)
  const sopTracker = new SopTracker()
  messages.setSkillRegistry(skillRegistry)
  messages.setSopTracker(sopTracker)
  const redisSummary = getRedisReservation(options.redisUrl)

  eventBus.on("invocation.started", (event) => {
    repository.createInvocation({
      id: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      callbackToken: event.callbackToken,
      status: event.status,
      startedAt: event.createdAt,
      finishedAt: null,
      exitCode: null,
      lastActivityAt: event.createdAt,
    })

    repository.appendAgentEvent({
      id: crypto.randomUUID(),
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      eventType: event.type,
      payload: JSON.stringify(event),
      createdAt: event.createdAt,
    })
  })

  eventBus.on("invocation.activity", (event) => {
    repository.updateInvocation(event.invocationId, {
      status: event.status,
      lastActivityAt: event.createdAt,
    })

    repository.appendAgentEvent({
      id: crypto.randomUUID(),
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      eventType: `${event.type}.${event.stream}`,
      payload: JSON.stringify({
        status: event.status,
        chunkPreview: event.chunk.slice(0, 500),
      }),
      createdAt: event.createdAt,
    })
  })

  eventBus.on("invocation.finished", (event) => {
    repository.updateInvocation(event.invocationId, {
      status: event.status,
      finishedAt: event.createdAt,
      exitCode: event.exitCode,
      lastActivityAt: event.createdAt,
    })

    repository.appendAgentEvent({
      id: crypto.randomUUID(),
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      eventType: event.type,
      payload: JSON.stringify(event),
      createdAt: event.createdAt,
    })
  })

  eventBus.on("invocation.failed", (event) => {
    repository.updateInvocation(event.invocationId, {
      status: event.status,
      finishedAt: event.createdAt,
      exitCode: event.exitCode,
      lastActivityAt: event.createdAt,
    })

    repository.appendAgentEvent({
      id: crypto.randomUUID(),
      invocationId: event.invocationId,
      threadId: event.threadId,
      agentId: event.agentId,
      eventType: event.type,
      payload: JSON.stringify(event),
      createdAt: event.createdAt,
    })
  })

  await app.register(cors, {
    origin: options.corsOrigin,
    credentials: true,
  })
  await app.register(websocket)
  app.addHook("onClose", async () => {
    await awaitRunsToStop(invocations.values())
  })

  registerThreadRoutes(app, {
    sessions,
    getRunningThreadIds: () => new Set(invocations.keys()),
    stopThread: (threadId) => messages.cancelThreadChain(threadId, broadcaster.broadcast),
    redisSummary,
    getDispatchState: (groupId) => ({
      hasPendingDispatches: dispatch.hasQueuedDispatches(groupId),
      dispatchBarrierActive: dispatch.isSessionGroupCancelled(groupId),
    }),
  })
  registerMessageRoutes(app)
  registerCallbackRoutes(app, {
    repository,
    sessions,
    broadcaster,
    getRunningThreadIds: () => new Set(invocations.keys()),
    invocations,
    isSessionGroupCancelled: (sessionGroupId) => dispatch.isSessionGroupCancelled(sessionGroupId),
    emitThreadSnapshot: (sessionGroupId) =>
      messages.emitThreadSnapshot(sessionGroupId, broadcaster.broadcast),
    onPublicMessage: (options) => messages.handleAgentPublicMessage(options),
    getTaskStatus: (sessionGroupId, agentId) => {
      const statuses = dispatch.getAgentStatuses(sessionGroupId)
      return {
        agents: agentId
          ? statuses.filter((s) => s.agentId === agentId)
          : statuses,
      }
    },
    createTask: (sessionGroupId, params) => {
      const task = repository.createTask(
        sessionGroupId,
        params.assignee,
        params.description,
        params.createdBy,
        params.priority,
      )
      return { ok: true as const, taskId: task.id }
    },
    triggerMention: async (sessionGroupId, params) => {
      const thread = sessions.findThreadByGroupAndProvider(sessionGroupId, params.sourceProvider)
      if (!thread) return
      const content = `@${params.targetAlias} ${params.taskSnippet}`
      const persisted = sessions.appendAssistantMessage(thread.id, content, "", "a2a_handoff")
      await messages.handleAgentPublicMessage({
        threadId: thread.id,
        messageId: persisted.id,
        content,
        invocationId: params.invocationId,
        emit: broadcaster.broadcast,
      })
    },
    parallelThink: async (sessionGroupId, params) => {
      return messages.handleParallelThink(sessionGroupId, {
        ...params,
        emit: broadcaster.broadcast,
      })
    },
    getMemories: (sessionGroupId, keyword) => {
      const memories = keyword
        ? memoryService.searchMemories(keyword).filter((m) => m.sessionGroupId === sessionGroupId)
        : memoryService.getMemoriesForGroup(sessionGroupId)
      return { memories }
    },
    requestPermission: (params) => approvals.requestPermission(params),
  })
  registerWsRoute(app, { messages, broadcaster, approvals })
  registerMcpServer(app)

  Object.assign(app, {
    multiAgentContext: {
      repository,
      sessions,
      invocations,
    },
  })

  return app
}
