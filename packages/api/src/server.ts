import crypto from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import cors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import websocket from "@fastify/websocket"
import { PROVIDER_ALIASES } from "@multi-agent/shared"
import Fastify from "fastify"
import { AuthorizationRuleRepository, SessionRepository } from "./db/repositories"
import { SqliteStore } from "./db/sqlite"
import { AppEventBus } from "./events/event-bus"
import { registerMcpServer } from "./mcp/server"
import { ApprovalManager } from "./orchestrator/approval-manager"
import { AuthorizationRuleStore } from "./orchestrator/authorization-rule-store"
import { ChainStarterResolver } from "./orchestrator/chain-starter-resolver"
import { DecisionBoard } from "./orchestrator/decision-board"
import { DecisionManager } from "./orchestrator/decision-manager"
import { DispatchOrchestrator } from "./orchestrator/dispatch"
import { InvocationRegistry } from "./orchestrator/invocation-registry"
import { SettlementDetector } from "./orchestrator/settlement-detector"
import { registerAuthorizationRoutes } from "./routes/authorization"
import { registerCallbackRoutes } from "./routes/callbacks"
import { registerDecisionBoardRoutes } from "./routes/decision-board"
import { registerMessageRoutes } from "./routes/messages"
import { registerRuntimeConfigRoutes } from "./routes/runtime-config"
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
import { setRootLogger } from "./lib/logger"

export async function createApiServer(options: {
  apiBaseUrl: string
  sqlitePath: string
  corsOrigin: string
  redisUrl: string
}) {
  const app = Fastify({ logger: true })
  setRootLogger(app.log)

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    app.log.error({ err: error, url: request.url, method: request.method }, "unhandled error")
    reply.status(error.statusCode ?? 500).send({ error: error.message })
  })
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
  const authRuleRepo = new AuthorizationRuleRepository(sqlite)
  const ruleStore = new AuthorizationRuleStore(authRuleRepo)
  const approvals = new ApprovalManager((event) => broadcaster.broadcast(event), ruleStore)
  messages.setApprovalManager(approvals)
  const skillRegistry = new SkillRegistry()
  const manifestPath = path.resolve(__dirname, "../../../multi-agent-skills/manifest.yaml")
  skillRegistry.loadManifest(manifestPath)
  const sopTracker = new SopTracker()
  const decisions = new DecisionManager((event) => broadcaster.broadcast(event), repository)
  messages.setMemoryService(memoryService)
  messages.setSkillRegistry(skillRegistry)
  messages.setSopTracker(sopTracker)
  messages.setDecisionManager(decisions)

  // F002: Decision Board + settle → flush → single dispatch pipeline.
  // The board holds [拍板] items across raisers (dedupe by normalized
  // question hash). SettlementDetector arms a 2s debounce after each
  // state change and, on fire, verifies the A2A discussion has truly
  // settled (no active parallel group / queued dispatches / running
  // turns) before asking MessageService to flush the board as one
  // decision.board_flush broadcast.
  const decisionBoard = new DecisionBoard()
  const settlementDetector = new SettlementDetector({
    hasActiveParallelGroup: (sg) => messages.hasActiveParallelGroupInSession(sg),
    hasQueuedDispatches: (sg) => dispatch.hasQueuedDispatches(sg),
    hasRunningTurn: (sg) => messages.hasRunningTurn(sg),
  })
  const chainStarterResolver = new ChainStarterResolver({
    listThreadsByGroup: (sessionGroupId) =>
      repository.listThreadsByGroup(sessionGroupId).map((t) => ({
        id: t.id,
        provider: t.provider,
        alias: t.alias,
        sessionGroupId: t.sessionGroupId,
      })),
    listMessages: (threadId) =>
      repository.listMessages(threadId).map((m) => ({
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        threadId: m.threadId,
      })),
    getThread: (threadId) => {
      const t = repository.getThreadById(threadId)
      return t ? { id: t.id, provider: t.provider, alias: t.alias } : null
    },
  })
  messages.setDecisionBoard(decisionBoard)
  messages.setSettlementDetector(settlementDetector)
  messages.setChainStarterResolver(chainStarterResolver)
  messages.setBroadcaster((event) => broadcaster.broadcast(event))

  settlementDetector.on("settle", (payload: { sessionGroupId: string }) => {
    if (!messages.hasPendingBoardEntries(payload.sessionGroupId)) return
    messages.flushDecisionBoard(payload.sessionGroupId)
  })
  app.addHook("onClose", async () => {
    settlementDetector.dispose()
  })
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

  const uploadsDir = path.resolve(__dirname, "../../../.runtime/uploads")
  mkdirSync(uploadsDir, { recursive: true })
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: "/uploads/",
    decorateReply: false,
  })

  app.addHook("onClose", async () => {
    await awaitRunsToStop(invocations.values())
  })

  registerThreadRoutes(app, {
    sessions,
    getRunningThreadIds: () => new Set(invocations.keys()),
    stopThread: (threadId) => messages.cancelThreadChain(threadId, broadcaster.broadcast),
    stopAgent: (threadId, agentId) => messages.cancelSingleAgent(threadId, agentId, broadcaster.broadcast),
    redisSummary,
    getDispatchState: (groupId) => ({
      hasPendingDispatches: dispatch.hasQueuedDispatches(groupId),
      dispatchBarrierActive: dispatch.isSessionGroupCancelled(groupId),
    }),
    flushActiveStreaming: (groupId) => messages.flushActiveStreaming(groupId),
  })
  registerMessageRoutes(app)
  registerRuntimeConfigRoutes(app)
  registerAuthorizationRoutes(app, { approvals, ruleStore })
  registerDecisionBoardRoutes(app, { messageService: messages, decisions })
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
    getRoomSummary: (sessionGroupId) => {
      const summary = memoryService.getLastSummary(sessionGroupId)
      return { summary }
    },
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
    requestDecision: async (sessionGroupId, params) => {
      const selectedIds = await messages.requestDecision({
        kind: "multi_choice",
        title: params.title,
        description: params.description,
        options: params.options,
        sessionGroupId,
        sourceProvider: params.sourceProvider,
        sourceAlias: params.sourceAlias,
        multiSelect: params.multiSelect,
      })
      return { selectedIds }
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
  registerWsRoute(app, {
    messages,
    broadcaster,
    approvals,
    onDecisionRespond: (requestId, decisions_payload, userInput) =>
      decisions.respond(requestId, decisions_payload, userInput),
  })
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
