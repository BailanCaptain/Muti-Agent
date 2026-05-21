import crypto from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import fastifyStatic from "@fastify/static"
import websocket from "@fastify/websocket"
import { PROVIDER_ALIASES } from "@multi-agent/shared"
import Fastify from "fastify"
import type { CorsOrigin } from "./config"
import { ensurePreMigrationBackup } from "./db/backup"
import { createDrizzleDb } from "./db/drizzle-instance"
import { AuthorizationRuleRepository, SessionRepository } from "./db/repositories"
import { DrizzleWorkflowSopRepository } from "./db/repositories/workflow-sop-repository"
import { AppEventBus } from "./events/event-bus"
import { createLogger, setRootLogger } from "./lib/logger"
import { registerMcpServer } from "./mcp/server"
import { installA2AGateway } from "./orchestrator/a2a-gateway-bootstrap"
import { ApprovalManager } from "./orchestrator/approval-manager"
import { AuthorizationRuleStore } from "./orchestrator/authorization-rule-store"
import { ChainStarterResolver } from "./orchestrator/chain-starter-resolver"
import { DecisionBoard } from "./orchestrator/decision-board"
import { DecisionManager } from "./orchestrator/decision-manager"
import { DispatchOrchestrator } from "./orchestrator/dispatch"
import { InvocationRegistry } from "./orchestrator/invocation-registry"
import { SettlementDetector } from "./orchestrator/settlement-detector"
import { collectRuntimePorts } from "./preview/port-validator"
import { PreviewGateway } from "./preview/preview-gateway"
import { resolveUploadUrl } from "./preview/resolve-upload-url"
import { captureScreenshot } from "./preview/screenshot-service"
import { registerAuthorizationRoutes } from "./routes/authorization"
import { registerCallbackRoutes } from "./routes/callbacks"
import { registerDebugA2ARoutes } from "./routes/debug-a2a"
import { registerDecisionBoardRoutes } from "./routes/decision-board"
import { registerMessageRoutes } from "./routes/messages"
import { registerPhase3Routes } from "./routes/phase3"
import { registerPreviewRoutes } from "./routes/preview"
import { registerRuntimeConfigRoutes } from "./routes/runtime-config"
import { registerSessionRuntimeConfigRoutes } from "./routes/session-runtime-config"
import { registerThreadRoutes } from "./routes/threads"
import { registerUploadRoutes } from "./routes/uploads"
import { type RealtimeBroadcaster, registerWsRoute } from "./routes/ws"
import { createHaikuRunner } from "./runtime/haiku-runner"
import { listProviderProfiles } from "./runtime/provider-profiles"
import { getRedisReservation } from "./runtime/redis"
import { bootSchedulerRuntime } from "./runtime/scheduler-bootstrap"
import { awaitRunsToStop } from "./runtime/shutdown"
import { MemoryService } from "./services/memory-service"
import { MessageService } from "./services/message-service"
import { SessionService } from "./services/session-service"
import { buildTitlePromptFromRecentMessages } from "./services/session-titler/build-title-prompt"
import { SessionTitler } from "./services/session-titler/session-titler"
import { backfillHistoricalTitles } from "./services/session-titler/title-backfill"
import { WorkflowSopService } from "./services/workflow-sop-service"
import { SkillRegistry } from "./skills/registry"
import { SopTracker } from "./skills/sop-tracker"
import { MessagesFtsRepository } from "./wiki/wiki-search"
import { createWikiServices } from "./wiki/wiki-services"

/**
 * F026 R-073 · MCP `trigger_mention` 派发 payload 构造器。
 *
 * 把 MCP 程序化派发拼成 `[Call: @<alias> <snippet>]` 严协议格式，
 * dispatch.ts assistant 路径 (F026-P3 方案 X / commit 99d7d9e) 识别后
 * 走标准 directTurn → worklist 续推。
 *
 * F026 P2 v2 Step 7 (clean-cut)：messageType 从 `a2a_handoff_mcp` 改为 `final`，
 * MCP 程序化派发产出与 assistant 自写 [Call:] 通路统一为 final，前端
 * timeline-panel 等价渲染（MessageBubble，非 ConnectorBubble）。老 union
 * 标识符 `a2a_handoff` / `a2a_handoff_mcp` 在 DB schema 保留作历史兼容
 * (Q2=[B])，不再用于新写入。titler 触发由 messageType 判定改为内容前缀
 * 判定（`[Call:` 起头跳过），见 session-service.ts:appendAssistantMessage。
 *
 * 修复前 (R-073) content=`@桂芬 任务X` + messageType=`a2a_handoff` → 严协议
 * 关卡 mentions=[] → 派发链静默死亡 → 桂芬 thread 0 新消息。
 */
export function buildMcpDispatchPayload(
  targetAlias: string,
  taskSnippet: string,
): { content: string; messageType: "final" } {
  return {
    content: `[Call: @${targetAlias} ${taskSnippet}]`,
    messageType: "final",
  }
}

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
  // F027 P14.b: messages_fts BM25 召回 repository — query_messages MCP 后端共享一份实例
  const messagesFtsRepo = new MessagesFtsRepository(drizzleDb)
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
  // F026 P3 sibling-guard · WorklistRegistry 提前创建，传给 installA2AGateway
  // 让 a2a-gateway 反查 caller 的 sibling 集合 —— planBetaDispatch / planAssistantCallTagDispatch
  // 都在 openCall 之前命中即拒（reason=sibling-cross-call）。
  const { WorklistRegistry } = await import("./orchestrator/worklist-registry")
  const worklistRegistry = new WorklistRegistry({ db: embeddingStore.db })
  // F026 · server 启动路径必须装 A2A Gateway hook 才会走 call-registry +
  // envelope 路径；没装 hook 时 dispatch 退回旧 regex 路由，CallRegistry 不写表。
  const { registry: callRegistry } = installA2AGateway(dispatch, {
    db: embeddingStore.db,
    aliases: PROVIDER_ALIASES,
    // F026 P5 T2 · 灰区可观测：a2a-gateway user 路径 classifyMention gray 命中 →
    // broadcaster.broadcast(mention.gray_zone) → 前端 /debug/a2a (F10) 订阅渲染。
    broadcaster: { broadcast: (event) => broadcaster.broadcast(event) },
    worklistRegistry,
  })
  // F026 P1 Wiring + P4 T1 · scan stuck rows → timeout (双档 STALE)：
  //   - working 状态超 deadline_at 转 timeout（processing STALE）
  //   - pending 状态超 A2A_PENDING_STALE_MS from createdAt 转 timeout（queued STALE，默认 60s）
  // 30s cadence 不变；clamp [1s, 10min] · 越界回落 60s + 启动告警。
  const A2A_TIMEOUT_SCAN_INTERVAL_MS = 30_000
  const A2A_PENDING_STALE_MS = ((): number => {
    const raw = Number(process.env.A2A_PENDING_STALE_MS ?? 60_000)
    if (!Number.isFinite(raw) || raw < 1_000 || raw > 600_000) {
      app.log.warn(
        { raw: process.env.A2A_PENDING_STALE_MS },
        "F026 P4 T1 A2A_PENDING_STALE_MS out of [1s, 10min], fallback 60s",
      )
      return 60_000
    }
    return raw
  })()
  const a2aTimeoutScanTimer = setInterval(() => {
    try {
      callRegistry.timeoutScan({ stalePendingMs: A2A_PENDING_STALE_MS })
    } catch (err) {
      app.log.warn({ err }, "F026 P1+P4 timeoutScan failed (non-fatal)")
    }
  }, A2A_TIMEOUT_SCAN_INTERVAL_MS)
  a2aTimeoutScanTimer.unref?.()
  app.addHook("onClose", async () => {
    clearInterval(a2aTimeoutScanTimer)
  })
  const embeddingService = new EmbeddingService({
    store: embeddingStore,
    // Codex P5 Round 2 MEDIUM: propagate Fastify logger so model-load /
    // inference failures surface to operators instead of being swallowed.
    logger: { warn: (obj, msg) => app.log.warn(obj, msg) },
  })
  const messages = new MessageService(sessions, dispatch, invocations, eventBus, options.apiBaseUrl)
  messages.setTranscriptWriter(transcriptWriter)
  messages.setEmbeddingService(embeddingService)
  // F026 P1 Wiring · advance/settle the call_registry row at runThreadTurn's
  // three exits (done / failed / timeout). Without this hook the registry is
  // an island — see docs/plans/F026-p1-wiring-debt-plan.md.
  const { A2ALifecycleService } = await import("./services/a2a-lifecycle")
  const a2aLifecycle = new A2ALifecycleService(callRegistry)
  messages.setA2ALifecycle(a2aLifecycle)
  // F026 P2 v2 · 树形 worklist executor wire —— registerForDispatch / onChildFinished
  // / cascade settle / root-only 续推派发回调。setWorklistExecutor 内部接 setOnDoneContinuation
  // → dispatchWorklistContinuation。WorklistRegistry 已在 installA2AGateway 之前创建
  // （F026 P3 sibling-guard 需要透传给 a2a-gateway）。
  const { WorklistExecutor } = await import("./services/worklist-executor")
  const worklistExecutor = new WorklistExecutor({
    callRegistry,
    worklistRegistry,
  })
  messages.setWorklistExecutor(worklistExecutor)
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
  // F027 P3 chap 6: update_wiki MCP services（lease + ACL + service）。
  // wikiRoot 定位：env > 默认 .runtime/wiki/。leaderTerm 留 P3.5 接 compiler_leader。
  const wikiServices = createWikiServices({
    db: drizzleDb,
    wikiRoot: process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki"),
  })
  const decisions = new DecisionManager((event) => broadcaster.broadcast(event), repository)
  messages.setMemoryService(memoryService)
  messages.setSkillRegistry(skillRegistry)
  messages.setSopTracker(sopTracker)
  messages.setWorkflowSopService(workflowSopService)
  messages.setDecisionManager(decisions)
  // F027 Phase 3 P20 Day 7-8 a · AdaptiveRecallCoordinator boot wiring。
  // Day 7-8 a 注入 noop（enabled=false）— wiring 到位，不真触发 LLM。
  // Phase 4 接 critique LLM + level2-4 backend + Level5Sink 生产实现后，
  // 替换为 new AdaptiveRecallCoordinator({enabled: true, executorDeps, ...})。
  {
    const { createNoopAdaptiveRecallCoordinator } = await import(
      "./orchestrator/adaptive-recall-coordinator"
    )
    messages.setAdaptiveRecallCoordinator(createNoopAdaptiveRecallCoordinator())
  }
  // F027 Phase 3 P20 Day 8 b · PromptAuditWriter boot wiring (AC-P3-9 b)。
  // 真 writer 注入 — 每次 A2A 拼装写一行 prompt_audit row（9 V15.2 Adaptive Recall
  // 字段 + base fields）。prompt-inspector Day 4 endpoint 起就能拿真值。
  // Coordinator 是 noop 时 9 recall fields 走 disabled 默认（recall_required=false 等）。
  {
    const { PromptAuditWriter } = await import("./wiki/prompt-audit/prompt-audit-writer")
    messages.setPromptAuditWriter(new PromptAuditWriter({ db: drizzleDb }))
  }

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
    stopAgent: (threadId, agentId) =>
      messages.cancelSingleAgent(threadId, agentId, broadcaster.broadcast),
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
  registerDebugA2ARoutes(app, { callRegistry })
  registerUploadRoutes(app, uploadsDir)

  const previewGatewayPort = Number(process.env.PREVIEW_GATEWAY_PORT ?? 0)
  const previewGateway = new PreviewGateway({
    port: previewGatewayPort,
    runtimePorts: collectRuntimePorts(),
  })
  try {
    await previewGateway.start()
  } catch (err) {
    app.log.warn(
      { err },
      "Preview gateway failed to start — screenshot preview will be unavailable",
    )
  }
  app.addHook("onClose", async () => {
    await previewGateway.stop()
  })

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
        agents: agentId ? statuses.filter((s) => s.agentId === agentId) : statuses,
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
      const { content, messageType } = buildMcpDispatchPayload(
        params.targetAlias,
        params.taskSnippet,
      )
      const persisted = sessions.appendAssistantMessage(thread.id, content, "", messageType)
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
        const hits = await embeddingService.searchSimilarFromDb(query, threadIds, topK, new Set())
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
    // F027 P3 chap 6: expose wiki services to /api/callbacks/update-wiki + acquire-wiki-lease + read-wiki
    wikiServices,
    // F027 P14.b: messages_fts BM25 召回（query_messages MCP backend）
    queryMessages: ({ roomId, query, topK, threadId, role }) => {
      const hits = messagesFtsRepo.query(query, { roomId, topK, threadId, role })
      return { hits }
    },
  })
  registerWsRoute(app, {
    messages,
    broadcaster,
    approvals,
    onDecisionRespond: (requestId, decisions_payload, userInput) =>
      decisions.respond(requestId, decisions_payload, userInput),
  })
  registerMcpServer(app)

  // F027 Phase 3 P20 · Phase 3 endpoint 集中注册（Week 1 Day 3+ / Week 2 Day 6+）
  // 已 wire：
  //   - GET /api/rooms/:id/viewfinder + GET /api/wiki/drafts (Week 1 Day 3)
  //   - GET /api/rooms/:id/prompt-inspector (Week 1 Day 4)
  //   - POST /api/wiki/ingest/preview (Week 1 Day 5)
  //   - POST /api/rooms/:id/decisions + GET /api/rooms/:id/decisions/coverage (Week 2 Day 6 AC-P3-8)
  //   - POST /api/wiki/ingest/commit (Week 2 Day 9-10 AC-P3-10) — 需 wikiServices 注入
  registerPhase3Routes(app, {
    db: drizzleDb,
    wikiRoot: process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki"),
    wikiServices,
  })

  // F027 Phase 3 P20 · scheduler go-live（Week 1 Day 1）
  //
  // boot 11 真 job adapter + SchedulerRuntime + start；走 fallback config（不等
  // Gate 2）。Iron Laws 3 fail-safe：worktree root 有 wiki.config.yaml 会抛错。
  //
  // MULTI_AGENT_SKIP_SCHEDULER=1 跳过（CI / 单测）。
  // 单元测试用 createApiServer 时默认跳过 — vitest 跑 next-app 组件测试只起 fastify
  // 不应起 scheduler。
  const schedulerRuntime = await bootSchedulerRuntime({
    db: drizzleDb,
    log: app.log,
    // 调度告警走 ws broadcast（lazy resolve broadcaster.broadcast — registerWsRoute
    // 已在上面装好实际实现，此处闭包捕获最新引用）。
    pushAlert: (trace) =>
      broadcaster.broadcast({ type: "scheduler.alert", payload: trace } as never),
    pushChainedAlert: (alert) =>
      broadcaster.broadcast({ type: "scheduler.chained_alert", payload: alert } as never),
    rootDir: process.cwd(),
    skipBoot: process.env.MULTI_AGENT_SKIP_SCHEDULER === "1",
  })
  app.addHook("onClose", async () => {
    if (schedulerRuntime) {
      try {
        await schedulerRuntime.stop()
      } catch (err) {
        app.log.warn({ err }, "schedulerRuntime.stop() threw on close (ignored)")
      }
    }
  })

  Object.assign(app, {
    multiAgentContext: {
      repository,
      sessions,
      invocations,
      schedulerRuntime,
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
