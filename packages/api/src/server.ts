import crypto from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import cors from "@fastify/cors"
import type { CorsOrigin } from "./config"
import multipart from "@fastify/multipart"
import fastifyStatic from "@fastify/static"
import websocket from "@fastify/websocket"
import { PROVIDER_ALIASES } from "@multi-agent/shared"
import Fastify from "fastify"
import { AuthorizationRuleRepository, SessionRepository } from "./db/repositories"
import { createDrizzleDb } from "./db/drizzle-instance"
import { ensurePreMigrationBackup } from "./db/backup"
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
import { registerSessionRuntimeConfigRoutes } from "./routes/session-runtime-config"
import { registerThreadRoutes } from "./routes/threads"
import { registerUploadRoutes } from "./routes/uploads"
import { registerPreviewRoutes } from "./routes/preview"
import { type RealtimeBroadcaster, registerWsRoute } from "./routes/ws"
import { PreviewGateway } from "./preview/preview-gateway"
import { collectRuntimePorts } from "./preview/port-validator"
import { resolveUploadUrl } from "./preview/resolve-upload-url"
import { captureScreenshot } from "./preview/screenshot-service"
import { listProviderProfiles } from "./runtime/provider-profiles"
import { getRedisReservation } from "./runtime/redis"
import { awaitRunsToStop } from "./runtime/shutdown"
import { MemoryService } from "./services/memory-service"
import { MessageService } from "./services/message-service"
import { WorkflowSopService } from "./services/workflow-sop-service"
import { DrizzleWorkflowSopRepository } from "./db/repositories/workflow-sop-repository"
import { SessionService } from "./services/session-service"
import { SessionTitler } from "./services/session-titler/session-titler"
import { buildTitlePromptFromRecentMessages } from "./services/session-titler/build-title-prompt"
import { backfillHistoricalTitles } from "./services/session-titler/title-backfill"
import { createHaikuRunner } from "./runtime/haiku-runner"
import { SkillRegistry } from "./skills/registry"
import { SopTracker } from "./skills/sop-tracker"
import { createLogger, setRootLogger } from "./lib/logger"

export async function createApiServer(options: {
  apiBaseUrl: string
  sqlitePath: string
  corsOrigin: CorsOrigin
  redisUrl: string
  uploadsDir: string
}) {
  const app = Fastify({ logger: true })
  setRootLogger(app.log)

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    app.log.error({ err: error, url: request.url, method: request.method }, "unhandled error")
    reply.status(error.statusCode ?? 500).send({ error: error.message })
  })
  const providerProfiles = listProviderProfiles()
  ensurePreMigrationBackup(options.sqlitePath)
  const { db: drizzleDb, close: closeDrizzle } = createDrizzleDb(options.sqlitePath)
  const repository = new SessionRepository(drizzleDb)
  // F022 P2: Haiku auto-titler. Fire-and-forget debounced title generation
  // for session groups with a default "新会话 YYYY-MM-DD …" title. See
  // `services/session-titler/*`.
  const haikuRunner = createHaikuRunner()
  const sessionTitler = new SessionTitler({
    repo: repository,
    haiku: haikuRunner,
    logger: createLogger("session-titler"),
    buildPrompt: (sid) => buildTitlePromptFromRecentMessages(sid, repository),
    // AC-14k: the wrapper reads broadcaster.broadcast lazily so it picks up
    // the real implementation once registerWsRoute installs it below.
    emit: (event) => broadcaster.broadcast(event),
  })
  const sessions = new SessionService(repository, providerProfiles, sessionTitler)
  sessions.setBroadcaster((event) => broadcaster.broadcast(event))
  const eventBus = new AppEventBus()
  const broadcaster: RealtimeBroadcaster = {
    broadcast: () => {},
  }
  const invocations = new InvocationRegistry<
    ReturnType<typeof import("./runtime/cli-orchestrator").runTurn>
  >()
  const dispatch = new DispatchOrchestrator(sessions, PROVIDER_ALIASES, invocations)
  // F018 P4: TranscriptWriter instantiation. dataDir = dirname(sqlitePath) so
  // transcripts live under .runtime/threads/... alongside the SQLite file.
  const { TranscriptWriter } = await import("./services/transcript-writer")
  const transcriptWriter = new TranscriptWriter({ dataDir: path.dirname(options.sqlitePath) })
  // F018 P5: EmbeddingService instantiation. Uses a dedicated SqliteStore
  // connection (WAL mode supports concurrent readers + one writer). Embedding
  // writes are rare (per assistant message) so contention is low.
  const { SqliteStore } = await import("./db/sqlite")
  const { EmbeddingService, formatRecallResults } = await import("./services/embedding-service")
  const embeddingStore = new SqliteStore(options.sqlitePath)
  const embeddingService = new EmbeddingService({
    store: embeddingStore,
    // Codex P5 Round 2 MEDIUM: propagate Fastify logger so model-load /
    // inference failures surface to operators instead of being swallowed.
    logger: { warn: (obj, msg) => app.log.warn(obj, msg) },
  })
  const messages = new MessageService(sessions, dispatch, invocations, eventBus, options.apiBaseUrl)
  messages.setTranscriptWriter(transcriptWriter)
  messages.setEmbeddingService(embeddingService)
  const memoryService = new MemoryService(repository)
  const authRuleRepo = new AuthorizationRuleRepository(drizzleDb)
  const ruleStore = new AuthorizationRuleStore(authRuleRepo)
  const approvals = new ApprovalManager((event) => broadcaster.broadcast(event), ruleStore)
  messages.setApprovalManager(approvals)
  const skillRegistry = new SkillRegistry()
  const manifestPath = path.resolve(__dirname, "../../../multi-agent-skills/manifest.yaml")
  skillRegistry.loadManifest(manifestPath)
  const sopTracker = new SopTracker()
  // F019: WorkflowSop state machine (告示牌引擎). P3 Task 3.2 wires it into
  // message-service so every invocation's system prompt carries the
  // sopStageHint when the thread is bound to a feature. HTTP callback + MCP
  // tool (Tasks 3.3/3.4) will be added as more consumers.
  const workflowSopRepo = new DrizzleWorkflowSopRepository(drizzleDb)
  const workflowSopService = new WorkflowSopService(workflowSopRepo)
  const decisions = new DecisionManager((event) => broadcaster.broadcast(event), repository)
  messages.setMemoryService(memoryService)
  messages.setSkillRegistry(skillRegistry)
  messages.setSopTracker(sopTracker)
  messages.setWorkflowSopService(workflowSopService)
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
    eventBus.off("invocation.started", onInvStarted)
    eventBus.off("invocation.activity", onInvActivity)
    eventBus.off("invocation.finished", onInvFinished)
    eventBus.off("invocation.failed", onInvFailed)
    closeDrizzle()
  })
  const redisSummary = getRedisReservation(options.redisUrl)

  const onInvStarted = (event: any) => {
    repository.runTx(() => {
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
        // F021 Phase 3.3: JSON-stringify snapshot for sqlite TEXT column.
        configSnapshot: event.configSnapshot ? JSON.stringify(event.configSnapshot) : null,
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
  }
  eventBus.on("invocation.started", onInvStarted)

  const onInvActivity = (event: any) => {
    repository.runTx(() => {
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
  }
  eventBus.on("invocation.activity", onInvActivity)

  const onInvFinished = (event: any) => {
    repository.runTx(() => {
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
  }
  eventBus.on("invocation.finished", onInvFinished)

  const onInvFailed = (event: any) => {
    repository.runTx(() => {
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
  }
  eventBus.on("invocation.failed", onInvFailed)

  await app.register(cors, {
    origin: options.corsOrigin,
    credentials: true,
  })
  await app.register(websocket)
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } })

  const uploadsDir = options.uploadsDir
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
  registerSessionRuntimeConfigRoutes(app, { sessions: repository })
  registerAuthorizationRoutes(app, { approvals, ruleStore })
  registerDecisionBoardRoutes(app, { messageService: messages, decisions })
  registerUploadRoutes(app, uploadsDir)

  const previewGatewayPort = Number(process.env.PREVIEW_GATEWAY_PORT ?? 0)
  const previewGateway = new PreviewGateway({
    port: previewGatewayPort,
    runtimePorts: collectRuntimePorts(),
  })
  try {
    await previewGateway.start()
  } catch (err) {
    app.log.warn({ err }, "Preview gateway failed to start — screenshot preview will be unavailable")
  }
  app.addHook("onClose", async () => { await previewGateway.stop() })

  registerPreviewRoutes(app, {
    gatewayPort: previewGateway.actualPort,
    runtimePorts: collectRuntimePorts(),
    uploadsDir,
    broadcast: (event) => broadcaster.broadcast(event),
  })

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
    // F018 P5 AC6.3 + B019 review-2 (LL-023 scope 对齐):
    // recall_similar_context backend — semantic search + decay
    // scope: sessionGroup 内所有 threads (clowder-ai thread 等价层)
    // 返回 sanitized reference-only 闭合段格式 + raw hits 给 introspection.
    searchRecall: async ({ threadIds, query, topK }) => {
      // Codex P5 Round 1 MEDIUM: log distinct failure types so operators can
      // differentiate 'model still loading' / 'SQLite lock' / 'schema drift'
      // from a genuine 'no matches' outcome. Response shape stays stable
      // (graceful degradation per 铁律), but the log carries diagnostics.
      try {
        const hits = await embeddingService.searchSimilarFromDb(
          query,
          threadIds,
          topK,
          new Set(),
        )
        return { text: formatRecallResults(hits), hits }
      } catch (err) {
        app.log.warn(
          { err, threadIds, queryLen: query.length, topK },
          "F018 recall backend error (degraded to empty response)",
        )
        return { text: "(no relevant context found)", hits: [] }
      }
    },
    getMemories: (sessionGroupId, keyword) => {
      const memories = keyword
        ? memoryService.searchMemories(keyword).filter((m) => m.sessionGroupId === sessionGroupId)
        : memoryService.getMemoriesForGroup(sessionGroupId)
      return { memories }
    },
    requestPermission: (params) => approvals.requestPermission(params),
    takeScreenshot: async (params) => {
      const result = await captureScreenshot(uploadsDir, params.url)
      const apiBase =
        process.env.NEXT_PUBLIC_API_HTTP_URL ??
        process.env.NEXT_PUBLIC_API_BASE_URL ??
        process.env.NEXT_PUBLIC_API_URL
      const absoluteUrl = resolveUploadUrl(result.url, apiBase)
      const block = {
        type: "image" as const,
        url: absoluteUrl,
        alt: params.alt ?? "Screenshot",
        meta: {
          source: "agent_screenshot",
          timestamp: new Date().toISOString(),
          viewport: { width: result.width, height: result.height },
        },
      }

      const threadMessages = repository.listMessages(params.threadId)
      const lastAssistant = [...threadMessages].reverse().find((m) => m.role === "assistant")
      if (lastAssistant) {
        sessions.appendContentBlock(lastAssistant.id, block)
        broadcaster.broadcast({
          type: "assistant_content_block",
          payload: {
            sessionGroupId: params.sessionGroupId,
            messageId: lastAssistant.id,
            block,
          },
        })
      }

      return { ok: true as const, imageUrl: absoluteUrl }
    },
    // F019 P3: expose the bulletin board service to /api/callbacks/update-workflow-sop
    workflowSopService,
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

  // F022 P3.5 AC-14b: schedule historical title backfill asynchronously.
  // Serial + rate-limited (1s between runs) to avoid bursting Haiku.
  // Gate with MULTI_AGENT_SKIP_TITLE_BACKFILL=1 for tests / ops.
  if (process.env.MULTI_AGENT_SKIP_TITLE_BACKFILL !== "1") {
    const t = setTimeout(() => {
      // review P1-1: listSessionGroups 默认 limit=200 + 过滤归档/软删会让历史数据规模大时
      // 漏扫老会话。专用扫描方法 listSessionGroupsForBackfill 不分页 + 只过滤软删 +
      // 过滤 title_backfill_attempts < MAX。
      void backfillHistoricalTitles(
        {
          listSessionGroups: () => repository.listSessionGroupsForBackfill(),
        },
        sessionTitler,
        { logger: createLogger("title-backfill") },
      )
    }, 5000)
    t.unref?.()
  }

  return app
}
