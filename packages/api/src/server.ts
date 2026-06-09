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
import { registerPhase4Routes } from "./routes/phase4"
import { registerPreviewRoutes } from "./routes/preview"
import { registerRuntimeConfigRoutes } from "./routes/runtime-config"
import { registerSessionRuntimeConfigRoutes } from "./routes/session-runtime-config"
import { registerThreadRoutes } from "./routes/threads"
import { registerUploadRoutes } from "./routes/uploads"
import { type RealtimeBroadcaster, registerWsRoute } from "./routes/ws"
import { createHaikuRunner, createOpusRunner, createSonnetRunner } from "./runtime/haiku-runner"
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
import {
  MessagesFtsRepository,
  SearchWikiProvider,
  WikiEntityFtsProvider,
  reindexWikiEntities,
} from "./wiki/wiki-search"
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
  // F027 wiring · search_wiki MCP backend：BM25 加权读 wiki_entity_index（name 5x body）。
  // Phase 4 hybrid 退化为 BM25-only（无 embedded records），与 adaptive-recall Level 2 同源。
  const searchWikiProvider = new SearchWikiProvider(new WikiEntityFtsProvider(drizzleDb))
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
  // F027 P4 AC-P4-9 d5 · worktree-preview-only data seed loader. Double gate:
  // WORKTREE_PREVIEW=1 (scripts/worktree-preview.ts) + sqlitePath containing
  // .runtime/worktree-preview/. Both off in prod → no-op. Per-table idempotent +
  // single tx + fail-closed on fixture schema invalid. 5 unit tests cover all paths.
  const { applyWorktreePreviewSeed } = await import("./db/worktree-preview-seed")
  const seedReport = applyWorktreePreviewSeed({
    db: embeddingStore.db,
    sqlitePath: options.sqlitePath,
  })
  if (seedReport.inserted) {
    console.log(
      `[worktree-preview-seed] inserted: room_decisions=${seedReport.inserted.room_decisions}, ` +
      `wiki_events=${seedReport.inserted.wiki_events}, wiki_leases=${seedReport.inserted.wiki_leases}`,
    )
  } else if (seedReport.failed) {
    console.error(`[worktree-preview-seed] FAILED stage=${seedReport.failed.stage}: ${seedReport.failed.error}`)
  }
  // F027 P4 AC-P4-9 a/b · worktree-preview wiki/{warnings,index}/*.md fixture copier.
  // 同 gate 模式 (WORKTREE_PREVIEW=1 + .runtime/worktree-preview/ path check)。
  // destWikiRoot 从 sqlitePath 推 (路径同根: .runtime/worktree-preview/data/{multi-agent.sqlite,wiki/})
  // 跟 plan AC-P4-9 a/b line 253-254 显式目标路径一致。
  // Note: 当前 wikiServices.wikiRoot 用 process.env.WIKI_ROOT || cwd/.runtime/wiki/，
  //       跟 fixture copier dest 不一致 (pre-existing 配置 mismatch — Week 5 follow-up)。
  const { applyWorktreePreviewWikiFixtures } = await import("./db/worktree-preview-wiki-fixtures")
  const destWikiRoot = path.join(path.dirname(options.sqlitePath), "wiki")
  const wikiFixturesReport = applyWorktreePreviewWikiFixtures({ destWikiRoot })
  if (!wikiFixturesReport.gateClosed) {
    for (const [bucket, status] of Object.entries(wikiFixturesReport.buckets)) {
      if (!status) continue
      if ("copied" in status) {
        console.log(`[worktree-preview-wiki-fixtures] ${bucket}: copied ${status.copied} files`)
      } else if ("skipped" in status) {
        console.log(`[worktree-preview-wiki-fixtures] ${bucket}: skipped (${status.existingFiles} existing)`)
      } else if ("failed" in status) {
        console.error(`[worktree-preview-wiki-fixtures] ${bucket}: FAILED ${status.failed}`)
      }
    }
  }
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
  // F027 wiring · wiki 写 commit → 触发 search index 增量 reindex。debounce 在 scheduler
  // boot 内建（晚于此处），故用 forwarder late-bind：boot 后 registerOnWikiCommit 回填 fireWikiCommit。
  let fireWikiCommit: (() => void) | undefined
  const wikiServices = createWikiServices({
    db: drizzleDb,
    wikiRoot: process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki"),
    onCommit: () => fireWikiCommit?.(),
  })
  const decisions = new DecisionManager((event) => broadcaster.broadcast(event), repository)
  messages.setMemoryService(memoryService)
  messages.setSkillRegistry(skillRegistry)
  messages.setSopTracker(sopTracker)
  messages.setWorkflowSopService(workflowSopService)
  messages.setDecisionManager(decisions)
  // F027 Phase 4 P4 Day 4 · AdaptiveRecallCoordinator 真启用 (AC-P4-8)。
  // 装配 5 级 ExecutorDeps + ProductionLevel5Sink + 启用 wake_up/a2a_handoff 触发。
  //
  // codex Week 5 j2 FAIL P4-8 (e2) Red→Green: NotificationBroadcast 接入 —
  // RealtimeServerEvent union 已加 'recall.escalated' (shared/realtime.ts) + 写
  // RealtimeAuditBroadcaster adapter (wiki/adaptive-recall/realtime-audit-broadcaster.ts)
  // 把 ProductionLevel5Sink 的 AuditBroadcaster 接到 RealtimeBroadcaster (WS pub/sub)。
  //
  // prompt_audit 9 字段写入由 PromptAuditWriter (line 266) 负责，跟 Coordinator
  // 启用解耦：Coordinator enabled=true → 9 字段填真 recall output；
  // enabled=false → 9 字段走 disabled 默认（recall_required=false 等）。
  {
    const { AdaptiveRecallCoordinator } = await import(
      "./orchestrator/adaptive-recall-coordinator"
    )
    const {
      createHybridWikiSearchProvider,
      createProductionRecallExecutorDeps,
      createSimpleLeaderContext,
    } = await import("./orchestrator/production-recall-executor-deps")
    const { ProductionLevel5Sink } = await import("./wiki/adaptive-recall/level5-escalate-sink")
    const { createRealtimeAuditBroadcaster } = await import(
      "./wiki/adaptive-recall/realtime-audit-broadcaster"
    )
    const { WikiEventsRepository } = await import("./db/repositories/wiki-events-repository")

    const wikiEventsRepo = new WikiEventsRepository(drizzleDb)
    const auditBroadcaster = createRealtimeAuditBroadcaster(broadcaster)
    const level5 = new ProductionLevel5Sink({
      wikiEventsRepo,
      leaderContext: createSimpleLeaderContext(),
      broadcaster: auditBroadcaster,
    })
    // F027 #286 FU-2 · 冷启召回与 coordinator Level 2 共享同一 hybrid provider（B1-b-2 P3-5）。
    // 今天 embedded records 空 → 退化 BM25-only（与原 SearchWikiProvider 注入行为等价）；
    // F028 boot-load embedded records 后冷启 + coordinator 一起升级语义召回。
    const hybridWikiSearch = createHybridWikiSearchProvider({ drizzleDb, embeddingService })
    const executorDeps = createProductionRecallExecutorDeps({
      drizzleDb,
      wikiRoot: process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki"),
      messagesFtsRepo,
      embeddingService,
      level5,
      hybridSearch: hybridWikiSearch,
    })

    // codex r1 P2-1 修: DEFAULT_RECALL_BUDGET.maxLevels=3 (defaults.ts) — 不传
    // defaultBudget.maxLevels 时 Level 4 read_wiki backend 永远没跑 (跟 boot log "levels=[2,3,4,5]"
    // 不符 — 虚假承诺)。wire 时显式 override maxLevels=5 让 critique 真按 5 级阶梯走。
    messages.setAdaptiveRecallCoordinator(
      new AdaptiveRecallCoordinator({
        enabled: true,
        executorDeps,
        defaultBudget: { maxLevels: 5 },
      }),
    )
    // F027 B1-b-2 · 冷启 loadTaskMemoryPack 搜索 backend（北极星「新 agent 进新 room 不白板」）。
    // FU-2（B1-b-2 P3-5）：从 search_wiki MCP 的 SearchWikiProvider 切到 coordinator Level 2
    // 同一 hybrid 实例 —— 召回 backend 同源，行为今天等价（空 embedded records 退化 BM25）。
    messages.setMemoryPreflightSearch(hybridWikiSearch)
    // eslint-disable-next-line no-console
    console.log(
      "[F027-P4 AC-P4-8] AdaptiveRecallCoordinator wired: enabled=true, levels=[2,3,4,5], maxLevels=5, broadcaster=on",
    )
  }
  // F027 Phase 3 P20 Day 8 b · PromptAuditWriter boot wiring (AC-P3-9 b)。
  // 真 writer 注入 — 每次 A2A 拼装写一行 prompt_audit row（9 V15.2 Adaptive Recall
  // 字段 + base fields）。prompt-inspector Day 4 endpoint 起就能拿真值。
  // Coordinator 是 noop 时 9 recall fields 走 disabled 默认（recall_required=false 等）。
  {
    const { PromptAuditWriter } = await import("./wiki/prompt-audit/prompt-audit-writer")
    messages.setPromptAuditWriter(new PromptAuditWriter({ db: drizzleDb }))
  }

  // F027 P4 hotfix · ViewfinderLoader boot wiring（V16.5 §11 + §4 line 396 + §18 line 2117）。
  // direct turn + A2A caller 用它读 wiki/rooms/<roomId>/viewfinder.md body 注入 assemblePrompt.viewfinder。
  // Phase 1-3 RoomCompiler 写出 viewfinder.md（writer 侧已通），但 reader 侧从未接通 —
  // viewfinder 永远不进 agent prompt。本 hotfix 接通最后一公里。
  {
    const { ViewfinderService } = await import("./routes/phase3/viewfinder")
    const viewfinderSvc = new ViewfinderService({
      db: drizzleDb,
      wikiRoot: process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki"),
    })
    messages.setViewfinderLoader(async (roomId) => {
      const r = await viewfinderSvc.getViewfinder(roomId).catch(() => null)
      return r?.viewfinder ? { body: r.viewfinder } : null
    })
  }
    // F027 P4-A1 + fallback j2 P2 修 · CapabilityRegistry boot wiring (V16.5 §13 + §4 fail-closed)。
    // V16.5 §4 强契约: "wiki 缺失行为: fail-closed 拒启 agent"。
    // 默认 fail-closed (boot 抛错让 process 退出)；ENV `MULTI_AGENT_WIKI_LOADER_FAIL_SOFT=1`
    // 显式 opt-in degraded mode（worktree-preview / 单测 fixture 不全 wiki 时用）。
    const wikiLoaderFailSoft = process.env.MULTI_AGENT_WIKI_LOADER_FAIL_SOFT === "1"
    try {
      const { loadCapabilityRegistryFromRoot } = await import(
        "./wiki/capability-registry/loader"
      )
      const capRoot = process.env.CAPABILITY_REGISTRY_ROOT || process.cwd()
      const registry = loadCapabilityRegistryFromRoot(capRoot)
      messages.setCapabilityRegistry(registry)
      // eslint-disable-next-line no-console
      console.log(
        `[F027-P4-A1] CapabilityRegistry loaded: ${registry.agents.size} agents (sourcePath=${registry.sourcePath})`,
      )
    } catch (err) {
      const msg = `[F027-P4-A1] CapabilityRegistry load failed: ${(err as Error).message}`
      if (wikiLoaderFailSoft) {
        // eslint-disable-next-line no-console
        console.warn(`${msg} — degraded mode (MULTI_AGENT_WIKI_LOADER_FAIL_SOFT=1)`)
      } else {
        // V16.5 §4 fail-closed: 拒启 agent，避免 silent capability_digest 缺失污染 prompt
        throw new Error(
          `${msg}\n  → V16.5 §4 fail-closed: process abort. Set MULTI_AGENT_WIKI_LOADER_FAIL_SOFT=1 to opt-in degraded mode (dev only).`,
        )
      }
    }
    try {
      const { loadHandbookSlices } = await import("./wiki/handbook-slicer")
      const handbookRoot = process.env.WIKI_HANDBOOK_ROOT || process.cwd()
      const slices = await loadHandbookSlices(handbookRoot)
      messages.setHandbookSlices({ agentActions: slices.agentActions })
      // eslint-disable-next-line no-console
      console.log(
        `[F027-P4-A2] Handbook agentActions slice loaded: ${slices.agentActions.length} chars (handbookRoot=${handbookRoot})`,
      )
    } catch (err) {
      const msg = `[F027-P4-A2] Handbook slice load failed: ${(err as Error).message}`
      if (wikiLoaderFailSoft) {
        // eslint-disable-next-line no-console
        console.warn(`${msg} — degraded mode (MULTI_AGENT_WIKI_LOADER_FAIL_SOFT=1)`)
      } else {
        // V16.5 §4 fail-closed (同上)
        throw new Error(
          `${msg}\n  → V16.5 §4 fail-closed: process abort. Set MULTI_AGENT_WIKI_LOADER_FAIL_SOFT=1 to opt-in degraded mode (dev only).`,
        )
      }
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
    // F027 wiring · search_wiki MCP backend — BM25 over wiki_entity_index（全 wiki scope，可选单桶）。
    searchWiki: async ({ query, topK, scope }) => {
      const hits = await searchWikiProvider.search(query, { topK, scope })
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
  // F027 final-vision P1-2 · 共享 ingest services（routes 和 docs-watcher 同一 PreviewStore）
  const { PreviewStore: PreviewStoreCls, IngestPreviewService: IngestPreviewServiceCls, IngestCommitService: IngestCommitServiceCls } =
    await import("./routes/phase3")
  const sharedPreviewStore = new PreviewStoreCls()

  // F027 AC-P1-5 · multi-drop 历史语料库 repository（commit 写 / preview 查 7 天窗口）
  const { RecentDropsRepository } = await import("./db/repositories/recent-drops-repository")
  const recentDropsRepo = new RecentDropsRepository(drizzleDb)

  // F027 v3 G11 · 给 ingest preview 注入真 LLM compile pipeline 依赖（Opus 4.7 + Haiku fallback）。
  // 注入后用户 drop 资料 → preview 真编译产 cross_refs/dedup/canonical_owner，commit 落盘编译产物。
  //   - wikiRoot 用 `<services>/wiki`（双 wiki，与 G2 r2 / roomCompileWikiRoot 同口径 — 真 entity 在此根下）。
  //   - compileRules 单独从 handbook 取（line 380 只取了 agentActions）；load 失败退空串（fail-soft）。
  //   - llmClient = Opus 4.7 primary + Haiku 4.5 fallback（AC-P4-8 链；haiku-runner createOpusRunner 已有）。
  const { createRunnerWithFallback: createCompileRunnerWithFallback } = await import(
    "./runtime/runner-with-fallback"
  )
  const { createProductionCompileLLMClient } = await import(
    "./wiki/llm-compile/production-compile-llm-client"
  )
  const { createProductionIndexLiteLoader } = await import(
    "./wiki/llm-compile/index-lite-loader"
  )
  const { createProductionEntityExistenceChecker } = await import(
    "./wiki/llm-compile/entity-existence-checker"
  )
  const ingestCompileWikiRoot = path.join(
    process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki"),
    "wiki",
  )
  let ingestCompileRules = ""
  try {
    const { loadHandbookSlices } = await import("./wiki/handbook-slicer")
    const handbookRoot = process.env.WIKI_HANDBOOK_ROOT || process.cwd()
    ingestCompileRules = (await loadHandbookSlices(handbookRoot)).compileRules
  } catch (err) {
    app.log.warn(
      { err },
      "[F027-G11] handbook compileRules load failed; ingest compile uses empty rules",
    )
  }
  const sharedIngestPreview = new IngestPreviewServiceCls({
    store: sharedPreviewStore,
    compile: {
      embedding: embeddingService,
      indexLoader: createProductionIndexLiteLoader({ wikiRoot: ingestCompileWikiRoot }),
      entityChecker: createProductionEntityExistenceChecker({ wikiRoot: ingestCompileWikiRoot }),
      llmClient: createProductionCompileLLMClient({
        runner: createCompileRunnerWithFallback({
          primary: createOpusRunner(),
          fallback: createHaikuRunner(),
        }),
        // codex P3(G11)：接生产 logger，让 Opus→Haiku fallback 成功(质量降级)可观测。
        logger: (msg: string) => app.log.info({ component: "ingest-compile-llm" }, msg),
      }),
      handbookCompileRules: ingestCompileRules,
      logger: (msg) => app.log.info({ component: "ingest-compile" }, msg),
    },
    // F027 AC-P1-5 · multi-drop 关联检测（preview 时 embed current + 查 7 天窗口 → crossCorrelate）
    correlate: {
      embedding: embeddingService,
      recentDrops: recentDropsRepo,
      logger: (msg: string) => app.log.info({ component: "ingest-correlate" }, msg),
    },
  })
  const sharedIngestCommit = wikiServices
    ? new IngestCommitServiceCls({
        store: sharedPreviewStore,
        updateWiki: wikiServices.updateWiki,
        leases: wikiServices.leases,
        leaderTerm: () => wikiServices.leader.getCurrent()?.currentTerm ?? "0",
        // F027 AC-P1-5 · commit 成功后写 recent_drops（用 preview 算好的 embedding）
        recentDrops: recentDropsRepo,
      })
    : undefined

  registerPhase3Routes(app, {
    db: drizzleDb,
    wikiRoot: process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki"),
    wikiServices,
    sharedIngestServices: {
      previewStore: sharedPreviewStore,
      ingestPreview: sharedIngestPreview,
      ingestCommit: sharedIngestCommit,
    },
  })

  // F027 Phase 4 P4 Day 7 · AC-P4-1 PromoteModal endpoints
  //   - POST /api/wiki/drafts/promote/preview  (V14 audit preview)
  //   - POST /api/wiki/drafts/promote          (full promote: V14 + mv + wiki_events)
  //   - POST /api/wiki/drafts/batch-promote   (Day 11 AC-P4-4)
  //   - GET  /api/wiki/warnings + /api/wiki/index (Day 17 AC-P4-9 a/b)
  //
  // codex Week 4 mid-r1 P1 修: metaWikiRoot 仅在 worktree-preview 模式下覆盖 wikiServices.wikiRoot;
  // 否则 default fallback wikiServices.wikiRoot (prod 部署 / WIKI_ROOT env 路径正确)
  const isWorktreePreview =
    process.env.WORKTREE_PREVIEW === "1" &&
    options.sqlitePath.replace(/\\/g, "/").includes(".runtime/worktree-preview/")
  registerPhase4Routes(app, {
    wikiServices,
    metaWikiRoot: isWorktreePreview ? destWikiRoot : undefined,
  })

  // F027 Phase 3 P20 · scheduler go-live（Week 1 Day 1）
  //
  // boot 11 真 job adapter + SchedulerRuntime + start；走 fallback config（不等
  // Gate 2）。Iron Laws 3 fail-safe：worktree root 有 wiki.config.yaml 会抛错。
  //
  // MULTI_AGENT_SKIP_SCHEDULER=1 跳过（CI / 单测）。
  // 单元测试用 createApiServer 时默认跳过 — vitest 跑 next-app 组件测试只起 fastify
  // 不应起 scheduler。
  // Week 5 hotfix · 真 RoomCompiler 接入 (小孙浏览器实测 viewfinder=null 根因修).
  // 复用 P4-8 Sonnet+Haiku fallback runner 作为 judge runner (Sonnet 决策识别 +
  // quota fail 降级 Haiku).
  const { createProductionRoomCompileExecutor, createSingleRoomRecompiler } = await import(
    "./orchestrator/production-room-compile-executor"
  )
  const { createRunnerWithFallback } = await import("./runtime/runner-with-fallback")
  const { createSimpleLeaderContext } = await import(
    "./orchestrator/production-recall-executor-deps"
  )
  const judgeRunner = createRunnerWithFallback({
    primary: createSonnetRunner(),
    fallback: createHaikuRunner(),
  })
  // ViewfinderService 读 `<wikiRoot>/wiki/rooms/<id>/viewfinder.md`
  // (注意 path.join wikiRoot + "wiki" + "rooms"); 但 RoomCompiler.run() 直接
  // 写 `<wikiRoot>/rooms/<id>/viewfinder.md`. 让 RoomCompileExecutor 用
  // `<wikiServicesRoot>/wiki/` 作 wikiRoot — 写 `<wikiServicesRoot>/wiki/rooms/...`
  // 跟 ViewfinderService 期望对齐.
  const roomCompileWikiServicesRoot =
    process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki")
  const roomCompileWikiRoot = path.join(roomCompileWikiServicesRoot, "wiki")
  // F027 P4 hotfix · WikiEventsSink wrap — 让 RoomCompiler 写 viewfinder.md 时留 wiki_events row
  // (V16.5 §5 line 452 "所有 wiki 写操作走 append-only event log")。
  // Prompt Inspector 「追溯 wiki 事件」按钮按 path 反查这条 row。
  const { WikiEventsRepository: WikiEventsRepoCls } = await import(
    "./db/repositories/wiki-events-repository"
  )
  const wikiEventsRepoForCompiler = new WikiEventsRepoCls(drizzleDb)
  const roomCompileWikiEventsSink: import(
    "./wiki/room-compiler/room-compiler"
  ).WikiEventsSinkLike = {
    appendPending: (input) => {
      const evt = wikiEventsRepoForCompiler.appendPending(input)
      return { id: evt.id }
    },
    commit: (id, input) => wikiEventsRepoForCompiler.commit(id, input),
    abort: (id, input) => wikiEventsRepoForCompiler.abort(id, input),
  }
  const roomCompileSharedOpts = {
    db: drizzleDb,
    wikiRoot: roomCompileWikiRoot,
    judgeRunner,
    leaderContext: createSimpleLeaderContext(),
    logger: app.log,
    rootDir: process.cwd(),
    wikiEventsSink: roomCompileWikiEventsSink,
  }
  const roomCompileExecutor = createProductionRoomCompileExecutor(roomCompileSharedOpts)
  // F027 P4 hotfix · single-room recompile (POST /api/rooms/:id/viewfinder/recompile)
  const singleRoomRecompiler = createSingleRoomRecompiler(roomCompileSharedOpts)
  {
    const { registerViewfinderRecompileRoute } = await import(
      "./routes/phase3/viewfinder-recompile"
    )
    registerViewfinderRecompileRoute(app, singleRoomRecompiler)
  }
  // F027 P4 hotfix · GET /api/wiki/events?path=X&limit=N — Prompt Inspector「追溯 wiki 事件」按钮
  {
    const { registerWikiEventsRoute } = await import("./routes/phase3/wiki-events")
    registerWikiEventsRoute(app, drizzleDb)
  }

  // F027 final-vision P1-2 · DocsIngestRunner (docs/* 增量变化 → preview→commit → wiki/_auto/)
  // commit 服务要求 wikiServices 注入；缺时跳过 runner，docs-watcher 仍 noop fallback。
  const { DocsIngestRunner: DocsIngestRunnerCls } = await import(
    "./services/scheduler/docs-ingest-runner"
  )
  const docsIngestRunner = sharedIngestCommit
    ? new DocsIngestRunnerCls({
        preview: sharedIngestPreview,
        commit: sharedIngestCommit,
        logger: app.log,
      })
    : undefined

  // F027 wiring · wiki 搜索索引 producer——reindex wiki_entity_index（search_wiki /
  // adaptive-recall Level 2 的唯一 producer）。
  //   wikiRoot 传 `<WIKI_ROOT||.runtime/wiki>`（= roomCompileWikiServicesRoot）——reindex 内部
  //   自己 join("wiki")，磁盘实测文件在 `.runtime/wiki/wiki/<bucket>`，故不能传多套一层的
  //   roomCompileWikiRoot（会变三层 wiki 扫不到文件）。
  const reindexWiki = async () => {
    const report = await reindexWikiEntities({
      wikiRoot: roomCompileWikiServicesRoot,
      db: drizzleDb,
    })
    app.log.info({ component: "wiki-reindex", ...report }, "F027 wiki entity reindex")
  }
  // 启动一次性全量 reindex：debounce 只在新写时增量；存量 wiki 文件需 boot 入索引，否则
  // search_wiki / Level 2 搜空表。scheduler 跳过时（CI/单测 MULTI_AGENT_SKIP_SCHEDULER=1）一并跳过。
  if (process.env.MULTI_AGENT_SKIP_SCHEDULER !== "1") {
    try {
      await reindexWiki()
    } catch (err) {
      app.log.warn({ err }, "F027 initial wiki reindex failed (non-fatal)")
    }
  }

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
    roomCompileExecutor,
    docsIngestRunner,
    // F027 v3 G2 · cron scanner 接真业务（NightlyHealthCheck / WeeklyDraftDigest /
    // MonthlySnapshot / ArchiveYearlySessions 扫此根；DriftDetector 走 DB 不依赖）。
    //
    // G2 r2 修：复用 line 829 `roomCompileWikiRoot` = `<wikiServicesRoot>/wiki/`
    // （多加一层 wiki 对齐真实文件结构 — 实际 viewfinder.md 在 .runtime/wiki/wiki/rooms/<id>/）。
    // 之前误传 `<wikiServicesRoot>` 让 scanner 全扫不到真文件（codex G2 review FAIL P1）。
    //
    // 约定：wikiRoot 是 markdown 文件实际根（`<X>/rooms/<id>/viewfinder.md` 中的 `<X>`），
    // 不是 namespace 外层。scanner ts docstring 强调；caller 见 server.ts:829 `roomCompileWikiRoot`。
    wikiRoot: roomCompileWikiRoot,
    // F027 B2/B1-c · 全局索引（compileWiki）根 = GET /api/wiki/index reader 根 = wikiServices.wikiRoot
    // = roomCompileWikiServicesRoot（单层 `.runtime/wiki`），**不是** roomCompileWikiRoot（双层）。
    // 写到 reader 读不到的根 = KB tab 恒空（compileWiki 同类 wiring 陷阱，自查抓到）。
    // worktree-preview 模式 reader 读 destWikiRoot fixtures；compileWiki 写单根不碰 fixtures（demo 不破）。
    wikiIndexRoot: roomCompileWikiServicesRoot,
    // F027 AC-P1-5 codex P2-3：把 recent_drops repo 注进 scheduler boot，
    // 让 NightlyVacuum 每夜真 prune 超窗关联语料（不接 → prune 收 undefined 返回 0，retention 形同虚设）。
    recentDrops: recentDropsRepo,
    // F027 wiring · search index producer —— debounce.recompileDerivedViews 接 reindex +
    // 把 onWikiEvent 交还给 createWikiServices.onCommit forwarder（fireWikiCommit）。
    reindexWiki,
    registerOnWikiCommit: (fire) => {
      fireWikiCommit = fire
    },
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

  // Week 5 hotfix · 第一次 RoomCompiler tick 立即触发 (而不是等 5min cron),
  // 让 worktree-preview / dev 启起来后 viewfinder 立即有数据.
  // 失败 fail-soft (warn 不阻塞 boot).
  ;(async () => {
    try {
      const result = await roomCompileExecutor()
      app.log.info(
        { roomsProcessed: result.roomsProcessed },
        "[room-compile-executor] boot-time compile tick complete",
      )
    } catch (err) {
      app.log.warn(
        { err: (err as Error).message },
        "[room-compile-executor] boot-time tick failed (ignored, cron will retry)",
      )
    }
  })()

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
