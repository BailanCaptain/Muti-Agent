import type { DatabaseSync } from "node:sqlite"
import type {
  ConnectorSource,
  Provider,
  RealtimeClientEvent,
  RealtimeServerEvent,
  WakeTriggerScenario,
} from "@multi-agent/shared"
import { PROVIDER_ALIASES, getContextWindowForModel } from "@multi-agent/shared"
import type { AppEventBus } from "../events/event-bus"
import { createLogger } from "../lib/logger"
import { perfCollector } from "../lib/perf-collector"
import { A2AChainRegistry, hasEarlierAliveEntry } from "../orchestrator/a2a-chain"
import { DEFAULT_A2A_CALL_DEADLINE_MS } from "../orchestrator/a2a-gateway"
import {
  type AdaptiveRecallCoordinator,
  type RecallCoordinatorResult,
  type RecallScenario,
  createNoopAdaptiveRecallCoordinator,
  deriveTriggerFromScenario,
} from "../orchestrator/adaptive-recall-coordinator"
import {
  type DecisionItemParsed,
  extractDecisionItems,
  extractWithdrawals,
} from "../orchestrator/aggregate-result"
import type { ApprovalManager } from "../orchestrator/approval-manager"
import {
  MAX_AUTO_RESUMES,
  buildAutoResumeMessage,
  shouldAutoResume,
} from "../orchestrator/auto-resume"
import {
  DEFAULT_BURST_CONFIG,
  buildTombstone,
  detectRecentBurst,
  formatBurstSection,
  formatTombstone,
} from "../orchestrator/burst-context"
import type { ChainStarterResolver } from "../orchestrator/chain-starter-resolver"
import {
  type AssemblePromptResult,
  type PromptPart,
  assembleDirectTurnPrompt,
  assemblePrompt,
} from "../orchestrator/context-assembler"
import { POLICY_FULL, POLICY_GUARDIAN } from "../orchestrator/context-policy"
import type { ContextMessage } from "../orchestrator/context-snapshot"
import { buildContextSnapshot, extractTaskSnippet } from "../orchestrator/context-snapshot"
import type { DecisionBoard, DecisionBoardEntry } from "../orchestrator/decision-board"
import type { DecisionManager } from "../orchestrator/decision-manager"
import type { DirectTurnRecallMode } from "../orchestrator/direct-turn-recall-mode"
import type {
  DispatchOrchestrator,
  EnqueueMentionsResult,
  QueueEntry,
} from "../orchestrator/dispatch"
import { resolveEffectiveTurnResult, sealedThisTurn, settleTurnUsage } from "./turn-usage-settlement"
import { createUsageSnapshotThrottle } from "./usage-snapshot-throttle"
import { planForcedDispatch } from "../orchestrator/forced-dispatch"
import type { InvocationRegistry } from "../orchestrator/invocation-registry"
import { deriveAuditPatch, loadTaskMemoryPack } from "../wiki/memory-preflight/memory-preflight"
import { toAssemblePromptHits } from "../wiki/memory-preflight/render-pack"
import type { WikiSearchProvider } from "../wiki/memory-preflight/types"
import { judgeAdoption } from "../wiki/prompt-audit/adoption-heuristic"
import type { ShadowWindowNotifierLike } from "../wiki/prompt-audit/shadow-window-notifier"
import {
  type ColdStartPreflightAudit,
  NoopPromptAuditWriter,
  type PromptAuditWriterLike,
  buildColdStartRecallAuditPatch,
  buildRecallAuditPatch,
} from "../wiki/prompt-audit/prompt-audit-writer"

import {
  buildForwardExtractSnippet,
  buildReturnPathExtractSnippet,
} from "../orchestrator/return-path-payload"
import type { SettlementDetector } from "../orchestrator/settlement-detector"
import { extractSOPBookmark } from "../orchestrator/sop-bookmark"
import type { SOPBookmark } from "../orchestrator/sop-bookmark"
import { buildWorklistContinuationPrompt } from "../orchestrator/worklist-continuation"
import type { BaseCliRuntime } from "../runtime/base-runtime"
import { runTurn } from "../runtime/cli-orchestrator"
import { StreamAccumulator } from "./stream-accumulator"
import { resolveContextWindow } from "../runtime/context-window-resolver"
import { runContinuationLoop } from "../runtime/continuation-loop"
import { classifyFailure } from "../runtime/failure-classifier"
import { loadRuntimeConfig, resolveEffectiveOverride } from "../runtime/runtime-config"
import type { AgentOverride, AgentOverridesConfig } from "../runtime/runtime-config"
import { resolveSealThresholds } from "../runtime/seal-config-resolver"
import type { SkillRegistry } from "../skills/registry"
import { applySlashCommandHint } from "../skills/slash-route"
import type { SopTracker } from "../skills/sop-tracker"
import type { A2ALifecycleService } from "./a2a-lifecycle"
import { composeFinalContentOnError } from "./compose-final-content-on-error"
import { deriveContentBlocks, mergeDerivedWithExistingBlocks } from "./content-blocks-derive"
import {
  buildCorrectionPrompt,
  decideRetryAction,
  resolveMaxDispatchRetries,
} from "./dispatch-retry-coordinator"
import {
  buildDispatchRetryAgentEventRow,
  buildDispatchRetryEventId,
  buildDispatchRetryRealtimeEvent,
} from "./dispatch-retry-event"
import type { MemoryService } from "./memory-service"
import { computeEffectiveSessionId } from "./session-effectiveness"
import type { SessionService } from "./session-service"
import type { WorkflowSopService as WorkflowSopServiceType } from "./workflow-sop-service"
import type { WorklistExecutor } from "./worklist-executor"

type ActiveRun = ReturnType<typeof runTurn>
type EmitEvent = (event: RealtimeServerEvent) => void

/**
 * F027 Phase 3 P20 G1 (AC-P3-5 物理依赖) · wake-up scenario 推断
 *
 * 从 runThreadTurn options 推断 scenario：
 *   - A2A 派发：systemPrompt 已预编（assemblePrompt for A2A）+ dispatchedCallId 绑定
 *     → "a2a_handoff"
 *   - direct turn 自建 child call：无 systemPrompt + dispatchedCallId 绑定
 *     → "direct_turn"
 *   - 续推 / 子调用：parentInvocationId 标识
 *     → "wake_up"
 *   - fallback → "wake_up"
 *
 * 注：session_bootstrap 当前不走 runThreadTurn 入口，不需在此处理。
 */
export function deriveWakeTriggerScenario(options: {
  systemPrompt?: string
  dispatchedCallId?: string | null
  parentInvocationId?: string | null
}): WakeTriggerScenario {
  if (options.systemPrompt && options.dispatchedCallId) return "a2a_handoff"
  if (!options.systemPrompt && options.dispatchedCallId) return "direct_turn"
  if (options.parentInvocationId) return "wake_up"
  return "wake_up"
}

/**
 * F027 B1-b · direct/wake-up 装配支的 Adaptive Recall 接线。
 *
 * wiring gap（2026-06-05 审计）：自动召回 `executeIfNeeded` 此前仅 A2A 派发支有调用点，
 * direct/wake-up 支（assembleDirectTurnPrompt）从不跑 coordinator → wake_up 场景 Recall Pack
 * 永不注入。本 helper 给 direct 支补对称接线。
 *
 * 设计（spec V16.5 line 1094「每次 wake-up / handoff / session_bootstrap 自动召回」+
 * coordinator.ts:96「direct_turn 默认不触发」）：无条件调 coordinator，scenario 网关交给
 * coordinator.triggerScenarios —— wake_up → 真召回；direct_turn（普通用户问答）→ scenario_skip
 * 不召回。**caller 必须传准 scenario**：普通用户消息传 "direct_turn"（不能用
 * deriveWakeTriggerScenario 的 wake_up fallback，否则每条消息都召回炸成本），仅
 * auto-resume 等显式 wake 传 "wake_up"。guardian 模式短路（零上下文契约不注 recall）。
 *
 * 返回 { recallResult, memoryPreflight }：
 *   - memoryPreflight 喂 assembleDirectTurnPrompt（命中 → [Recall Pack] 注入）
 *   - recallResult 给 writePromptAuditSafe 写 recall 字段（Prompt Inspector 可见）；guardian 短路 → null
 */
export async function resolveDirectTurnRecall(
  coordinator: AdaptiveRecallCoordinator,
  input: {
    roomId: string
    alias: string
    scenario: RecallScenario
    query: string
    guardianMode?: boolean
    /** F042 AC6 · 当前 turn 的用户消息 id（L3 排除，防召回自引用——活体实测） */
    excludeMessageIds?: string[]
  },
): Promise<{
  recallResult: RecallCoordinatorResult | null
  memoryPreflight: { hits: Array<{ score: number; summary: string; path?: string }> } | null
}> {
  if (input.guardianMode) {
    return { recallResult: null, memoryPreflight: null }
  }
  const recallResult = await coordinator.executeIfNeeded({
    roomId: input.roomId,
    alias: input.alias,
    scenario: input.scenario,
    trigger: deriveTriggerFromScenario(input.scenario),
    query: input.query,
    excludeMessageIds: input.excludeMessageIds,
  })
  // F042 AC6（德彪 1.3）· 注入 gate：executor 真跑时必须 recallSatisfied（evidence gate
  // 放行）才组装 Recall Pack——只看 hits.length 会把 gate 拒掉的噪声照样注入。
  // passthrough（未 executed，hits=taskMemoryPack 透传）保持原语义。
  const injectable = recallResult.executed
    ? recallResult.output?.recallSatisfied === true && recallResult.hits.length > 0
    : recallResult.hits.length > 0
  const memoryPreflight = injectable
    ? { hits: recallResult.hits.map(toAssemblePromptHits) }
    : null
  return { recallResult, memoryPreflight }
}

/**
 * F042 AC1 · 影子拦截：shadow 模式下 direct_turn 的召回结果只进审计不进 prompt。
 * 拆「执行」与「注入」的唯一开关点——wake_up 与 inject/off 模式恒等透传
 * （off 时 coordinator 白名单未扩 direct_turn，上游已 scenario_skip，这里透传的是 null）。
 */
export function applyShadowSuppression<T>(
  mode: DirectTurnRecallMode,
  scenario: "wake_up" | "direct_turn",
  memoryPreflight: T | null,
): T | null {
  if (mode === "shadow" && scenario === "direct_turn") return null
  return memoryPreflight
}

/**
 * F027 B1-b-2 · 冷启（session_bootstrap）自动召回接线。
 *
 * wiring gap（2026-06-05 审计）：北极星「新 agent 进新 room 不白板」靠 P11 loadTaskMemoryPack
 * 覆盖冷启（spec V16.5 line 1094/95），但 loadTaskMemoryPack **0 生产 caller** → 冷启 Recall Pack
 * 从没注入。本 helper 给冷启（direct 支 nativeSession===null）补接线。
 *
 * 设计：冷启用**轻量 Pack**（loadTaskMemoryPack 单层召回 + Quality Gate），**不**走 coordinator
 * （coordinator triggerScenarios 故意排除 session_bootstrap，spec line 95 "已由 Pack 覆盖"）。
 * 命中（高置信 ≥ floor）→ output.prompt.hits → memoryPreflight → assembleDirectTurnPrompt 注入
 * [Recall Pack]。search provider 未注入（null）→ 不召回；backend 抛错 → fail-soft 返 null 不阻塞 turn。
 */
export async function resolveColdStartRecall(
  search: WikiSearchProvider | null,
  ctx: { roomId: string; alias: string; taskSummary: string },
  logger?: { warn(obj: unknown, msg?: string): void },
): Promise<{
  /** ≥floor 注入桶命中（喂 assembleDirectTurnPrompt → [Recall Pack]）；无命中 = null。 */
  memoryPreflight: { hits: Array<{ score: number; summary: string; path?: string }> } | null
  /**
   * receive 德彪 r1 P2-2：完整 preflight audit（deriveAuditPatch 产物）——
   * inspector-only topScore + 真 budgetExceeded + V15.1 字段，丢了 = 审计失真。
   * fail-soft crash 时 null（attempted 但无数据）。
   */
  audit: ColdStartPreflightAudit | null
} | null> {
  if (!search) return null
  try {
    const out = await loadTaskMemoryPack(
      {
        roomId: ctx.roomId,
        alias: ctx.alias,
        scenario: "session_bootstrap",
        taskSummary: ctx.taskSummary,
      },
      { search, logger },
    )
    return {
      memoryPreflight: out.prompt.hits.length > 0 ? { hits: out.prompt.hits } : null,
      audit: deriveAuditPatch(out),
    }
  } catch (err) {
    logger?.warn(
      { stage: "cold_start_recall", err: err instanceof Error ? err.message : String(err) },
      "cold-start memory_preflight failed (fail-soft, no Recall Pack)",
    )
    return { memoryPreflight: null, audit: null }
  }
}

/**
 * F026-P3 Task7 · cold-target burst 兜底判定 + 组装。
 *
 * cold-target = 下游 agent 没有 nativeSessionId（无 CLI resume）AND SessionBootstrap
 * 内 threadMemory == null AND previousDigest == null（真冷启）。
 * 触发与"上游来源"无关 — user @ 与 agent @ 都同等覆盖。
 *
 * 命中时，用 roomSnapshot 作为 burst 池（detectRecentBurst 切最近紧密对话），
 * omitted → tombstone 占位。返回 undefined = 不命中（caller 不传 coldTargetBurst）。
 */
export function tryBuildColdTargetBurst(args: {
  nativeSessionId: string | null
  threadMemoryEmpty: boolean
  previousDigestEmpty: boolean
  roomSnapshot: readonly ContextMessage[]
}): { burstSection: string; tombstoneSection: string | null } | undefined {
  const isColdTarget =
    args.nativeSessionId === null && args.threadMemoryEmpty && args.previousDigestEmpty
  if (!isColdTarget) return undefined
  if (args.roomSnapshot.length === 0) return undefined

  const { burst, omitted } = detectRecentBurst(args.roomSnapshot, DEFAULT_BURST_CONFIG)
  if (burst.length === 0) return undefined

  const burstSection = formatBurstSection(burst)
  const tombstone = buildTombstone(omitted, "thread", DEFAULT_BURST_CONFIG)
  const tombstoneSection = tombstone
    ? formatTombstone(tombstone, {
        headMsgId: omitted[0]?.id,
        tailMsgId: omitted[omitted.length - 1]?.id,
      })
    : null

  return { burstSection, tombstoneSection }
}

const STDERR_NOISE_PATTERNS = [
  /^YOLO mode is enabled/i,
  /^All tool calls will be automatically approved/i,
  /^Loaded cached credentials/i,
  /^Using model:/i,
  /^Tip:/i,
  /^\[runtime\]/,
  /^Reading (prompt|additional input) from stdin/i,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s/,
  /^codex_core/,
  /^failed to stat skills entry/i,
  /^Compiling\s/i,
  /^Finished\s.*release/i,
  /^warning\[E\d+\]/,
  /^Downloading\s/i,
  // F012 AC-20 Gemini: strip the GaxiosError / refreshAuth TLS dump block so it
  // never pollutes the `thinking` field. isStderrNoiseLine() trims leading
  // whitespace before matching, so patterns here assume trimmed input. Covers
  // the top-level message, stack frames, the util.inspect() object dump
  // (nested keys, quoted keys, Symbols, [Function:] / [Object:] placeholders,
  // closing braces), and the FetchError inner object.
  /^Failed to fetch\s/i,
  /^_?GaxiosError:/,
  /^FetchError\d*:/,
  /^[a-zA-Z_][\w-]*:\s*[A-Z][\w]*\d*:\s/, // nested error: "error: FetchError2: request ..."
  /^at\s(async\s)?[\w$][\w$.<>]*\s*\(/, // stack frame: "at Foo.bar (..." or "at async ..."
  /^Symbol\(/,
  /^'[\w-]+':\s/,
  /^[a-zA-Z_][\w-]*:\s*(['"{[]|undefined|true|false|-?\d|[A-Z][\w]*\s*\{|\[(Object|Function|Array))/,
  /^[a-zA-Z_][\w-]*\s*\{\s*$/,
  /^\}[,)]?\s*$/,
  /^\]\s*$/,
]

function isStderrNoiseLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  return STDERR_NOISE_PATTERNS.some((p) => p.test(trimmed))
}

export function filterStderrNoise(chunk: string): string {
  return chunk
    .split("\n")
    .filter((line) => !isStderrNoiseLine(line))
    .join("\n")
}

function stripAnsi(value: string) {
  let result = ""

  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== "[") {
      result += value[index]
      continue
    }

    index += 1
    while (index + 1 < value.length && !/[A-Za-z]/.test(value[index + 1])) {
      index += 1
    }
    index += 1
  }

  return result
}

function extractPromptFromActivityChunk(chunk: string) {
  const lines = stripAnsi(chunk)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  if (!lines.length) {
    return null
  }

  const promptLikeLines = lines.filter((line) => {
    if (line.length < 6) {
      return false
    }

    if (
      /(please confirm|need your confirmation|awaiting your confirmation|do you want|would you like|should i|can you clarify|please provide|please choose|approval required|user input required)/i.test(
        line,
      )
    ) {
      return true
    }

    if (/(请确认|需要你确认|需要确认|等待你的确认|请提供|请补充|请选择|请问)/.test(line)) {
      return true
    }

    return /(?:\?|\uFF1F)$/.test(line)
  })

  if (!promptLikeLines.length) {
    return null
  }

  return promptLikeLines.join("\n").slice(0, 1200)
}

/**
 * F026 P5 in-flight (R-104) · LLM 主链路 + MCP/CLI hook 共用的 connector header 写入。
 *
 * 给每条 enqueueResult.queued entry 在 target thread 写一行 messageType=connector
 * message + emit message.created。前端 ConnectorBubble / AtPill / OriginCapsule
 * 三组件共依赖这条 connector message 作为载体。
 *
 * 抽出原因：原 :797-833 only-served handleAgentPublicMessage（MCP trigger_mention
 * + agent CLI onPublicMessage hook 入口），LLM 主链路 runThreadTurn final flush
 * enqueuePublicMentions 不经过它 → R-104 timeline 4/4 final 0 connector → 三组件
 * 无载体。两条派发入口共用此 helper 杜绝写入逻辑不对称。
 */
export function writeConnectorHeadersForQueue(
  sessions: SessionService,
  enqueueResult: EnqueueMentionsResult,
  emit: (event: RealtimeServerEvent) => void,
): void {
  for (const entry of enqueueResult.queued) {
    const targetThread = sessions.findThreadByGroupAndProvider(
      entry.sessionGroupId,
      entry.to.provider,
    )
    if (!targetThread) continue

    const a2aConnectorSource: ConnectorSource = {
      kind: "multi_mention_result",
      label: "A2A 协助",
      fromAlias: entry.from.agentId,
      toAlias: entry.to.agentId,
      targets: [entry.to.provider],
    }
    const a2aConnector = sessions.appendConnectorMessage(
      targetThread.id,
      "",
      a2aConnectorSource,
      entry.id,
      "header",
      // F026 P5 T0 · 派发处把 a2a callId 写回 message,让 listMessages 可以
      // LEFT JOIN a2a_calls 出 onBehalfOf / parentCallId / status / displayMode 等协议字段。
      entry.callId ?? null,
    )
    const a2aTimeline = sessions.toTimelineMessage(targetThread.id, a2aConnector.id)
    if (a2aTimeline) {
      emit({
        type: "message.created",
        payload: {
          threadId: targetThread.id,
          sessionGroupId: entry.sessionGroupId,
          message: a2aTimeline,
        },
      })
    }
  }
}

export class MessageService {
  private readonly log = createLogger("message-service")
  private readonly flushingGroups = new Set<string>()
  private approvals: ApprovalManager | null = null
  private decisions: DecisionManager | null = null
  private skillRegistry: SkillRegistry | null = null
  private sopTracker: SopTracker | null = null
  private workflowSopService: WorkflowSopServiceType | null = null
  private readonly prevUsedTokens = new Map<string, number>()
  private memoryService: MemoryService | null = null
  private transcriptWriter: import("./transcript-writer").TranscriptWriter | null = null
  private embeddingService: import("./embedding-service").EmbeddingService | null = null
  private decisionBoard: DecisionBoard | null = null
  private settlementDetector: SettlementDetector | null = null
  private chainStarterResolver: ChainStarterResolver | null = null
  private broadcast: EmitEvent | null = null
  // F026 P1 Wiring · settle/advance hook. When unset, every call is a noop —
  // unit tests that don't wire call-registry stay green without scaffolding.
  private a2aLifecycle: A2ALifecycleService | null = null
  // F026 P2 v2 · 树形 worklist 续推执行器。setWorklistExecutor() 缺省时所有 mention
  // enqueue 后续推注册全 noop —— 老路径 / 单测不 wire 时无副作用。
  private worklistExecutor: WorklistExecutor | null = null
  // F027 Phase 3 P20 Day 7-8 a · Adaptive Recall coordinator wiring.
  // 默认 noop（enabled=false） — 仅 wiring 到位，不真触发 LLM；Phase 4 接 backend
  // 后 setAdaptiveRecallCoordinator() 注入真 Coordinator 启用。
  private adaptiveRecallCoordinator: AdaptiveRecallCoordinator =
    createNoopAdaptiveRecallCoordinator()
  // F042 AC1 · direct_turn 召回三态（默认 shadow：链真跑+写审计，不注入）。server.ts boot 注入 env 解析值。
  private directTurnRecallMode: DirectTurnRecallMode = "shadow"
  // F042 AC2 · 影子观察窗提示器（null = 未注入不提示）。
  private shadowWindowNotifier: ShadowWindowNotifierLike | null = null
  // F027 B1-b-2 · 冷启 loadTaskMemoryPack 搜索 backend（北极星「新 agent 进新 room 不白板」）。
  // 默认 null —— 未注入时冷启不召回（单测 / 老路径无副作用）；server.ts boot 注入生产
  // SearchWikiProvider（search_wiki MCP 同款 BM25 backend，已对齐 WikiSearchProvider 接口）。
  private memoryPreflightSearch: WikiSearchProvider | null = null
  // F027 #286 FU-1 · runTurn runtime adapter 测试缝（默认 null = 生产按 provider 选单例）。
  private cliRuntimeOverride: BaseCliRuntime | null = null
  // F043 AC8 · 轮中 usage 快照节流（per-thread leading-edge 2s）
  private readonly usageSnapshotThrottle = createUsageSnapshotThrottle()
  // F027 Phase 3 P20 Day 8 b · prompt_audit writer wiring (AC-P3-9 b).
  // 默认 noop —— wire 没接通时不写 audit row（单测 / 老路径无副作用）。
  // server.ts boot 注入真 PromptAuditWriter（即使 Coordinator 是 noop，每次
  // A2A 拼装也写一行 audit：9 recall fields 用 disabled 默认值，方便 prompt-inspector
  // UI Day 4 起就能读到有 scenario / parts_json 的 row）。
  private promptAuditWriter: PromptAuditWriterLike = new NoopPromptAuditWriter()
  // F027 P4 hotfix · viewfinder loader DI（V16.5 §11 + §4 line 396）。
  // direct turn / A2A caller 用它读 wiki/rooms/<roomId>/viewfinder.md body 传给
  // assemblePrompt.viewfinder。未注入时不传 viewfinder（行为同 Phase 1-3 现状）。
  // server.ts 把 ViewfinderService.getViewfinder 包一层注进来 — 避免 service 层引 routes 层。
  private viewfinderLoader:
    | ((roomId: string) => Promise<{ body: string } | null>)
    | null = null
  // F027 P4-A1 · capability registry DI（V16.5 §13 line 1447-1525）。
  // assemblePrompt.capabilityDigest 真相源；server.ts boot 加载 wiki/agents/agent-capabilities.yaml
  // 注入。未注入时 caller 不传 capabilityDigest（degrade 到 Phase 1-3 行为）。
  private capabilityRegistry:
    | { agents: Map<string, { capability_digest_for_self: string }> }
    | null = null
  // F027 P4-A2 · handbook H2 切片 DI（V16.5 §27.4 + §4 line 365）。
  // assemblePrompt.handbookSlices 真相源（agentActions 切片），server.ts boot 加载
  // wiki/rules/agent-wiki-handbook.md 切片注入。assembler 内仅 scenario === 'wake_up'
  // 时才把 agentActions 注入 content（A2A 不注；direct turn 默认 wake_up 会注）。
  // 未注入时 caller 不传 handbookSlices（degrade 同 Phase 1-3 行为）。
  private handbookSlicesCache: { agentActions: string } | null = null
  private readonly chainRegistry = new A2AChainRegistry()
  private readonly pendingBoardFlushes = new Map<string, DecisionBoardEntry[]>()
  private readonly streamingFlushers = new Map<
    string,
    { sessionGroupId: string; flush: () => void }
  >()

  constructor(
    private readonly sessions: SessionService,
    private readonly dispatch: DispatchOrchestrator,
    private readonly invocations: InvocationRegistry<ActiveRun>,
    private readonly events: AppEventBus,
    private readonly apiBaseUrl: string,
  ) {}

  setApprovalManager(manager: ApprovalManager) {
    this.approvals = manager
  }

  setDecisionManager(manager: DecisionManager) {
    this.decisions = manager
  }

  setSkillRegistry(registry: SkillRegistry) {
    this.skillRegistry = registry
  }

  setSopTracker(tracker: SopTracker) {
    this.sopTracker = tracker
  }

  /**
   * F019 P3: Wire in WorkflowSopService so message-service can look up
   * thread.backlogItemId → sopStageHint and pass it to runTurn.
   * When not set, flows behave identically to pre-F019 (no hint injection).
   */
  setWorkflowSopService(svc: WorkflowSopServiceType) {
    this.workflowSopService = svc
  }

  setMemoryService(service: MemoryService) {
    this.memoryService = service
  }

  // F018 P4: TranscriptWriter DI. Seal hook flushes digest + updates ThreadMemory
  // so the next session's SessionBootstrap gets Previous Session Summary + rolling memory.
  setTranscriptWriter(writer: import("./transcript-writer").TranscriptWriter) {
    this.transcriptWriter = writer
  }

  // F018 P5 AC6.2: EmbeddingService DI. Post-message fire-and-forget
  // embedding.generateAndStore so recall_similar_context can find historic
  // messages by semantic similarity.
  setEmbeddingService(service: import("./embedding-service").EmbeddingService) {
    this.embeddingService = service
  }

  setDecisionBoard(board: DecisionBoard) {
    this.decisionBoard = board
  }

  setSettlementDetector(detector: SettlementDetector) {
    this.settlementDetector = detector
  }

  setChainStarterResolver(resolver: ChainStarterResolver) {
    this.chainStarterResolver = resolver
  }

  /**
   * F026 P1 Wiring · install the A2A lifecycle hook (call-registry advance/settle).
   * Without this, message-service runs identically to pre-P1 — registry remains
   * an island as before. server.ts wires this once at startup; tests opt in.
   */
  setA2ALifecycle(svc: A2ALifecycleService) {
    this.a2aLifecycle = svc
  }

  /**
   * F026 P2 v2 · 注入树形 worklist executor + 配 root settle 时的续推派发回调。
   *
   * - registerForDispatch: enqueue mention 后调，把派发的 children 写到 a2a_worklists 树
   * - onChildFinished: invocation.finished 后调，cascade settle 上推
   * - onDoneContinuation: root worklist settle 时由 executor 触发，本服务接管派续推
   */
  setWorklistExecutor(svc: WorklistExecutor) {
    this.worklistExecutor = svc
    svc.setOnDoneContinuation((args) => {
      const ctx = args.continuationContext as { emit: EmitEvent; rootMessageId: string } | undefined
      if (!ctx) return
      this.dispatchWorklistContinuation({
        parentCallId: args.parentCallId,
        childAliases: args.childAliases,
        emit: ctx.emit,
        rootMessageId: ctx.rootMessageId,
      })
    })
  }

  /**
   * F027 Phase 3 P20 Day 7-8 a · 注入真 Adaptive Recall Coordinator（替换 noop 默认）。
   *
   * Day 7-8 a 范围 = wiring only：boot 时 server.ts 注入 enabled=false 的实例。
   * Phase 4 接 critique LLM + level2-4 backend + Level5Sink 真实后切 enabled=true。
   */
  setAdaptiveRecallCoordinator(coordinator: AdaptiveRecallCoordinator) {
    this.adaptiveRecallCoordinator = coordinator
  }

  /** F027 B1-b-2 · 注入冷启召回的 wiki 搜索 backend（server.ts boot 调）。 */
  setMemoryPreflightSearch(search: WikiSearchProvider) {
    this.memoryPreflightSearch = search
  }

  /** F042 AC1 · 注入 direct_turn 召回三态（server.ts boot 从 MULTI_AGENT_DIRECT_TURN_RECALL 解析）。 */
  setDirectTurnRecallMode(mode: DirectTurnRecallMode) {
    this.directTurnRecallMode = mode
  }

  /** F042 AC2 · 注入影子观察窗提示器（server.ts boot 调；未注入 = 不提示，测试/老路径无副作用）。 */
  setShadowWindowNotifier(notifier: ShadowWindowNotifierLike) {
    this.shadowWindowNotifier = notifier
  }

  /**
   * F027 #286 FU-1 · 测试缝：覆盖 runTurn 的 runtime adapter（cli-orchestrator.ts:72
   * 既有 test hook 的上游转发）。接线级测试用 fake runtime 捕获 AgentRunInput.prompt
   * 断言 [Recall Pack] 注入，不 spawn 真 CLI。生产不调 → runTurn 按 provider 选单例。
   */
  setCliRuntimeOverride(runtime: BaseCliRuntime) {
    this.cliRuntimeOverride = runtime
  }

  /**
   * F027 Phase 3 P20 Day 8 b · 注入 PromptAuditWriter（替换 noop 默认）。
   *
   * server.ts boot 注入真 PromptAuditWriter(db)：每次 A2A 拼装写一行 prompt_audit
   * （含 9 V15.2 Adaptive Recall 字段 + base fields），prompt-inspector Day 4 endpoint
   * 已可读。Coordinator 是 noop 时 9 recall fields 走 disabled 默认值。
   */
  setPromptAuditWriter(writer: PromptAuditWriterLike) {
    this.promptAuditWriter = writer
  }

  /**
   * F027 P4 hotfix · viewfinder loader DI。server.ts boot 注入：
   *   messages.setViewfinderLoader(async (roomId) => {
   *     const r = await vfSvc.getViewfinder(roomId).catch(() => null)
   *     return r?.viewfinder ? { body: r.viewfinder } : null
   *   })
   * 未注入时 direct turn / A2A caller 不传 viewfinder（行为同 Phase 1-3 现状）。
   */
  setViewfinderLoader(loader: (roomId: string) => Promise<{ body: string } | null>) {
    this.viewfinderLoader = loader
  }

  /**
   * F027 P4 hotfix · 安全加载 viewfinder。room 没绑定 / loader 没注入 / 文件读不到都返 null
   * 不抛错，让 caller fail-soft 继续 assemble（degrade 到 viewfinder=null 的旧行为）。
   */
  private async loadViewfinderSafe(roomId: string | null): Promise<{ body: string } | null> {
    if (!roomId || !this.viewfinderLoader) return null
    try {
      return await this.viewfinderLoader(roomId)
    } catch (err) {
      this.log.warn(
        { roomId, err: (err as Error).message },
        "viewfinder loader threw (non-blocking)",
      )
      return null
    }
  }

  /**
   * F027 P4-A1 · capability registry DI（V16.5 §13 line 1449-1476）。
   * server.ts boot 时 loadCapabilityRegistryFromRoot(repoRoot) → setCapabilityRegistry。
   * 未注入时 caller 不传 capabilityDigest（degrade 到 Phase 1-3 行为）。
   */
  setCapabilityRegistry(
    registry: { agents: Map<string, { capability_digest_for_self: string }> } | null,
  ) {
    this.capabilityRegistry = registry
  }

  /**
   * F027 P4-A1 · 取 receiver alias 的 capability_digest_for_self。
   * Registry 未注入 / alias 不在 registry → 返 null（caller 不注入 capabilityDigest 段）。
   * V16.5 §13 line 1490 — guardian 模式由 caller 决策跳过（零上下文契约）。
   */
  private getSelfCapabilityDigest(alias: string | null | undefined): string | null {
    if (!alias || !this.capabilityRegistry) return null
    const cap = this.capabilityRegistry.agents.get(alias)
    return cap?.capability_digest_for_self ?? null
  }

  /**
   * F027 P4-A2 · handbook H2 切片 DI setter（V16.5 §27.4 + §4 line 365）。
   * server.ts boot 调 loadHandbookSlices(wikiRoot) 后注入；进程级常量缓存。
   * 设 null 即 unregister（caller 不再传 handbookSlices）。
   */
  setHandbookSlices(slices: { agentActions: string } | null) {
    this.handbookSlicesCache = slices
  }

  /**
   * F027 P4-A2 · 取 handbook agentActions 切片供 direct turn caller 注入。
   * Caller 透传给 assemblePrompt.handbookSlices；assembler 内仅 scenario==='wake_up'
   * 且 agentActions 非空才注 [Handbook — Agent Actions] 区段（V16.5 §4 line 365）。
   */
  private getHandbookSlices(): { agentActions: string } | null {
    return this.handbookSlicesCache
  }

  /**
   * F027 P4-A2 + fallback j2 P1 修 · "仅 first wake-up" 判定 (V16.5 §4 line 364-365 + §27.4 + line 3166)。
   *
   * V16.5 line 364-365 严契约：「`[Handbook — Agent Actions]` — 仅 first wake-up，
   * capability_digest 已覆盖最小动作集时 skip」。
   *
   * 判定规则（零新状态）：`thread.nativeSessionId === null` = 此 thread 还没起过 CLI session，
   * 跟 F018 SessionBootstrap 的 first-wake-up 判定保持一致 — 一旦 CLI 起过（onSession callback
   * 写 nativeSessionId 非 null），后续 turn 都不再算 first wake-up。
   *
   * 修前：每个 direct turn 都注 handbook ~2-3KB → 长 session 反复污染 reference-only 区段 + token regression。
   */
  private maybeGetHandbookSlicesForFirstWakeUp(thread: {
    nativeSessionId: string | null
  }): { agentActions: string } | null {
    if (thread.nativeSessionId !== null) return null
    return this.getHandbookSlices()
  }

  /**
   * F027 P4-A3 · A2A handoffContext 构造 helper（V16.5 §4 line 422-431）。
   *
   * Assembler 拿到后渲染 [Collaboration Contract — Reference Only] 区段
   * （receiver_alias + task_summary 简化 2 字段，V16.5 §4 line 429-431）。
   *
   * guardian 模式跳过（零上下文契约不许注 collaboration contract）。
   * receiverAlias / taskSummary 任一空 → 返 null（caller 不传 handoffContext 段；
   * assembler 内 sanitize 空字符串也会 skip）。
   *
   * 完整 4 字段 envelope（rewriteHandoffForReceiver 输出）保护在 P9 fixture 跑
   * （capability-registry.test.ts leak-detector 端到端），这里仅取 2 简化字段
   * 喂 assembler — 跟 V16.5 §4 line 429-431 shape 一致。
   *
   * V16.5 §M1 line 422-431 明示 production 可简化 2 字段。完整 4 字段 envelope（含
   * receiver_must_do / expected_evidence / do_not_section）是 ADR-003 反向路由复杂场景才需要
   * — capability-registry.test.ts 8 处 caller spec-locked 测试覆盖，不是 dead code。
   * 待 ADR-003 反向路由 enable 时 dispatch.ts 接通 rewriter 即可（见 F027-RESIDUAL-DEBT.md D2）。
   */
  private buildA2AHandoffContext(args: {
    receiverAlias: string | null | undefined
    taskSummary: string | null | undefined
    isGuardianMode: boolean
  }): { receiverAlias: string; taskSummary: string } | null {
    if (args.isGuardianMode) return null
    if (!args.receiverAlias || !args.taskSummary) return null
    return {
      receiverAlias: args.receiverAlias,
      taskSummary: args.taskSummary,
    }
  }

  /**
   * F027 P4 hotfix · prompt_audit 写入 helper（V16.5 §18 line 2117 "每次拼装同步写一行"）。
   *
   * direct turn 和 A2A 都用这条路径；caller 传 scenario + assembled (含 .parts) + 元信息。
   *
   * `parts_json` 来自 assembled.parts（含 name + tokens + surface 三字段，前端按 surface 分组）；
   * `iron_laws_count` grep "Iron Laws" 在 systemPrompt+content 出现次数（B022 防回归断言）；
   * `total_tokens` 用 assembled.parts 总和（比 content.length/4 单独估算更准）。
   *
   * 全程 try/catch fail-soft：audit 失败不阻塞 agent 运行（Phase 3 A2A 路径同口径）。
   */
  private writePromptAuditSafe(args: {
    scenario: "direct_turn" | "a2a_handoff" | "a2a_handoff_guardian" | "wake_up"
    alias: string
    roomId: string | null
    assembled: AssemblePromptResult
    sourceEventIds: string[]
    agentSessionRef: string | null
    /** A2A 路径的 recall patch（direct turn 不跑 Coordinator，传 undefined 即可）。 */
    recallPatch?: ReturnType<typeof buildRecallAuditPatch>
    /** F042 AC2 · direct_turn 写入时三态；非 direct 场景不传（落 NULL）。 */
    recallMode?: DirectTurnRecallMode | null
  }): number | null {
    // F042 AC2 · 返回 row id 供采纳判定回写（updateAdoption）；失败/Noop（id=0）→ null。
    try {
      const totalTokens = args.assembled.parts.reduce((sum, p) => sum + p.tokens, 0)
      const ironLawsCount = this.countIronLaws(
        args.assembled.systemPrompt + "\n" + args.assembled.content,
      )
      const patch = args.recallPatch ?? buildRecallAuditPatch({ output: undefined })
      // F027 v3 G1 · V16.5 chap 20 line 2273 token 预算 — cap + notInjectedJson 真值写入
      // (Phase 3 / Phase 4 都是 cap=0 + notInjectedJson=null 占位; v3 接通 reducer 后真值)
      const result = this.promptAuditWriter.write({
        createdAt: new Date().toISOString(),
        alias: args.alias,
        roomId: args.roomId,
        scenario: args.scenario,
        totalTokens,
        cap: args.assembled.cap,
        partsJson: JSON.stringify(args.assembled.parts),
        notInjectedJson:
          args.assembled.notInjected.length > 0
            ? JSON.stringify(args.assembled.notInjected)
            : null,
        ironLawsCount,
        rawText: args.assembled.systemPrompt + "\n\n---\n\n" + args.assembled.content,
        sourceEventIds: JSON.stringify(args.sourceEventIds),
        agentSessionRef: args.agentSessionRef,
        recallMode: args.recallMode ?? null,
        ...patch,
      })
      return result.id > 0 ? result.id : null
    } catch (err) {
      this.log.warn(
        { stage: "prompt_audit.write", err: (err as Error).message, scenario: args.scenario },
        "prompt_audit write failed (non-blocking)",
      )
      return null
    }
  }

  /**
   * F027 P4 hotfix · 数 "Iron Laws" 在 prompt 全文出现次数。
   *
   * V16.5 §2 line 246 + §18 line 2053："runtime 端 grep Iron Laws = 1"（B022 防回归）。
   * runtime+harness 合并 ≤ 2 是 V16.5 接受边界（CLI harness CLAUDE.md 一份 + runtime 一份）。
   * Inspector 看到 1 = PASS / 0 = base prompt 漏注 / ≥3 = 4 源冗余回归。
   */
  private countIronLaws(text: string): number {
    const matches = text.match(/Iron Laws/g)
    return matches ? matches.length : 0
  }

  /**
   * F026 P2 v2 · root worklist settle 触发的 parent 续推派发。
   *
   * cb 来自 WorklistExecutor.onChildFinished cascade settle 路径。本方法负责：
   *   1. 反查 parent call → replyTo / sessionGroupId
   *   2. 找 parent thread by provider
   *   3. 建续推 child call 挂在 user-root 下（user 视角等 parent 整合）
   *   4. 合成续推 prompt（buildWorklistContinuationPrompt 1B.6 多 alias 版本）
   *   5. fire-and-forget runThreadTurn 续推
   *
   * Defensive：lookup / 派发任一步失败 → log.warn + 静默返回。
   */
  private dispatchWorklistContinuation(input: {
    parentCallId: string
    childAliases: string[]
    emit: EmitEvent
    rootMessageId: string
  }): void {
    const lifecycle = this.a2aLifecycle
    if (!lifecycle) return
    if (input.childAliases.length === 0) return

    const parentCallRow = lifecycle.getCall(input.parentCallId)
    if (!parentCallRow) {
      this.log.warn(
        { parentCallId: input.parentCallId },
        "F026 P2 v2 worklist continuation: parent call row missing — skip",
      )
      return
    }

    const replyTo = parentCallRow.replyTo
    const colonIdx = replyTo.indexOf(":")
    const providerStr = colonIdx >= 0 ? replyTo.slice(0, colonIdx) : replyTo
    const provider = providerStr as Provider

    const parentThread = this.sessions.findThreadByGroupAndProvider(
      parentCallRow.sessionGroupId,
      provider,
    )
    if (!parentThread) {
      this.log.warn(
        {
          parentCallId: input.parentCallId,
          provider,
          sessionGroupId: parentCallRow.sessionGroupId,
        },
        "F026 P2 v2 worklist continuation: parent thread not found — skip",
      )
      return
    }

    let continuationCallId: string | undefined
    try {
      continuationCallId = lifecycle.openCall({
        parentCallId: parentCallRow.rootCallId,
        issuerAlias: "user",
        sessionGroupId: parentCallRow.sessionGroupId,
        deadlineAt: new Date(Date.now() + DEFAULT_A2A_CALL_DEADLINE_MS).toISOString(),
        convenerAlias: "user",
        replyTo: replyTo,
      })
    } catch (err) {
      this.log.warn(
        { err, rootCallId: parentCallRow.rootCallId },
        "F026 P2 v2 worklist continuation: openCall failed — skip",
      )
      return
    }

    const prompt = buildWorklistContinuationPrompt({
      childAliases: input.childAliases,
    })

    input.emit({
      type: "status",
      payload: {
        sessionGroupId: parentCallRow.sessionGroupId,
        message: `A2A 续推 — ${input.childAliases.join("、")} → ${parentThread.alias}`,
      },
    })

    void this.runThreadTurn({
      threadId: parentThread.id,
      content: prompt,
      emit: input.emit,
      rootMessageId: input.rootMessageId,
      parentInvocationId: null,
      dispatchedCallId: continuationCallId,
      // r2 范-r1 P2: 续推走 A2A 链路而非 direct turn — wake.trigger scenario 显式标
      scenario: "a2a_handoff",
    }).catch((err) => {
      this.log.error({ err }, "F026 P2 v2 worklist continuation runThreadTurn rejected")
    })
  }

  /**
   * Broadcast channel for asynchronous events with no handler context —
   * specifically, the settle-triggered `decision.board_flush` fan-out that
   * fires from a SettlementDetector timer callback. Wired once by the server
   * startup to the websocket broadcaster.
   */
  setBroadcaster(broadcast: EmitEvent) {
    this.broadcast = broadcast
  }

  /**
   * F002: Drain the Decision Board for a session and broadcast a single
   * `decision.board_flush` event carrying all pending entries. Called by
   * SettlementDetector after the 2s debounce when the A2A discussion has
   * truly settled. Stashes drained entries in `pendingBoardFlushes` so the
   * later `/decision-board/respond` handler (P2.T4) can look them up and
   * build the summary for the single-dispatch payload.
   *
   * No-op when the board has no pending entries (idempotent re-entry from
   * stacked settle events is safe).
   */
  /**
   * F040 P2 T14（AC13.5 Leg B）：同 root 链上是否存在起笔不晚于 beforeCreatedAt 的在飞 turn。
   * 在飞 = chainRegistry 有条目（带 rootMessageId）且 invocation 身份在册未 finalEmitted
   * （revoke/TTL/失败注销后自然放空——死 invocation 永不产 final，不该阻塞）。
   * createdAt 用登记时刻(ms)做起笔近似（登记与 assistant 行插入同步相邻，误差 ms 级）；
   * 同毫秒平局保守阻塞 + excludeInvocationId 自排除（判定核见 hasEarlierAliveEntry，
   * 德彪 P2 审 P2-2）。飞书出站顺序门（Leg B）消费。
   */
  hasEarlierRunningTurn(
    rootMessageId: string,
    beforeCreatedAtIso: string,
    excludeInvocationId?: string,
  ): boolean {
    const beforeMs = Date.parse(beforeCreatedAtIso)
    if (!Number.isFinite(beforeMs)) return false
    return hasEarlierAliveEntry(
      this.chainRegistry.listByRoot(rootMessageId),
      beforeMs,
      (id) => this.invocations.hasIdentity(id) && !this.invocations.isFinalEmitted(id),
      excludeInvocationId,
    )
  }

  flushDecisionBoard(sessionGroupId: string): void {
    const board = this.decisionBoard
    if (!board) return
    if (!board.hasPending(sessionGroupId)) return

    const entries = board.drain(sessionGroupId)
    if (entries.length === 0) return

    this.pendingBoardFlushes.set(sessionGroupId, entries)

    const broadcast = this.broadcast
    if (!broadcast) return

    broadcast({
      type: "decision.board_flush",
      payload: {
        sessionGroupId,
        flushedAt: new Date().toISOString(),
        items: entries.map((entry) => ({
          id: entry.id,
          question: entry.question,
          options: entry.options,
          raisers: entry.raisers.map((r) => ({ alias: r.alias, provider: r.provider })),
          firstRaisedAt: entry.firstRaisedAt,
          converged: entry.converged,
        })),
      },
    })
  }

  /**
   * Look up the stashed entries from the most recent flush for a session.
   * Used by the `/decision-board/respond` handler (P2.T4) to build the
   * single-dispatch summary. Returns `undefined` when no flush is pending.
   */
  getPendingFlushEntries(sessionGroupId: string): DecisionBoardEntry[] | undefined {
    return this.pendingBoardFlushes.get(sessionGroupId)
  }

  flushActiveStreaming(sessionGroupId: string): void {
    for (const entry of this.streamingFlushers.values()) {
      if (entry.sessionGroupId === sessionGroupId) {
        entry.flush()
      }
    }
  }

  /**
   * F002 P2.T4: Handle the user's response to a decision.board_flush. This
   * writes a single summary message (as user role) to the chain-starter
   * thread — the earliest assistant after the most recent user message —
   * and triggers ONE runThreadTurn on that thread. Unlike the old direct-
   * emit decision.request path, this is a single dispatch regardless of how
   * many [拍板] items were held on the board.
   *
   * `skipped=true` records a "produce暂未作出决定" summary and still
   * dispatches, giving the agents a prompt to continue on their own.
   */
  async handleDecisionBoardRespond(payload: {
    sessionGroupId: string
    decisions: Array<{
      itemId: string
      choice: { kind: "option"; optionId: string } | { kind: "custom"; text: string }
    }>
    skipped?: boolean
  }): Promise<void> {
    const entries = this.pendingBoardFlushes.get(payload.sessionGroupId)
    if (!entries || entries.length === 0) return

    const resolver = this.chainStarterResolver
    if (!resolver) return
    const target = resolver.resolve({
      sessionGroupId: payload.sessionGroupId,
      boardEntries: entries,
    })
    if (!target) return

    this.pendingBoardFlushes.delete(payload.sessionGroupId)

    const summary = payload.skipped
      ? this.buildSkippedSummary(entries)
      : this.buildDecisionSummary(entries, payload.decisions)

    const broadcast = this.broadcast
    const emit: EmitEvent = (event) => broadcast?.(event)

    const userMessage = this.sessions.appendUserMessage(target.threadId, summary)
    const rootMessageId = this.dispatch.registerUserRoot(userMessage.id, payload.sessionGroupId)
    const userTimeline = this.sessions.toTimelineMessage(target.threadId, userMessage.id)
    if (userTimeline) {
      emit({
        type: "message.created",
        payload: {
          threadId: target.threadId,
          sessionGroupId: payload.sessionGroupId,
          message: userTimeline,
        },
      })
    }

    for (const entry of entries) {
      emit({
        type: "decision.board_item_resolved",
        payload: { sessionGroupId: payload.sessionGroupId, itemId: entry.id },
      })
    }

    this.emitThreadSnapshot(payload.sessionGroupId, emit)

    await this.runThreadTurn({
      threadId: target.threadId,
      content: summary,
      emit,
      rootMessageId,
    })
  }

  buildDecisionSummary(
    entries: DecisionBoardEntry[],
    decisions: Array<{
      itemId: string
      choice: { kind: "option"; optionId: string } | { kind: "custom"; text: string }
    }>,
  ): string {
    const lines = ["产品已就以下问题作出决定："]
    for (const entry of entries) {
      if (entry.converged) {
        lines.push(`- ${entry.question} → (团队已收敛，无需决定)`)
        continue
      }
      const d = decisions.find((x) => x.itemId === entry.id)
      if (!d) {
        lines.push(`- ${entry.question} → (未决定)`)
      } else {
        const choice = d.choice
        if (choice.kind === "option") {
          const opt = entry.options.find((o) => o.id === choice.optionId)
          lines.push(`- ${entry.question} → ${opt?.label ?? choice.optionId}`)
        } else {
          lines.push(`- ${entry.question} → 自定义答复："${choice.text}"`)
        }
      }
      if (entry.raisers.length > 1) {
        lines.push(`  (由 ${entry.raisers.map((r) => r.alias).join("、")} 共同提出)`)
      }
    }
    return lines.join("\n")
  }

  buildSkippedSummary(entries: DecisionBoardEntry[]): string {
    const lines = ["产品暂未就以下问题作出决定："]
    for (const entry of entries) {
      const who = entry.raisers.map((r) => r.alias).join("、")
      lines.push(`- [${entry.question}] ${who} 提出`)
    }
    lines.push("\n你可以基于当前讨论继续推进，必要时再次 [分歧点] 提问。")
    return lines.join("\n")
  }

  /**
   * True iff the Decision Board has any pending entries for this session
   * group. SettlementDetector consults this alongside dispatch state to
   * decide whether a flush is due.
   */
  hasPendingBoardEntries(sessionGroupId: string): boolean {
    return this.decisionBoard?.hasPending(sessionGroupId) ?? false
  }

  /**
   * SettlementDetector signal: is any CLI turn currently running for this
   * session group? Reads dispatch slot state (source of truth for which
   * provider is executing a turn).
   */
  hasRunningTurn(sessionGroupId: string): boolean {
    return this.dispatch.getAgentStatuses(sessionGroupId).some((status) => status.running)
  }

  /**
   * F002 SettlementDetector signal compat stub. F026 P2 clean-cut Step 3
   * 删 ParallelGroupRegistry 后永远 false —— 多 @ 路径已改走 worklist 续推 +
   * SettlementDetector 余下 3 项 signal（hasQueuedDispatches / hasRunningTurn /
   * hasContinuationInFlight）判定 settle。保留 export 名兼容 F002 信号 1 接口。
   */
  hasActiveParallelGroupInSession(_sessionGroupId: string): boolean {
    return false
  }

  handleClientEvent(event: RealtimeClientEvent, emit: EmitEvent) {
    if (event.type === "stop_thread") {
      this.cancelThreadChain(event.payload.threadId, emit)
      return
    }

    if (event.type === "end_session") {
      // TODO: 实现结束整个会话的逻辑
      return
    }

    if (event.type !== "send_message") {
      return
    }

    void this.handleSendMessage(event, emit).catch((err) => {
      this.log.error({ err }, "handleSendMessage unhandled rejection")
    })
  }

  cancelThreadChain(threadId: string, emit: EmitEvent) {
    const thread = this.dispatch.resolveThread(threadId)
    if (!thread) {
      return false
    }

    let cancelledRun = false
    for (const groupThread of this.sessions.listGroupThreads(thread.sessionGroupId)) {
      const run = this.invocations.get(groupThread.id)
      if (!run) {
        for (const invocationId of this.invocations.findInvocationIdsByThread(groupThread.id)) {
          this.releaseInvocation(invocationId)
          cancelledRun = true
        }
        continue
      }

      cancelledRun = true
      run.cancel()
      for (const invocationId of this.invocations.findInvocationIdsByThread(groupThread.id)) {
        this.releaseInvocation(invocationId)
      }
    }

    this.approvals?.cancelAll(thread.sessionGroupId)
    const cancelResult = this.dispatch.cancelSessionGroup(thread.sessionGroupId)
    const changed = cancelledRun || cancelResult.clearedCount > 0 || !cancelResult.alreadyCancelled
    if (!changed) {
      return false
    }

    emit({
      type: "status",
      payload: {
        sessionGroupId: thread.sessionGroupId,
        message: `正在停止 ${thread.alias} 房间内的待执行协作任务。`,
      },
    })
    this.emitThreadSnapshot(thread.sessionGroupId, emit)
    return true
  }

  cancelSingleAgent(threadId: string, agentId: string, emit: EmitEvent): boolean {
    const thread = this.dispatch.resolveThread(threadId)
    if (!thread) {
      return false
    }

    const groupThreads = this.sessions.listGroupThreads(thread.sessionGroupId)
    const targetThread = groupThreads.find((t) => t.provider === agentId)
    if (!targetThread) {
      return false
    }

    let cancelled = false
    const run = this.invocations.get(targetThread.id)
    if (run) {
      run.cancel()
      cancelled = true
    }
    for (const invocationId of this.invocations.findInvocationIdsByThread(targetThread.id)) {
      this.releaseInvocation(invocationId)
      cancelled = true
    }

    const clearedFromQueue = this.dispatch.clearProviderQueue(
      thread.sessionGroupId,
      targetThread.provider as Provider,
    )
    if (clearedFromQueue > 0) cancelled = true

    if (!cancelled) {
      return false
    }

    emit({
      type: "status",
      payload: {
        sessionGroupId: thread.sessionGroupId,
        message: `已停止 ${targetThread.alias} 的运行。`,
      },
    })
    this.emitThreadSnapshot(thread.sessionGroupId, emit)
    return true
  }

  async handleAgentPublicMessage(options: {
    threadId: string
    messageId: string
    content: string
    invocationId: string
    emit: EmitEvent
  }) {
    const thread = this.dispatch.resolveThread(options.threadId)
    if (!thread || !options.content.trim()) {
      return
    }
    this.log.info({ from: thread.alias, threadId: thread.id }, "agent public message")

    const invocation = this.dispatch.resolveInvocation(options.invocationId)
    if (!invocation) {
      return
    }

    this.dispatch.attachMessageToRoot(options.messageId, invocation.rootMessageId)
    const enqueueResult = this.dispatch.enqueuePublicMentions({
      messageId: options.messageId,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider,
      sourceAlias: thread.alias,
      rootMessageId: invocation.rootMessageId,
      content: options.content,
      matchMode: "line-start",
      parentInvocationId: options.invocationId,
      buildSnapshot: () => this.captureSnapshot(thread.sessionGroupId, options.messageId),
      // F026-P3 Task3 · return-path：agent 公共消息的完整原文派发到下游（如 4195 字 review），
      // 走 buildReturnPathPayload 16k token cap + 头尾保留 + msg_id 引用。
      extractSnippet: buildReturnPathExtractSnippet(options.messageId),
    })
    this.emitBlockedDispatches(enqueueResult, options.emit)

    // A2A 协助 header connector — 见 module-level writeConnectorHeadersForQueue。
    // F026 P5 in-flight (R-104)：MCP/CLI hook 与 LLM 主链路 final flush 共用此 helper。
    writeConnectorHeadersForQueue(this.sessions, enqueueResult, options.emit)

    await this.flushDispatchQueue(thread.sessionGroupId, options.emit)
  }

  private async handleSendMessage(
    event: Extract<RealtimeClientEvent, { type: "send_message" }>,
    emit: EmitEvent,
  ) {
    this.log.info(
      { provider: event.payload.provider, content: event.payload.content.slice(0, 80) },
      "user message received",
    )
    const thread = this.dispatch.resolveThread(event.payload.threadId)
    if (!thread) {
      emit({
        type: "status",
        payload: { message: "未找到相关线程。" },
      })
      return
    }

    // F022 review 2nd round P1: archived/deleted 会话禁止写入。
    // 远端标签页即使漏切 activeGroup，服务端也要挡住；否则会在失效会话上继续落消息。
    const sendable = this.sessions.isSessionGroupSendable(thread.sessionGroupId)
    if (!sendable.sendable) {
      emit({
        type: "status",
        payload: {
          sessionGroupId: thread.sessionGroupId,
          message:
            sendable.reason === "archived"
              ? "会话已归档，无法继续发送消息。请先从归档中恢复。"
              : "会话已删除，无法继续发送消息。",
        },
      })
      return
    }

    const groupBusyMessage = this.getBusyStatus(thread.id, thread.sessionGroupId)
    if (groupBusyMessage) {
      emit({
        type: "status",
        payload: { sessionGroupId: thread.sessionGroupId, message: groupBusyMessage },
      })
      this.emitThreadSnapshot(thread.sessionGroupId, emit)
      return
    }

    const contentBlocksJson = event.payload.contentBlocks?.length
      ? JSON.stringify(event.payload.contentBlocks)
      : "[]"
    const userMessage = this.sessions.appendUserMessage(
      thread.id,
      event.payload.content,
      contentBlocksJson,
      // F040 P2 T11 · 外部渠道注入的发送者真名（群成员）；web 端不传 → NULL → timeline 村长
      event.payload.senderDisplayName ?? null,
    )
    const rootMessageId = this.dispatch.registerUserRoot(userMessage.id, thread.sessionGroupId)
    // F026 P2 Step 1A.2 · 建 user-root call —— call tree 的源点。R-080 实证 user 入口
    // 不建 root call → mention 派发的 child call 全是 orphan root，链尾闭环时无锚点
    // 回追 user，续推机制（Step 1B）也没 attach 点。lifecycle 缺省 (单元测试 / 旧
    // 路径不 wire) 时 ?. 跳过，对老行为零影响。
    const userRootCallId = this.a2aLifecycle?.openRootCall({
      issuerAlias: "user",
      sessionGroupId: thread.sessionGroupId,
      deadlineAt: new Date(Date.now() + DEFAULT_A2A_CALL_DEADLINE_MS).toISOString(),
    })
    const userTimeline = this.sessions.toTimelineMessage(thread.id, userMessage.id)
    if (userTimeline) {
      emit({
        type: "message.created",
        payload: {
          threadId: thread.id,
          sessionGroupId: thread.sessionGroupId,
          message: userTimeline,
          clientMessageId: event.payload.clientMessageId,
        },
      })
    }

    this.emitThreadSnapshot(thread.sessionGroupId, emit)

    // Enqueue ALL mentioned agents BEFORE running any turn, so flushDispatchQueue can dispatch them in parallel.
    // sourceAlias is "user" (not the thread alias) so that buildA2APrompt correctly attributes the request to the user.
    const enqueueResult = this.dispatch.enqueuePublicMentions({
      messageId: userMessage.id,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider,
      sourceAlias: "user",
      rootMessageId,
      content: event.payload.content,
      matchMode: "anywhere",
      parentInvocationId: null,
      // F026 P2 Step 1A.2 · 透 user-root callId 给 gateway，让 mention 派发出的
      // child call 真正挂在 user-root 下（而不是各自做 orphan root）。gateway 没 wire
      // 或 A2A_CALL_TREE_ENABLED=0 时 dispatch 内部走 fallback resolveMentions，
      // 该参数被忽略，老行为不变。
      parentCallId: userRootCallId ?? null,
      buildSnapshot: () => this.captureSnapshot(thread.sessionGroupId, userMessage.id),
      extractSnippet: (c, alias) => extractTaskSnippet(c, alias),
    })
    this.emitBlockedDispatches(enqueueResult, emit)

    // F026 P2 v2 review#1 (范德彪 P1): user 入口的 fan-out 也要注册 root worklist。
    // 之前 registerForDispatch 唯一生产调用在 final flow（agent turn 结束派 child），
    // user 第一次 @A @B 不写 root worklist → onChildFinished
    // findActiveByParentCallId(userRootCallId) 找不到 → cascade 死锁、续推不触发。
    // userRootCallId 缺省（lifecycle 不 wire）时 registerForDispatch 内部 return null。
    if (userRootCallId && enqueueResult.queued.length > 0) {
      this.worklistExecutor?.registerForDispatch({
        parentCallId: userRootCallId,
        sessionGroupId: thread.sessionGroupId,
        queued: enqueueResult.queued,
      })
    }

    // If the panel thread's provider joined the parallel group (user @'d 2+ agents including
    // this one), skip directTurn — queueFlush will dispatch it as part of the fan-out,
    // ensuring it's a real participant of the parallel group. Otherwise directTurn would
    // run outside the group and fan-in would fire early with one agent still thinking.
    const sourceInQueue = enqueueResult.queued.some(
      (entry) => entry.to.provider === thread.provider,
    )

    if (sourceInQueue) {
      await this.flushDispatchQueue(thread.sessionGroupId, emit)
      return
    }

    // F019 P4: skill hint KEYWORD scan was removed (Mode B regression root).
    // Explicit slash commands (/guardian, /think, /review, ...) are still
    // user-typed intent — preserved via applySlashCommandHint which only
    // fires on registered slashes, never on free-form content. Non-slash
    // messages pass through unchanged; SOP direction comes from sopStageHint
    // in system prompt + CLI-native skill discovery.
    const effectiveContent = applySlashCommandHint(event.payload.content, this.skillRegistry)

    // F026 P2 Step 1A.2 · directTurn 路径下 thread agent 自己回复不走 a2a-gateway,
    // 必须在 runThreadTurn 调用前自建 child call 挂在 user-root 下，并把 callId
    // 透 dispatchedCallId 给 runThreadTurn —— advance/settle/cleanup-timer
    // 全链路要靠它。lifecycle / userRootCallId 缺省时跳过（老行为）。
    //
    // F026 P2 Step 1A.2 修补：replyTo 必须显式指向 thread agent (provider:alias),
    // 不能回落到 issuerAlias="user" —— 续推派发反查 replyTo 解析 provider 时若拿到
    // "user" 字面量则不是合法 Provider 值，findThreadByGroupAndProvider → null →
    // 续推派发死链。replyTo 必须正确指向 thread agent 才能让续推接通 parent thread。
    const directTurnCallId =
      this.a2aLifecycle && userRootCallId
        ? this.a2aLifecycle.openCall({
            parentCallId: userRootCallId,
            issuerAlias: "user",
            sessionGroupId: thread.sessionGroupId,
            deadlineAt: new Date(Date.now() + DEFAULT_A2A_CALL_DEADLINE_MS).toISOString(),
            replyTo: `${thread.provider}:${thread.alias}`,
          })
        : undefined

    // The user's message was sent to a specific thread — run that thread's turn concurrently with queued dispatches.
    const directTurn = this.runThreadTurn({
      threadId: thread.id,
      content: effectiveContent,
      emit,
      rootMessageId,
      dispatchedCallId: directTurnCallId,
      // r2 范-r1 P2: directTurn 显式 scenario（虽然推断也对，显式更稳）
      scenario: "direct_turn",
    })
    const queueFlush = this.flushDispatchQueue(thread.sessionGroupId, emit)
    await Promise.allSettled([directTurn, queueFlush])
  }

  private async runThreadTurn(options: {
    threadId: string
    content: string
    emit: EmitEvent
    rootMessageId: string
    parentInvocationId?: string | null
    /** Pre-computed system prompt (from assemblePrompt). When omitted, assembleDirectTurnPrompt is used. */
    systemPrompt?: string
    /**
     * When true, skip processing @-mentions in the reply. Used for terminal
     * turns (synthesizer, Phase 2) where further fan-out would cascade
     * unintended agent runs. Default false.
     */
    suppressOutboundDispatch?: boolean
    /** Collapsible group ID for the resulting message */
    groupId?: string | null
    /** Role within the collapsible group */
    groupRole?: "header" | "member" | "convergence" | null
    /** Counter for seal auto-resume (prevents infinite loops) */
    autoResumeCount?: number
    /**
     * F026 P1 Wiring · the gateway-issued call_id this turn is settling.
     * Set when this turn was triggered via the A2A queue (flag-on path).
     * Undefined for user direct turns and classic / flag-off dispatches.
     * On undefined, every lifecycle call is a noop — see A2ALifecycleService.
     */
    dispatchedCallId?: string
    /**
     * F027 Phase 3 P20 G1 r2 (范-r1 P2): wake-up scenario 显式参数。
     * caller 应显式传：worklist 续推 → "a2a_handoff" / directTurn → "direct_turn" /
     * A2A 派发 → "a2a_handoff" / 其他 → 未传由 deriveWakeTriggerScenario fallback。
     *
     * r1 推断纯靠 (systemPrompt + dispatchedCallId) 错把 worklist 续推标 direct_turn
     * （续推没 systemPrompt 但有 dispatchedCallId），r2 改显式优先 + 推断 fallback。
     */
    scenario?: WakeTriggerScenario
  }): Promise<{ messageId: string; content: string } | null> {
    const thread = this.dispatch.resolveThread(options.threadId)
    if (!thread) {
      options.emit({
        type: "status",
        payload: { message: "未找到相关线程。" },
      })
      return null
    }
    this.log.info(
      { threadId: thread.id, agentId: thread.alias, provider: thread.provider },
      "turn started",
    )

    if (this.invocations.has(thread.id)) {
      options.emit({
        type: "status",
        payload: {
          sessionGroupId: thread.sessionGroupId,
          message: `${thread.alias} 已经在运行中。`,
        },
      })
      return null
    }

    // F027 Phase 3 P20 G1 (AC-P3-5 物理依赖 · plan v3.1 §1.2-9):
    // wake-up 时向所有 WS connection 广播 wake.trigger event。前端 prompt-inspector
    // 顶部据此渲染 🔔 触发因块（V16.5.2），click pill 触发 in-place drawer 展开
    // mini call tree（复用 F026 <A2ATreeView>）。
    //
    // r2 范-r1 P2: scenario 优先用 options 显式传值（caller 知 context 最准），
    // 否则 fallback deriveWakeTriggerScenario 推断。修 r1 worklist 续推误判 direct_turn 的 bug。
    //
    // broadcaster 未注入（测试 fixture / boot 早期）→ 静默 skip，wake-up 流程不受影响。
    const wakeBroadcast = this.broadcast
    if (wakeBroadcast) {
      try {
        const wakeCanonicalRoomId = this.sessions.getRoomId(thread.sessionGroupId)
        const wakeScenario =
          options.scenario ??
          deriveWakeTriggerScenario({
            systemPrompt: options.systemPrompt,
            dispatchedCallId: options.dispatchedCallId,
            parentInvocationId: options.parentInvocationId,
          })
        wakeBroadcast({
          type: "wake.trigger",
          payload: {
            threadId: thread.id,
            sessionGroupId: thread.sessionGroupId,
            roomId: wakeCanonicalRoomId,
            alias: thread.alias,
            scenario: wakeScenario,
            a2aCallId: options.dispatchedCallId ?? null,
            triggeredAt: new Date().toISOString(),
          },
        })
      } catch (err) {
        // fail-soft：broadcaster 异常不阻塞 wake-up 主流程（prompt-inspector 拿不到
        // trigger 只影响 UI 显示，不影响 LLM 调用）
        this.log.warn(
          { err, threadId: thread.id, alias: thread.alias },
          "wake.trigger broadcast failed (non-blocking)",
        )
      }
    }

    // F021 Phase 5: flush pending → active and resolve effective model BEFORE
    // appending the assistant placeholder, so the message row carries the
    // correct snapshot for the chat bubble pill. Order: snapshot → resolve →
    // append. The same snapshot is later emitted on invocation.started.
    // F027 收尾补丁 AC-W1：session 快照只含 agent overrides（wikiCompile 是全局专属段，
    // 不进 session / invocation configSnapshot）→ 用窄类型 AgentOverridesConfig。
    const sessionSnapshot = this.sessions.flushSessionPending(
      thread.sessionGroupId,
    ) as AgentOverridesConfig
    const hasSessionSnapshot = Object.keys(sessionSnapshot).length > 0
    const globalConfig = loadRuntimeConfig()
    const globalOverride = globalConfig[thread.provider]
    const snapshotForProvider: AgentOverride | undefined = sessionSnapshot[thread.provider]
    // F021 P1 (范德彪 review): merge at field granularity so a session snapshot
    // that only sets `effort` still inherits `model` from the global override.
    const runtimeOverride = resolveEffectiveOverride(
      snapshotForProvider,
      globalOverride,
      thread.provider,
    )
    const resolvedModel = runtimeOverride?.model ?? thread.currentModel
    // F021 Phase 6: 三层 seal 阈值（会话 → 全局 → 代码 fallback）。
    // 用户在齿轮里调 sealPct 时这里立刻生效，不再绑死 SEAL_THRESHOLDS_BY_PROVIDER。
    const sealThresholds = resolveSealThresholds(thread.provider, globalConfig, sessionSnapshot)
    // F021 Phase 6: contextWindow 用户层 override（CLI 报告/代码 fallback 仍由 cli-orchestrator 内部接管）。
    const contextWindowOverride =
      sessionSnapshot[thread.provider]?.contextWindow ??
      globalConfig[thread.provider]?.contextWindow

    const assistant = this.sessions.appendAssistantMessage(
      thread.id,
      "",
      "",
      "final",
      options.groupId ?? null,
      options.groupRole ?? null,
      "[]",
      resolvedModel,
      // F026 acceptance-guardian R-204 · target agent 写 final message 时绑定 a2aCallId,
      // 让 listMessages LEFT JOIN a2a_calls 出 onBehalfOf / parentCallId / displayMode
      // —— 前端 P5 视觉原语 (ConnectorBubble / Visual Silo / 折叠群组) 入口。
      options.dispatchedCallId ?? null,
    )
    this.dispatch.attachMessageToRoot(assistant.id, options.rootMessageId)
    const assistantTimeline = this.sessions.toTimelineMessage(thread.id, assistant.id)
    if (assistantTimeline) {
      options.emit({
        type: "message.created",
        payload: {
          threadId: thread.id,
          sessionGroupId: thread.sessionGroupId,
          message: assistantTimeline,
        },
      })
    }

    const identity = this.invocations.createInvocation(thread.id, thread.alias)
    const dispatchContextTtlMs = Math.max(0, new Date(identity.expiresAt).getTime() - Date.now())
    // F026 P1 Wiring · TTL fire = invocation never released by happy/error path
    // (e.g. CLI hung past deadline). Treat as timeout for the call-registry row
    // so pendingOf() doesn't show ghost work forever.
    const dispatchCleanupTimer = globalThis.setTimeout(() => {
      this.a2aLifecycle?.settleTimeout(options.dispatchedCallId)
      this.dispatch.releaseInvocation(identity.invocationId)
    }, dispatchContextTtlMs)
    dispatchCleanupTimer.unref?.()
    this.dispatch.bindInvocation(identity.invocationId, {
      rootMessageId: options.rootMessageId,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider,
      parentInvocationId: options.parentInvocationId ?? null,
      // F026 acceptance-guardian R-204 · 透传 dispatchedCallId 进 invocation context,
      // 让下游 enqueuePublicMentions 能桥接到 a2a-gateway parentCallId,
      // 接通 call tree —— 下游 P5 视觉原语 + R-066 sibling 收敛依赖此。
      dispatchedCallId: options.dispatchedCallId ?? null,
    })
    // F026 P1 Wiring · agent has the slot and is about to spawn the CLI →
    // pending → working. Noop when no callId (classic / direct user turn).
    this.a2aLifecycle?.advance(options.dispatchedCallId)
    this.chainRegistry.register({
      invocationId: identity.invocationId,
      threadId: thread.id,
      provider: thread.provider,
      alias: thread.alias,
      parentInvocationId: options.parentInvocationId ?? null,
      rootMessageId: options.rootMessageId,
      sessionGroupId: thread.sessionGroupId,
      createdAt: Date.now(),
    })

    const startedAt = new Date().toISOString()
    let promptRequestedByCli: string | null = null
    // F031 AC4 · content / thinking 改 StreamAccumulator：push 原子返回 append 前
    // offset 给 delta emit 用（独立 offset 空间），杜绝先 append 后取长度的错序。
    const thinkingAcc = new StreamAccumulator()
    let stderrLineBuf = ""
    let toolEventsJson = "[]"
    let run: ActiveRun | null = null
    const contentAcc = new StreamAccumulator()
    let lastContentFlushAt = Date.now()
    const CONTENT_FLUSH_INTERVAL_MS = 3000

    const flushKey = identity.invocationId
    this.streamingFlushers.set(flushKey, {
      sessionGroupId: thread.sessionGroupId,
      flush: () => {
        this.sessions.overwriteMessage(assistant.id, {
          content: contentAcc.current,
          thinking: thinkingAcc.current,
          toolEvents: toolEventsJson,
        })
      },
    })

    // F021 Phase 3.3: snapshot the resolved per-provider config onto this
    // invocation (already computed above for the assistant message bubble).
    this.events.emit({
      type: "invocation.started",
      invocationId: identity.invocationId,
      threadId: identity.threadId,
      agentId: identity.agentId,
      callbackToken: identity.callbackToken,
      status: "running",
      createdAt: startedAt,
      configSnapshot: hasSessionSnapshot ? sessionSnapshot : null,
    })

    options.emit({
      type: "status",
      payload: { sessionGroupId: thread.sessionGroupId, message: `正在运行 ${thread.alias}` },
    })

    // System prompt + content: use pre-computed (from assemblePrompt for A2A)
    // or compute on the fly (direct turn). F004: direct-turn assembly now
    // returns both systemPrompt AND a content envelope with real history
    // baked in — the API is the authoritative history source.
    let assembledDirectTurn: AssemblePromptResult | null = null
    // F042 AC2 · direct 支采纳判定上下文（回复终稿落库后回写 recall_adopted）。
    // 方法级作用域——召回发生在下方 if 块内，判定钩子在 CLI 结果回来之后。
    let directAuditRowId: number | null = null
    let directAdoptionHits: Array<{ path: string }> | null = null
    // F042 shadow 异步化 · 采纳判定双向交汇：shadow 态召回 fire-and-forget，hits 与
    // replyText 谁后到谁触发判定（Node 单线程事件循环，无竞态锁需求）。judged 幂等闸。
    let directReplyText: string | null = null
    let directAdoptionJudged = false
    const tryJudgeDirectAdoption = () => {
      if (
        directAdoptionJudged ||
        directAuditRowId === null ||
        !directAdoptionHits?.length ||
        directReplyText === null
      ) {
        return
      }
      directAdoptionJudged = true
      try {
        const verdict = judgeAdoption(directReplyText, directAdoptionHits)
        if (verdict) this.promptAuditWriter.updateAdoption(directAuditRowId, verdict)
      } catch (err) {
        this.log.warn(
          { stage: "recall_adoption", err: (err as Error).message },
          "recall adoption update failed (non-blocking)",
        )
      }
    }
    // shadow 态异步召回标记（写 audit 占位行后启动 fire-and-forget）
    let shadowRecallAsync = false
    if (!options.systemPrompt) {
      const roomSnapshot = this.captureSnapshot(thread.sessionGroupId, options.rootMessageId)
      const parsedBookmark = thread.sopBookmark
        ? (() => {
            try {
              return JSON.parse(thread.sopBookmark)
            } catch {
              return null
            }
          })()
        : null
      // F018 P4 AC3.5 wiring: when starting a new session, pass bootstrap metadata
      // so assemblePrompt injects SessionBootstrap prelude (reference-only + Do NOT guess).
      // F018 P4 (Codex HIGH #2 fix): Feed the most recent sealed digest as
      // `previousDigest` so the Bootstrap includes [Previous Session Summary].
      const previousDigest = this.transcriptWriter
        ? await this.transcriptWriter.readLatestDigest(thread.id).catch(() => null)
        : null
      const directTurnThreadMemory = this.sessions.getThreadMemory(thread.id)
      // F026-P3 Task7 · user-mention 路径 cold-target burst 兜底
      const directTurnColdBurst = tryBuildColdTargetBurst({
        nativeSessionId: thread.nativeSessionId,
        threadMemoryEmpty: directTurnThreadMemory == null,
        previousDigestEmpty: previousDigest == null,
        roomSnapshot,
      })
      // F027 P4 hotfix · 加载 viewfinder（room 绑定 + loader 已注入时）。
      // V16.5 §4 line 407："加 [Viewfinder — Reference Only] 区段（room 防漂移视图）"
      // 失败 fail-soft：viewfinder 读不到不阻塞 direct turn。
      const directTurnRoomId = this.sessions.getRoomId(thread.sessionGroupId)
      const directTurnViewfinder = await this.loadViewfinderSafe(directTurnRoomId)
      // F027 B1-b · direct/wake-up 支自动召回接线（wiring gap 2026-06-05：此前仅 A2A 支调
      // executeIfNeeded，wake_up 场景 Recall Pack 永不注入）。仅显式 wake_up（auto-resume）触发召回；
      // 普通 direct_turn 由 coordinator scenario_skip（spec V16.5 line 1094 / coordinator.ts:96）。
      // query=本轮 user content；roomId 缺 canonical R-### 时用 sessionGroupId 兜底（与 A2A 支同口径）。
      const directRecallScenario: "wake_up" | "direct_turn" =
        options.scenario === "wake_up" ? "wake_up" : "direct_turn"
      // F027 B1-b-2 · 冷启（nativeSession===null = 新 session 首轮 = 北极星「不白板」本体）走
      // 轻量 loadTaskMemoryPack Pack（spec V16.5 line 95：session_bootstrap 由 Pack 覆盖，非
      // coordinator）；非冷启走 b-1 coordinator（wake_up 召回 / direct_turn scenario_skip）。
      // 两者互斥（wake_up auto-resume 必有 nativeSession）。命中 → memoryPreflight → [Recall Pack]。
      let directRecall: RecallCoordinatorResult | null = null
      let directMemoryPreflight:
        | { hits: Array<{ score: number; summary: string; path?: string }> }
        | null = null
      // F027 #286 FU-3 · 冷启召回 audit 观测（B1-b-2 P3-6）：loadTaskMemoryPack 不走
      // Coordinator → directRecall 恒 null → recallPatch 全空。这里单独构冷启 patch
      // （trigger=session_bootstrap + topScore/satisfied），Prompt Inspector 可程序化追溯。
      let coldStartRecallPatch: ReturnType<typeof buildColdStartRecallAuditPatch> | null = null
      if (thread.nativeSessionId === null) {
        const coldStart = await resolveColdStartRecall(
          this.memoryPreflightSearch,
          {
            roomId: directTurnRoomId ?? thread.sessionGroupId,
            alias: thread.alias,
            taskSummary: options.content,
          },
          this.log,
        )
        directMemoryPreflight = coldStart?.memoryPreflight ?? null
        // receive 德彪 r1 P2-2：完整 preflight audit 透传 —— inspector-only topScore /
        // 真 budgetExceeded / V15.1 字段不丢（与 deriveAuditPatch 语义一致）。
        coldStartRecallPatch = buildColdStartRecallAuditPatch({
          attempted: this.memoryPreflightSearch !== null,
          hits: directMemoryPreflight?.hits ?? null,
          audit: coldStart?.audit ?? null,
        })
        // F042 AC2 · 冷启注入的 Pack 命中也进采纳判定（path 缺省的 hit 无从比对，滤掉）
        const coldHitsWithPath = (directMemoryPreflight?.hits ?? []).filter(
          (h): h is { score: number; summary: string; path: string } => typeof h.path === "string",
        )
        directAdoptionHits =
          coldHitsWithPath.length > 0 ? coldHitsWithPath.map((h) => ({ path: h.path })) : null
      } else if (this.directTurnRecallMode === "shadow" && directRecallScenario === "direct_turn") {
        // F042 shadow 异步化 · shadow 不注入 → prompt 不依赖召回结果 → 不阻塞 spawn。
        // 原同步 await 把 L2 CLI-spawn 型 rerank 的 20-60s 直接叠在用户实时等待上
        // （preview 验收实测 20250/29758/60169ms 熔断三连）。观察器不该打扰被观察者。
        // audit 行在下方先写占位（mode/trigger/query 已知），召回 settle 后回填真值。
        shadowRecallAsync = true
      } else {
        const res = await resolveDirectTurnRecall(this.adaptiveRecallCoordinator, {
          roomId: directTurnRoomId ?? thread.sessionGroupId,
          alias: thread.alias,
          scenario: directRecallScenario,
          query: options.content,
          excludeMessageIds: options.rootMessageId ? [options.rootMessageId] : undefined,
        })
        directRecall = res.recallResult
        // F042 AC1 · shadow 影子拦截：召回结果保留给 audit（directRecall），注入按三态放行。
        // （wake_up 场景 mode 不适用恒放行；inject 放行；off 在 coordinator 白名单外 executed=false）
        directMemoryPreflight = applyShadowSuppression(
          this.directTurnRecallMode,
          directRecallScenario,
          res.memoryPreflight,
        )
        // F042 AC2 · 召回命中留给采纳判定（shadow 不注入也判——相关性代理信号）
        directAdoptionHits =
          directRecall?.executed && directRecall.hits.length > 0
            ? directRecall.hits.map((h) => ({ path: h.path }))
            : null
      }
      assembledDirectTurn = await assembleDirectTurnPrompt(
        {
          provider: thread.provider,
          threadId: thread.id,
          sessionGroupId: thread.sessionGroupId,
          nativeSessionId: thread.nativeSessionId,
          task: options.content,
          sourceAlias: "user",
          targetAlias: thread.alias,
          roomSnapshot,
          sopBookmark: parsedBookmark,
          lastFillRatio: thread.lastFillRatio ?? undefined,
          sessionChainIndex: this.sessions.getSessionChainIndex(thread.id),
          threadMemory: directTurnThreadMemory,
          previousDigest,
          recallTools: [],
          coldTargetBurst: directTurnColdBurst,
          // F027 P4 hotfix · 注 viewfinder + roomId（scenario 默认 wake_up）
          viewfinder: directTurnViewfinder,
          roomId: directTurnRoomId,
          // F027 P4-A1 · capability_digest 注入（V16.5 §13）— receiver = thread.alias 自己
          capabilityDigest: this.getSelfCapabilityDigest(thread.alias),
          // F027 P4-A2 + fallback j2 P1 修 · handbook agentActions 仅 first wake-up 注入。
          // 详见 maybeGetHandbookSlicesForFirstWakeUp helper jsdoc（V16.5 §4 line 364-365）。
          handbookSlices: this.maybeGetHandbookSlicesForFirstWakeUp(thread),
          // F027 B1-b · 自动召回命中 → [Recall Pack — Reference Only] 注入（wake_up 才非空）。
          memoryPreflight: directMemoryPreflight,
        },
        this.memoryService,
      )

      // F027 P4 hotfix · direct turn 也写一行 prompt_audit（V16.5 §18 line 2117
      // "assembler 每次拼装完成时同步写一条 prompt_audit"）。Phase 1-3 只 A2A 写 →
      // prompt-inspector UI 看 direct turn 房间永远 0 row 是 bug。
      directAuditRowId = this.writePromptAuditSafe({
        scenario: directRecallScenario,
        alias: thread.alias,
        roomId: directTurnRoomId,
        assembled: assembledDirectTurn,
        sourceEventIds: options.rootMessageId ? [options.rootMessageId] : [],
        agentSessionRef: thread.nativeSessionId,
        // F042 AC2 · direct_turn 记写入时三态（wake_up 不记——模式语义只属 direct_turn；
        // 德彪 r1 P1-2：冷启行也不记——冷启 Pack 实际注入，记 mode 会把注入行为污染进
        // shadow 观察窗，audit 列语义与真实注入行为必须一致）。
        recallMode:
          directRecallScenario === "direct_turn" && coldStartRecallPatch === null
            ? this.directTurnRecallMode
            : null,
        // F027 B1-b · recall patch（Prompt Inspector 显示召回 trigger/required + output 派生字段）。
        // FU-3：冷启支用 session_bootstrap patch（coordinator patch 在冷启恒空）。
        // F042 AC1 · query 透传 → V15.1 recallQueries/recallResults 落行（审计可追溯）。
        // F042 shadow 异步化：占位 patch（required/trigger/query 已知），settle 后 updateRecallPatch 回填。
        recallPatch:
          coldStartRecallPatch ??
          (shadowRecallAsync
            ? {
                ...buildRecallAuditPatch({
                  output: undefined,
                  trigger: deriveTriggerFromScenario(directRecallScenario),
                  recallRequired: true,
                }),
                recallQueries: JSON.stringify([options.content]),
              }
            : buildRecallAuditPatch({
                output: directRecall?.output,
                trigger: directRecall ? deriveTriggerFromScenario(directRecallScenario) : null,
                recallRequired: directRecall?.executed === true,
                query: options.content,
              })),
      })
      if (shadowRecallAsync) {
        const auditRowIdForBackfill = directAuditRowId
        void resolveDirectTurnRecall(this.adaptiveRecallCoordinator, {
          roomId: directTurnRoomId ?? thread.sessionGroupId,
          alias: thread.alias,
          scenario: directRecallScenario,
          query: options.content,
          excludeMessageIds: options.rootMessageId ? [options.rootMessageId] : undefined,
        })
          .then((res) => {
            const recall = res.recallResult
            if (auditRowIdForBackfill !== null) {
              try {
                this.promptAuditWriter.updateRecallPatch(
                  auditRowIdForBackfill,
                  buildRecallAuditPatch({
                    output: recall?.output,
                    trigger: deriveTriggerFromScenario(directRecallScenario),
                    recallRequired: recall?.executed === true,
                    query: options.content,
                  }),
                )
              } catch (err) {
                this.log.warn(
                  { stage: "shadow_recall_backfill", err: (err as Error).message },
                  "shadow recall audit backfill failed (non-blocking)",
                )
              }
            }
            directAdoptionHits =
              recall?.executed && recall.hits.length > 0
                ? recall.hits.map((h) => ({ path: h.path }))
                : null
            // turn 先完成（replyText 已知）时在此补判；否则 post-reply 钩子侧判
            tryJudgeDirectAdoption()
          })
          .catch((err) => {
            this.log.warn(
              { stage: "shadow_recall_async", err: (err as Error).message },
              "shadow async recall failed (non-blocking, audit row keeps placeholder)",
            )
          })
      }
    }
    const systemPrompt = options.systemPrompt ?? assembledDirectTurn!.systemPrompt
    // When direct turn assembled its own envelope, send that envelope as the
    // user message (it contains history + skill hint + wrapped task). When
    // options.systemPrompt was supplied externally (A2A path), the caller
    // already rendered the content, so we pass options.content through.
    const effectiveUserMessage = assembledDirectTurn?.content ?? options.content

    // F019 P3: Look up thread → feature binding → WorkflowSop → sopStageHint.
    // null when thread is not bound to a feature (pre-F019 behavior preserved).
    const sopStageHint = (() => {
      if (!this.workflowSopService) return undefined
      const sop = this.workflowSopService.get(thread.backlogItemId ?? "")
      if (!sop) return undefined
      return {
        featureId: sop.featureId,
        stage: sop.stage,
        suggestedSkill: sop.nextSkill,
      }
    })()

    // F018 P4 (Codex HIGH #1 fix): track the live CLI session id for the duration
    // of this turn. onSession sets it as soon as the CLI emits; recordEvent uses
    // it so first-ever sessions (thread.nativeSessionId=null) still attribute events.
    // Events that arrive before onSession fires get buffered and backfilled.
    let liveSessionId: string | null = null
    const pendingToolEvents: Array<{
      event: Record<string, unknown>
      at: string
    }> = []

    const createRun = (userMessage: string, sessionIdOverride?: string | null) =>
      runTurn({
        // F027 #286 FU-1 · 测试缝：fake runtime 注入（生产 null → provider 单例）。
        runtime: this.cliRuntimeOverride ?? undefined,
        systemPrompt,
        sopStageHint,
        invocationId: identity.invocationId,
        threadId: thread.id,
        provider: thread.provider,
        agentId: thread.alias,
        apiBaseUrl: this.apiBaseUrl,
        callbackToken: identity.callbackToken,
        model: resolvedModel,
        effort: runtimeOverride?.effort ?? null,
        sealThresholds,
        contextWindowOverride,
        nativeSessionId: sessionIdOverride ?? thread.nativeSessionId,
        userMessage,
        onAssistantDelta: (delta: string) => {
          options.emit({
            type: "assistant_delta",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              messageId: assistant.id,
              delta,
              // F031 AC4 · push 返回 append 前 offset（客户端 flush 时刻幂等判定基准）
              offset: contentAcc.push(delta),
            },
          })
          const now = Date.now()
          if (now - lastContentFlushAt >= CONTENT_FLUSH_INTERVAL_MS) {
            lastContentFlushAt = now
            this.sessions.overwriteMessage(assistant.id, {
              content: contentAcc.current,
              thinking: thinkingAcc.current,
              toolEvents: toolEventsJson,
            })
          }
        },
        // F043 AC8 · 轮中 usage 快照（节流 2s leading-edge）→ 运行中面板实时更新。
        // 末值不依赖此路径：turn 收尾 emitThreadSnapshot 带落库真值权威兜底。
        onUsageSnapshot: (snapshot) => {
          if (!this.usageSnapshotThrottle.shouldEmit(thread.id)) return
          options.emit({
            type: "usage.snapshot",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              threadId: thread.id,
              provider: thread.provider,
              usedTokens: snapshot.usedTokens,
              windowTokens: snapshot.windowTokens,
              fillRatio: Math.min(snapshot.usedTokens / snapshot.windowTokens, 1),
              source: snapshot.source,
            },
          })
        },
        onSession: (sid: string) => {
          // F018 P4 (fix Codex HIGH #1): Track the live session id so first-ever
          // sessions (where thread.nativeSessionId starts null) still attribute
          // their tool events to a real sessionId. If events arrived before the
          // id was known, backfill them now.
          liveSessionId = sid
          if (this.transcriptWriter && pendingToolEvents.length > 0) {
            for (const buffered of pendingToolEvents) {
              this.transcriptWriter.recordEvent({
                sessionId: sid,
                threadId: thread.id,
                event: buffered.event,
                at: buffered.at,
                invocationId: identity.invocationId,
              })
            }
            pendingToolEvents.length = 0
          }
        },
        onModel: () => {},
        onToolActivity: (line: string) => {
          options.emit({
            type: "assistant_thinking_delta",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              messageId: assistant.id,
              delta: `${line}\n`,
              // F031 AC4 · thinking emit 源 1/2（源 2 = 下方 stderr cleaned chunk，
              // 共用 thinkingAcc 同一 offset 空间）
              offset: thinkingAcc.push(`${line}\n`),
            },
          })
        },
        onToolEvent: (event) => {
          const parsed = JSON.parse(toolEventsJson) as unknown[]
          parsed.push(event)
          toolEventsJson = JSON.stringify(parsed)
          options.emit({
            type: "assistant_tool_event",
            payload: { sessionGroupId: thread.sessionGroupId, messageId: assistant.id, event },
          })
          // Persist toolEvents immediately so reconnecting clients don't lose tool steps
          this.sessions.overwriteMessage(assistant.id, {
            toolEvents: toolEventsJson,
          })
          // F018 P4 AC1.3 集成: buffer tool event for TranscriptWriter's extractive digest.
          // TranscriptWriter extractors look for: event.toolName (invocations),
          // event.path (filesTouched), event.type==="error" + event.message (errors).
          // sessionId 来源（按优先级）：liveSessionId (onSession 捕获的最新) →
          // thread.nativeSessionId (CLI 继承) → 都没有则暂存到 pendingToolEvents
          // 等 onSession 回填（修 Codex HIGH #1：首次 session 事件不能丢）
          if (this.transcriptWriter) {
            const transcriptSessionId = liveSessionId ?? thread.nativeSessionId
            const at = new Date().toISOString()
            if (transcriptSessionId) {
              this.transcriptWriter.recordEvent({
                sessionId: transcriptSessionId,
                threadId: thread.id,
                event: event as Record<string, unknown>,
                at,
                invocationId: identity.invocationId,
              })
            } else {
              // 暂存，等 onSession 回填
              pendingToolEvents.push({ event: event as Record<string, unknown>, at })
            }
          }
        },
        onLivenessWarning: (warning) => {
          // Surface liveness issues as status messages so the user sees *why* a turn is dragging on
          // before (or after) we force-kill. Soft warnings are informational; suspected_stall is a
          // heads-up that we're about to terminate the process.
          const seconds = Math.round(warning.silenceDurationMs / 1000)
          const isStall = warning.level === "suspected_stall"
          const label = isStall
            ? `${thread.alias} 已沉默 ${seconds}s（${warning.state}），判定为卡住，即将强制终止`
            : `${thread.alias} 已沉默 ${seconds}s（${warning.state}），持续观察中`
          options.emit({
            type: "status",
            payload: { sessionGroupId: thread.sessionGroupId, message: label },
          })
        },
        onActivity: (activity) => {
          this.events.emit({
            type: "invocation.activity",
            invocationId: identity.invocationId,
            threadId: thread.id,
            agentId: thread.alias,
            stream: activity.stream,
            chunk: activity.chunk,
            status: activity.stream === "stdout" ? "replying" : "thinking",
            createdAt: activity.at,
          })

          if (activity.stream === "stderr" && !promptRequestedByCli) {
            stderrLineBuf += stripAnsi(activity.chunk)
            const parts = stderrLineBuf.split("\n")
            stderrLineBuf = parts.pop() ?? ""
            if (parts.length > 0) {
              const cleanedChunk = filterStderrNoise(parts.join("\n") + "\n")
              if (cleanedChunk.trim()) {
                options.emit({
                  type: "assistant_thinking_delta",
                  payload: {
                    sessionGroupId: thread.sessionGroupId,
                    messageId: assistant.id,
                    delta: cleanedChunk,
                    // F031 AC4 · thinking emit 源 2/2（与 onToolActivity 共用 thinkingAcc）
                    offset: thinkingAcc.push(cleanedChunk),
                  },
                })
              }
            }
          }

          if (promptRequestedByCli || activity.stream !== "stderr") {
            return
          }

          const prompt = extractPromptFromActivityChunk(activity.chunk)
          if (!prompt) {
            return
          }

          promptRequestedByCli = prompt
          this.sessions.overwriteMessage(assistant.id, {
            content: prompt,
            thinking: thinkingAcc.current,
            toolEvents: toolEventsJson,
          })
          options.emit({
            type: "status",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              message: `${thread.alias} 需要你的确认。当前运行已暂停，请回复以继续。`,
            },
          })
          this.emitThreadSnapshot(thread.sessionGroupId, options.emit)

          run?.cancel()
        },
      })

    // F003/P2: mark the session group as having a continuation in flight so
    // SettlementDetector does not prematurely declare "settled" between two
    // continuation turns. Cleared in `finally`.
    this.settlementDetector?.markContinuationInFlight(thread.sessionGroupId, identity.invocationId)

    this.emitThreadSnapshot(thread.sessionGroupId, options.emit)

    try {
      const loopResult = await runContinuationLoop({
        initialUserMessage: effectiveUserMessage,
        createRun,
        onRunCreated: (handle) => {
          run = handle as ActiveRun
          this.invocations.attachRun(thread.id, identity.invocationId, run)
          this.emitThreadSnapshot(thread.sessionGroupId, options.emit)
        },
        emitStatus: (message) => {
          options.emit({
            type: "status",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              message: `${thread.alias}：${message}`,
            },
          })
        },
        onIterationContent: (accumulated) => {
          if (!promptRequestedByCli) {
            this.sessions.overwriteMessage(assistant.id, {
              content: accumulated || "[empty response]",
              thinking: thinkingAcc.current,
              toolEvents: toolEventsJson,
            })
          }
        },
      })
      // P1-3（德彪 r1）：let —— 派发协议 retry 成功后整体换成最终生效的 RunTurnResult，
      // 下游 seal 事件/settlement/updateThread/token 落库全部消费 retry 后的真实状态。
      let result = loopResult.lastResult
      // F026 P3.1: 派发协议 retry 路径会用 retry 后的 content 覆盖原 accumulatedContent
      let accumulatedContent = loopResult.accumulatedContent

      // F026 P3.1 · 派发协议 retry 兜底层（gate + retry + 兜底）
      // 在 markFinalEmitted（lockout）+ enqueuePublicMentions（派发）之前评估，
      // 命中即拒收当前 final，给 LLM 一次/两次重写机会；耗尽则 final 兜底入库
      // 并跳过 enqueuePublicMentions（派发未触发，前端贴红条提示手动 @）。
      let dispatchRetryExhausted = false
      let dispatchRetryFinalRetryCount = 0
      const dispatchRetryReasons: import("@multi-agent/shared").DispatchValidationRetryReason[] = []
      if (!promptRequestedByCli && accumulatedContent.trim()) {
        const maxAttempts = resolveMaxDispatchRetries(process.env)
        let attemptIndex = 1
        let workingContent = accumulatedContent
        // 仅 claude provider 走 retry spawn（resume 路径）；codex/gemini fail-closed 一次即兜底
        const supportsRetry = thread.provider === "claude"
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const decision = decideRetryAction({
            content: workingContent,
            aliases: PROVIDER_ALIASES,
            attemptIndex,
            priorReasons: dispatchRetryReasons,
            maxAttempts,
          })
          if (decision.action === "accept") {
            dispatchRetryFinalRetryCount = decision.retryCount
            // dispatchRetryReasons 已是 priorReasons 的拷贝，保留
            accumulatedContent = workingContent
            // F026 P3.1 · AC-21: 之前发过至少一次 retrying（即 retryCount>0）→ 发 settled 收尾
            // 让前端进度卡按 store 协议主动清；不再依赖 message.created 兜底（早于此 emit）。
            if (decision.retryCount > 0) {
              const settledPayload = {
                sessionGroupId: thread.sessionGroupId,
                threadId: thread.id,
                invocationId: identity.invocationId,
                agentId: thread.alias,
                messageId: assistant.id,
                attemptIndex,
                maxAttempts,
                reason: decision.retryReasons.at(-1) ?? ("nested_call_tag" as const),
                originalText: workingContent.slice(0, 200),
                status: "settled" as const,
                occurredAt: new Date().toISOString(),
                // F026 P4 follow-up · retry-badge-realtime fix:
                // 把终值带给前端，让 thread store 同步 message.retryCount/retryReasons,
                // badge 不必等刷新走 thread_snapshot 才出现。
                retryCount: decision.retryCount,
                retryReasons: [...decision.retryReasons],
              }
              try {
                this.sessions.appendAgentEvent(
                  buildDispatchRetryAgentEventRow(settledPayload, {
                    id: buildDispatchRetryEventId({
                      invocationId: identity.invocationId,
                      attemptIndex,
                      status: "settled",
                    }),
                  }),
                )
              } catch (err) {
                this.log.warn(
                  { err, invocationId: identity.invocationId },
                  "F026-P3.1 AC-21: failed to persist dispatch_validation_retry settled event (non-fatal)",
                )
              }
              options.emit(buildDispatchRetryRealtimeEvent(settledPayload))
            }
            break
          }
          if (decision.action === "exhaust") {
            dispatchRetryExhausted = true
            dispatchRetryFinalRetryCount = decision.retryCount
            dispatchRetryReasons.length = 0
            dispatchRetryReasons.push(...decision.retryReasons)
            // emit exhausted 事件 + 持久化 + skip 派发
            const exhaustedPayload = {
              sessionGroupId: thread.sessionGroupId,
              threadId: thread.id,
              invocationId: identity.invocationId,
              agentId: thread.alias,
              messageId: assistant.id,
              attemptIndex,
              maxAttempts,
              reason: decision.reason,
              originalText: workingContent.slice(0, 200),
              status: "exhausted" as const,
              occurredAt: new Date().toISOString(),
              // F026 P4 follow-up · retry-badge-realtime fix（同 settled 分支同因）
              retryCount: decision.retryCount,
              retryReasons: [...decision.retryReasons],
            }
            try {
              this.sessions.appendAgentEvent(
                buildDispatchRetryAgentEventRow(exhaustedPayload, {
                  id: buildDispatchRetryEventId({
                    invocationId: identity.invocationId,
                    attemptIndex,
                    status: "exhausted",
                  }),
                }),
              )
            } catch (err) {
              this.log.warn(
                { err, invocationId: identity.invocationId },
                "F026-P3.1: failed to persist dispatch_validation_retry exhausted event (non-fatal)",
              )
            }
            options.emit(buildDispatchRetryRealtimeEvent(exhaustedPayload))
            accumulatedContent = workingContent
            break
          }
          // decision.action === "retry"
          dispatchRetryReasons.push(decision.reason)
          // emit retrying 事件
          const retryingPayload = {
            sessionGroupId: thread.sessionGroupId,
            threadId: thread.id,
            invocationId: identity.invocationId,
            agentId: thread.alias,
            messageId: assistant.id,
            attemptIndex,
            maxAttempts,
            reason: decision.reason,
            originalText: workingContent.slice(0, 200),
            status: "retrying" as const,
            occurredAt: new Date().toISOString(),
          }
          try {
            this.sessions.appendAgentEvent(
              buildDispatchRetryAgentEventRow(retryingPayload, {
                id: buildDispatchRetryEventId({
                  invocationId: identity.invocationId,
                  attemptIndex,
                  status: "retrying",
                }),
              }),
            )
          } catch (err) {
            this.log.warn(
              { err, invocationId: identity.invocationId },
              "F026-P3.1: failed to persist dispatch_validation_retry retrying event (non-fatal)",
            )
          }
          options.emit(buildDispatchRetryRealtimeEvent(retryingPayload))

          if (!supportsRetry) {
            // 非 claude provider：不支持 retry spawn，直接 exhaust 兜底
            dispatchRetryExhausted = true
            dispatchRetryFinalRetryCount = maxAttempts
            const nonClaudeExhaustedPayload = {
              sessionGroupId: thread.sessionGroupId,
              threadId: thread.id,
              invocationId: identity.invocationId,
              agentId: thread.alias,
              messageId: assistant.id,
              attemptIndex,
              maxAttempts,
              reason: decision.reason,
              originalText: workingContent.slice(0, 200),
              status: "exhausted" as const,
              occurredAt: new Date().toISOString(),
              // F026 P3.1 review#2 fix: retrying 已让前端 resetAssistantStream 清空气泡，
              // 非 Claude 兜底路径没有后续 delta，必须把完整兜底内容带上让前端回填。
              finalContent: workingContent,
              // F026 P4 follow-up · retry-badge-realtime fix:
              // 非 Claude 兜底退到 maxAttempts；reasons 用累积的 dispatchRetryReasons
              // (此次 decision.reason 已 push 进去，line 1449)。
              retryCount: maxAttempts,
              retryReasons: [...dispatchRetryReasons],
            }
            try {
              this.sessions.appendAgentEvent(
                buildDispatchRetryAgentEventRow(nonClaudeExhaustedPayload, {
                  id: buildDispatchRetryEventId({
                    invocationId: identity.invocationId,
                    attemptIndex,
                    status: "exhausted",
                  }),
                }),
              )
            } catch (err) {
              this.log.warn(
                { err, invocationId: identity.invocationId },
                "F026-P3.1: failed to persist non-Claude dispatch_validation_retry exhausted event (non-fatal)",
              )
            }
            options.emit(buildDispatchRetryRealtimeEvent(nonClaudeExhaustedPayload))
            accumulatedContent = workingContent
            break
          }

          // 实际 spawn retry：复用 createRun 闭包，传 correctionPrompt 替代 user message
          // 注意：contentAcc 闭包被 retry 流写入；retry 前清空避免与 bad content 拼接。
          // F031 · set("") 同时把 offset 基准归零 —— 与客户端 resetAssistantStream 清零对齐
          contentAcc.set("")
          const correctionPrompt = buildCorrectionPrompt({
            reason: decision.reason,
            originalText: workingContent,
            attemptIndex: decision.nextAttemptIndex,
            maxAttempts,
          })
          let retryResult: import("../runtime/cli-orchestrator").RunTurnResult
          try {
            const retryHandle = createRun(correctionPrompt, liveSessionId ?? result.nativeSessionId)
            retryResult = await retryHandle.promise
          } catch (err) {
            this.log.warn(
              { err, invocationId: identity.invocationId },
              "F026-P3.1: dispatch retry spawn failed → exhaust 兜底",
            )
            dispatchRetryExhausted = true
            dispatchRetryFinalRetryCount = attemptIndex
            accumulatedContent = workingContent
            // F026 P3.1 · AC-21: spawn 失败兜底也必须 emit exhausted，否则进度卡卡死
            const spawnFailedExhaustedPayload = {
              sessionGroupId: thread.sessionGroupId,
              threadId: thread.id,
              invocationId: identity.invocationId,
              agentId: thread.alias,
              messageId: assistant.id,
              attemptIndex,
              maxAttempts,
              reason: decision.reason,
              originalText: workingContent.slice(0, 200),
              status: "exhausted" as const,
              occurredAt: new Date().toISOString(),
              // F026 P3.1 review#2 fix: spawn 失败兜底同样无后续 delta，
              // 必须带完整 workingContent 让前端 restoreAssistantContent 回填气泡。
              finalContent: workingContent,
              // F026 P4 follow-up · retry-badge-realtime fix:
              // spawn 失败止于第 attemptIndex 次（含本次 retrying 的 reason，已在 1449 push）。
              retryCount: attemptIndex,
              retryReasons: [...dispatchRetryReasons],
            }
            try {
              this.sessions.appendAgentEvent(
                buildDispatchRetryAgentEventRow(spawnFailedExhaustedPayload, {
                  id: buildDispatchRetryEventId({
                    invocationId: identity.invocationId,
                    attemptIndex,
                    status: "exhausted",
                  }),
                }),
              )
            } catch (persistErr) {
              this.log.warn(
                { err: persistErr, invocationId: identity.invocationId },
                "F026-P3.1 AC-21: failed to persist spawn-failed exhausted event (non-fatal)",
              )
            }
            options.emit(buildDispatchRetryRealtimeEvent(spawnFailedExhaustedPayload))
            break
          }
          workingContent = retryResult.content
          if (retryResult.nativeSessionId) {
            liveSessionId = retryResult.nativeSessionId
          }
          // P1-3（德彪 r1）：retry 产生了新的完整 RunTurnResult。足迹/seal/session 取
          // 本次尝试（当前上下文真实状态——旧代码丢弃 retry 的 sealDecision，retry 把
          // 上下文推过阈值时漏封存）；turnTotals 计费聚合所有实际尝试（失败尝试的
          // token 真实花掉了）。逐次折叠，多轮 retry 语义同样成立。
          result = resolveEffectiveTurnResult(result, [retryResult])
          attemptIndex = decision.nextAttemptIndex
        }

        // 持久化 retry_count + retry_reasons 到 messages 行
        if (dispatchRetryFinalRetryCount > 0 || dispatchRetryReasons.length > 0) {
          this.sessions.overwriteMessage(assistant.id, {
            content: accumulatedContent,
            retryCount: dispatchRetryFinalRetryCount,
            retryReasons: JSON.stringify(dispatchRetryReasons),
          })
        }
      }

      // F018 P5 AC6.2: fire-and-forget embedding generation for this assistant
      // message. Placed after retry gate so the embedding indexes the final
      // (possibly rewritten) content, not the pre-retry version.
      if (this.embeddingService && accumulatedContent.trim().length > 0) {
        this.embeddingService
          .generateAndStore(assistant.id, thread.id, accumulatedContent)
          .catch((err) => {
            this.log.warn(
              { err, threadId: thread.id, messageId: assistant.id },
              "F018 embedding generation failed (non-fatal)",
            )
          })
      }

      // F026 P1 Wiring · T5 post-final lockout. accumulatedContent has been
      // persisted onto the assistant message above; mark the invocation as
      // final-emitted so any subsequent MCP `post_message` from the same
      // invocation is hard-rejected by callbacks.ts (R-205 + R-048 双发根因).
      // The flag must be set before releaseInvocation, because revoke clears
      // the identity entry — but invocation is still authenticatable on the
      // wire until that release completes.
      this.invocations.markFinalEmitted(identity.invocationId)

      this.invocations.detachRun(thread.id)
      // F026 P1 Wiring · normal turn completion. Settle done before releasing so
      // pendingOf() reflects the final state by the time return-path fires.
      // CLI exit code !== 0 still settles `done` here — failure classification
      // happens downstream and doesn't (yet) flow back into call-registry status.
      this.a2aLifecycle?.settleDone(options.dispatchedCallId)
      this.releaseInvocation(identity.invocationId, dispatchCleanupTimer)
      // F004: only clear the native session when the CLI actually failed (exitCode !== 0).
      // Pre-F004 any empty response with an unchanged session id nuked the session —
      // which meant a normal-exit empty turn (e.g. CLI printed nothing but didn't crash)
      // would wipe history. Direct-turn now injects history from SQLite, so we only
      // clear on genuinely abnormal exits.
      //
      // B017: the id-equality sub-condition that used to live here (result ===
      // thread) silently trapped us whenever Claude's error envelope minted a
      // fresh junk session id — ids differed, clear was skipped, junk persisted,
      // next --resume repeated the failure forever. Fix: extract to a pure helper
      // that decides on exit-code + content alone. See session-effectiveness.ts.
      let effectiveSessionId = computeEffectiveSessionId({
        content: accumulatedContent,
        resultExitCode: result.exitCode,
        resultSessionId: result.nativeSessionId,
        threadSessionId: thread.nativeSessionId,
      })
      // F018 P4 Round 3 (Codex HIGH #2): capture the session id that's being SEALED
      // before any downstream code nulls effectiveSessionId. The seal hook below needs
      // this to run flush/readDigest/appendSession/incrementSessionChainIndex.
      // Otherwise auto-seal clears effectiveSessionId first → seal hook sees null →
      // entire flush pipeline is a no-op.
      let sealedSessionId: string | null = null

      // F018 P4 Round 3 (Codex HIGH #1): turn-completion backfill for pendingToolEvents.
      // onSession may never fire if the CLI crashes before emitting a session_id line.
      // In that case liveSessionId AND effectiveSessionId are both null. Fall back to
      // identity.invocationId as a synthetic sessionId so events are still persisted —
      // readLatestDigest picks the freshest by mtime regardless of key shape.
      // Also flush this orphan session immediately since no seal branch will fire for it
      // (the CLI already exited).
      if (pendingToolEvents.length > 0) {
        const orphanFallback = !liveSessionId && !effectiveSessionId
        const finalSessionId = liveSessionId ?? effectiveSessionId ?? identity.invocationId
        if (this.transcriptWriter) {
          for (const buffered of pendingToolEvents) {
            this.transcriptWriter.recordEvent({
              sessionId: finalSessionId,
              threadId: thread.id,
              event: buffered.event,
              at: buffered.at,
              invocationId: identity.invocationId,
            })
          }
          // Orphan case: no seal branch will fire, flush the synthetic session now so
          // the events are durable. Mark orphan=true in the digest so readLatestDigest
          // skips it when building the next turn's [Previous Session Summary]
          // (Codex Round 4 HIGH #2: orphan digests must not pollute Bootstrap history).
          if (orphanFallback) {
            this.transcriptWriter.flush(finalSessionId, { orphan: true }).catch((err) => {
              this.log.warn(
                { err, threadId: thread.id },
                "F018: orphan pending-events flush failed (non-fatal)",
              )
            })
          }
        }
        pendingToolEvents.length = 0
      }

      // Reactive self-heal: the CLI may exit 0 while its stderr tells the real story
      // (e.g. Gemini gives up after 10 retries and prints the 429 reason, Claude exits
      // on an unrecoverable `--resume` failure). Classify the exit so we reset only the
      // state that's actually broken, and so the user gets a targeted hint instead of
      // a silent "[empty response]".
      const turnLooksFailed =
        (result.exitCode !== null && result.exitCode !== 0) ||
        (!accumulatedContent.trim() && !promptRequestedByCli)
      if (turnLooksFailed) {
        const classification = classifyFailure(result.rawStderr, "")
        if (classification.shouldClearSession) {
          effectiveSessionId = null
        }
        options.emit({
          type: "status",
          payload: {
            sessionGroupId: thread.sessionGroupId,
            message: `${thread.alias}：${classification.userMessage}`,
          },
        })
      }

      // Preventive session seal: when the CLI's context window is close to full we drop
      // native_session_id so the next turn starts a fresh session. Prevents Gemini from
      // retrying into its 429 MODEL_CAPACITY_EXHAUSTED spiral and protects Codex/Claude
      // from silent context exhaustion. `warn` is informational only — surface to the user
      // but keep the session going.
      if (result.sealDecision) {
        const pct = Math.round(result.sealDecision.fillRatio * 100)
        if (result.sealDecision.shouldSeal) {
          // F018 P4 Round 4 (Codex MEDIUM): capture from result.nativeSessionId
          // instead of effectiveSessionId — classification.shouldClearSession above
          // may have already nulled effectiveSessionId on a failed+sealed turn.
          // result.nativeSessionId is immutable (from runTurn result), so we get
          // the real sealed id regardless of intermediate mutations.
          sealedSessionId = result.nativeSessionId
          effectiveSessionId = null
          const sealMessage = `${thread.alias} 上下文已用 ${pct}%，自动封存，下一轮开新 session。`
          options.emit({
            type: "status",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              message: sealMessage,
            },
          })
          // F021 Phase 6 (AC-32): 持久化系统通知到 thread 消息流，让 seal 在历史
          // 时间轴里有显眼锚点；status 一行短促易错过，但消息流不会丢。
          const sealNotice = this.sessions.appendSystemNoticeMessage(thread.id, sealMessage)
          const sealTimeline = this.sessions.toTimelineMessage(thread.id, sealNotice.id)
          if (sealTimeline) {
            options.emit({
              type: "message.created",
              payload: {
                threadId: thread.id,
                sessionGroupId: thread.sessionGroupId,
                message: sealTimeline,
              },
            })
          }
        } else if (result.sealDecision.reason === "warn") {
          options.emit({
            type: "status",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              message: `${thread.alias} 上下文已用 ${pct}%，接近上限，准备换房间。`,
            },
          })
        }
      }

      // F043 AC4：fill / F-BLOAT 基线记账提取为 settleTurnUsage（同位替换）。
      // 封存轮 → lastFillRatio=null（复位，不许 95% 挂新 session）+ 基线清零（防新
      // session 首轮误报 CLI 自压缩）；非封存轮行为与提取前 1:1。
      const usageSettlement = settleTurnUsage({
        threadId: thread.id,
        alias: thread.alias,
        sessionGroupId: thread.sessionGroupId,
        usage: result.usage,
        sealDecision: result.sealDecision,
        prevUsedTokens: this.prevUsedTokens,
        emit: (event) => options.emit(event),
        invalidateSummary: () => this.memoryService?.invalidateSummary(thread.sessionGroupId),
      })
      if (usageSettlement.fBloatDetected) {
        result.fBloatDetected = true
      }

      if (stderrLineBuf.trim()) {
        const remainder = filterStderrNoise(stderrLineBuf)
        if (remainder.trim()) {
          // 收尾 remainder 只入库不 emit delta —— push 仅为保持累计器一致，offset 不外发
          thinkingAcc.push(remainder)
        }
        stderrLineBuf = ""
      }

      this.streamingFlushers.delete(flushKey)
      this.sessions.updateThread(
        thread.id,
        result.currentModel,
        effectiveSessionId,
        undefined,
        usageSettlement.lastFillRatio,
        usageSettlement.threadUsage,
      )
      if (!promptRequestedByCli) {
        // F026 P11 · 派生 content_blocks（thinking + text）merge 现存独立块（image）
        const existingBlocksJson = this.sessions.getContentBlocksJson(assistant.id)
        const derivedBlocks = deriveContentBlocks({
          content: accumulatedContent || "",
          thinking: thinkingAcc.current,
        })
        const mergedBlocks = mergeDerivedWithExistingBlocks(existingBlocksJson, derivedBlocks)
        // F043 AC5 · turn 聚合 token 明细随 assistant 消息落库：claude 用 turnTotals
        // （result 整轮计费），codex 用 usage.detail（rollout 末请求足迹），gemini 无 → 不写
        const tokenDetail = result.turnTotals?.detail ?? result.usage?.detail ?? null
        this.sessions.overwriteMessage(assistant.id, {
          content: accumulatedContent || "[empty response]",
          thinking: thinkingAcc.current,
          toolEvents: toolEventsJson,
          contentBlocks: JSON.stringify(mergedBlocks),
          ...(tokenDetail
            ? {
                inputTokens: tokenDetail.inputTokens,
                outputTokens: tokenDetail.outputTokens,
                cacheReadTokens: tokenDetail.cacheReadTokens,
                cacheCreationTokens: tokenDetail.cacheCreationTokens,
              }
            : {}),
        })
        // P1-1（德彪 r1）· AC6 活页闭环：占位 message.created 无 token，收尾终稿原来
        // 只写 DB —— catch-up 只查 created_at > since 漏更新行、store 按 id 去重不替换，
        // 开着的页面刷新前永远看不到胶囊。这里把落库终稿全量重推，前端按 id upsert。
        const finalTimeline = this.sessions.toTimelineMessage(thread.id, assistant.id)
        if (finalTimeline) {
          options.emit({
            type: "message.updated",
            payload: {
              threadId: thread.id,
              sessionGroupId: thread.sessionGroupId,
              message: finalTimeline,
            },
          })
        }
      }

      // F042 AC2 · 采纳判定回写（终稿落库后补判；fail-soft 不阻塞 turn）。
      // shadow 期语义 = 相关性代理信号（回复独立提到召回条目 → 召回找得准），非严格采纳证明。
      // shadow 异步化后为交汇形态：hits 已到 → 此处判；hits 未到（慢召回）→ 召回回调侧补判。
      // 德彪 r1 P2-5：失败/取消/空异常回复不设 replyText → 交汇两侧都不会判，
      // recall_adopted 保持 NULL（未判定）——失败 turn 不得成为负标注污染采纳率。
      if (!promptRequestedByCli && directAuditRowId !== null && !turnLooksFailed) {
        directReplyText = accumulatedContent || ""
        tryJudgeDirectAdoption()
      }

      // F042 AC2 · 影子观察窗主动提示（两时机一次性；D3 每 direct turn 顺手查，不新造 cron）。
      // 两阶段：check 出候选 → 发卡成功才 markSent（发失败不烧一次性标志，下 turn 重试）。
      if (!promptRequestedByCli && directAuditRowId !== null && this.shadowWindowNotifier) {
        try {
          const candidate = this.shadowWindowNotifier.check()
          if (candidate) {
            const notice = this.sessions.appendSystemNoticeMessage(thread.id, candidate.content)
            const noticeTimeline = this.sessions.toTimelineMessage(thread.id, notice.id)
            if (noticeTimeline) {
              options.emit({
                type: "message.created",
                payload: {
                  threadId: thread.id,
                  sessionGroupId: thread.sessionGroupId,
                  message: noticeTimeline,
                },
              })
            }
            this.shadowWindowNotifier.markSent(candidate.kind)
          }
        } catch (err) {
          this.log.warn(
            { stage: "shadow_window_notify", err: (err as Error).message },
            "shadow window notify failed (non-blocking, will retry next turn)",
          )
        }
      }

      // F002: route [拍板] / [撤销拍板] markers into the Decision Board
      // instead of emitting decision.request directly. SettlementDetector
      // will flush the board once the discussion settles.
      if (!promptRequestedByCli && accumulatedContent.trim()) {
        this.collectDecisionsIntoBoard(thread, assistant.id, accumulatedContent, options.emit)
      }

      this.events.emit({
        type: "invocation.finished",
        invocationId: identity.invocationId,
        threadId: thread.id,
        agentId: thread.alias,
        status: "idle",
        exitCode: result.exitCode,
        // F040 D16：终稿 id + call tree root，供渠道出站账本 key 与 D15 溯源
        assistantMessageId: assistant.id,
        rootMessageId: options.rootMessageId,
        createdAt: new Date().toISOString(),
      })

      let enqueueResultForWorklist: EnqueueMentionsResult | null = null
      // F026 P3.1: dispatchRetryExhausted=true → 派发协议反复写错，已提示用户手动 @
      // 这里 skip 全部 enqueuePublicMentions，避免 stale [Call:] 字面量被错派
      if (
        !promptRequestedByCli &&
        accumulatedContent.trim() &&
        !options.suppressOutboundDispatch &&
        !dispatchRetryExhausted
      ) {
        const enqueueResult = this.dispatch.enqueuePublicMentions({
          messageId: assistant.id,
          sessionGroupId: thread.sessionGroupId,
          sourceProvider: thread.provider,
          sourceAlias: thread.alias,
          rootMessageId: options.rootMessageId,
          content: accumulatedContent,
          matchMode: "line-start",
          parentInvocationId: identity.invocationId,
          // F026 R-204 follow-up · final flow 在 line 1685 releaseInvocation 之后才派发,
          // invocationContexts.get(parentInvocationId) 已 delete → 反查空。直传
          // dispatchedCallId 让 gateway 接通 child a2a_calls.parent_call_id（DB 0/275 实证）。
          parentCallId: options.dispatchedCallId ?? null,
          buildSnapshot: () => this.captureSnapshot(thread.sessionGroupId, assistant.id),
          // CLI 流出 accumulatedContent（agent 完整输出回流），走 buildReturnPathPayload
          // 16k token cap + 头尾保留 + msg_id 引用，防止长 review 被砍中段 finding。
          extractSnippet: buildReturnPathExtractSnippet(assistant.id),
        })
        this.emitBlockedDispatches(enqueueResult, options.emit)
        // F026 P5 in-flight (R-104)：LLM 主链路 final flush 派发 [Call:@X] 时
        // 必须写 connector header,否则前端 ConnectorBubble / AtPill / OriginCapsule
        // 三组件无载体（R-104 timeline 4/4 final 0 connector 反证）。
        writeConnectorHeadersForQueue(this.sessions, enqueueResult, options.emit)
        enqueueResultForWorklist = enqueueResult
      }

      // F026 P2 v2 wire 顺序（关键）：必须先 registerForDispatch（child worklist 入树），
      // 再 onChildFinished（cascade settle）。否则 cascade 看不到 child active，会过早
      // settle root。
      //
      // registerForDispatch：当前 turn reply 含 outbound [Call:@X] 时，把派发的 children
      // 写到 a2a_worklists 树（parentWorklistId 反查 grandparent worklist）。enqueue 没
      // 走 / queued 空 → noop。
      if (enqueueResultForWorklist && enqueueResultForWorklist.queued.length > 0) {
        this.worklistExecutor?.registerForDispatch({
          parentCallId: options.dispatchedCallId ?? null,
          sessionGroupId: thread.sessionGroupId,
          queued: enqueueResultForWorklist.queued,
        })
      }

      // onChildFinished：本 invocation 是某个 worklist 的 child item 完成。markItemStatus →
      // tryCascadeSettle bottom-up；若 root settle 命中则触发 onDoneContinuation 回调
      // (本服务 dispatchWorklistContinuation)。dispatchedCallId 缺省 / executor 不 wire
      // / 找不到对应 worklist → 全 noop。
      this.worklistExecutor?.onChildFinished({
        childCallId: options.dispatchedCallId ?? null,
        childAlias: thread.alias,
        childContent: accumulatedContent,
        ok: result.exitCode === 0 && !dispatchRetryExhausted,
        continuationContext: {
          emit: options.emit,
          rootMessageId: options.rootMessageId,
        },
      })

      // SOP advancement: if a skill was active, advance to next stage
      // (and force-dispatch to the next target when nextDispatch is defined).
      this.advanceSopIfNeeded({
        sessionGroupId: thread.sessionGroupId,
        userContent: options.content,
        llmContent: accumulatedContent,
        sourceThread: {
          id: thread.id,
          provider: thread.provider,
          alias: thread.alias,
        },
        assistantMessageId: assistant.id,
        rootMessageId: options.rootMessageId,
        parentInvocationId: identity.invocationId,
        // F026 R-204 follow-up · 同 final flow,SOP 合成派发也在 release 之后,
        // 直传 dispatchedCallId 让 SOP 自动交接生成的 child a2a_calls 接通 call tree。
        dispatchedCallId: options.dispatchedCallId ?? null,
        emit: options.emit,
      })

      // Extract SOP bookmark AFTER advanceSopIfNeeded so it reflects the latest stage
      const sopStage = this.sopTracker?.getStage(thread.sessionGroupId) ?? null
      const bookmark = extractSOPBookmark(accumulatedContent, sopStage)
      const bookmarkJson = bookmark.skill ? JSON.stringify(bookmark) : null
      if (bookmarkJson) {
        this.sessions.updateThread(
          thread.id,
          result.currentModel,
          effectiveSessionId,
          bookmarkJson,
          usageSettlement.lastFillRatio,
          usageSettlement.threadUsage,
        )
      }

      this.emitThreadSnapshot(thread.sessionGroupId, options.emit)
      await this.flushDispatchQueue(thread.sessionGroupId, options.emit)
      this.settlementDetector?.clearContinuationInFlight(
        thread.sessionGroupId,
        identity.invocationId,
      )
      this.settlementDetector?.notifyStateChange(thread.sessionGroupId)

      // F018 P4 Round 4 (Codex HIGH #1): seal 持久化 与 SOP bookmark 解耦。
      // 非 SOP 线程也会 auto-seal — 原来 bookmarkJson guard 让这些场景完全
      // 没有 digest 持久化、ThreadMemory 不滚动、sessionChainIndex 不递增。
      // 现改为"真 seal 就持久化，bookmark 只 gate auto-resume"。
      const sessionForSeal = sealedSessionId ?? effectiveSessionId
      // 修2（德彪 r2）：loopResult.stoppedReason 定格在 retry 前，retry 越阈时钩子被跳过
      // 而 seal 事件/session 清空照发（脑裂）。统一吃最终生效结果（非 retry 路径 1:1）。
      if (sealedThisTurn(result) && this.transcriptWriter && sessionForSeal) {
        try {
          await this.transcriptWriter.flush(sessionForSeal)
          const digest = await this.transcriptWriter.readDigest(sessionForSeal, thread.id)
          if (digest) {
            const { appendSession } = await import("./thread-memory")
            const existing = this.sessions.getThreadMemory(thread.id)
            // F021 Phase 6: ThreadMemory cap 走三层取值（CLI 报告这里没有，传 null）
            const contextWindow =
              resolveContextWindow(
                thread.provider,
                globalConfig,
                sessionSnapshot,
                null,
                thread.currentModel,
              ) ?? 200_000
            const updated = appendSession(existing, digest, contextWindow)
            this.sessions.setThreadMemory(thread.id, updated)
          }
          this.sessions.incrementSessionChainIndex(thread.id)
        } catch (err) {
          this.log.warn({ err, threadId: thread.id }, "F018 seal hook failed (non-fatal)")
        }
      }

      if (sealedThisTurn(result) && bookmarkJson) {
        const parsedBookmark: SOPBookmark = JSON.parse(bookmarkJson)
        const resumeCount = options.autoResumeCount ?? 0
        // B015: 传入 seal 那轮的 stopReason，"complete" (Claude end_turn) 时短路，
        // 避免把已完整回答的问题当 pending 续接导致重答
        if (shouldAutoResume(parsedBookmark, resumeCount, MAX_AUTO_RESUMES, 0, result.stopReason)) {
          // F018 P4 AC7.2: resume 消息走 Bootstrap 风格（reference-only + ThreadMemory 段）
          const threadMemory = this.sessions.getThreadMemory(thread.id)
          const resumeMsg = buildAutoResumeMessage(
            parsedBookmark,
            resumeCount + 1,
            MAX_AUTO_RESUMES,
            threadMemory,
          )
          options.emit({
            type: "status",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              message: `记忆重组中，自动续接 (${resumeCount + 1}/${MAX_AUTO_RESUMES})`,
            },
          })
          const resumeResult = await this.runThreadTurn({
            threadId: thread.id,
            content: resumeMsg,
            emit: options.emit,
            rootMessageId: options.rootMessageId,
            autoResumeCount: resumeCount + 1,
            // r2 范-r1 P2: auto-resume 续接（记忆重组）显式 scenario = wake_up
            scenario: "wake_up",
          })
          if (resumeResult) {
            return {
              messageId: resumeResult.messageId,
              content: accumulatedContent + resumeResult.content,
            }
          }
        }
      }

      return { messageId: assistant.id, content: accumulatedContent || "" }
    } catch (error) {
      this.log.error({ err: error, threadId: thread.id, agentId: thread.alias }, "turn failed")
      this.streamingFlushers.delete(flushKey)
      this.invocations.detachRun(thread.id)
      // F026 P1 Wiring · turn threw. Settle failed before release so the
      // call-registry row is in a terminal state for any waiting parent.
      this.a2aLifecycle?.settleFailed(options.dispatchedCallId)
      // F026 P2 v2 review#2 (范德彪 P1): catch 路径只 settle call 不 settle worklist —
      // child call 标 failed 但 worklist item 仍 pending → cascade 看到 pending 永远不 drain
      // → root worklist 死锁，续推不触发。这里调 onChildFinished({ ok: false }) 走 halt 路径
      // (worklist-executor: failed 直接 settle 自身，不 cascade，不续推) 让父链不悬空。
      this.worklistExecutor?.onChildFinished({
        childCallId: options.dispatchedCallId ?? null,
        childAlias: thread.alias,
        childContent: "",
        ok: false,
        continuationContext: {
          emit: options.emit,
          rootMessageId: options.rootMessageId,
        },
      })
      this.releaseInvocation(identity.invocationId, dispatchCleanupTimer)
      const message = error instanceof Error ? error.message : "Unknown error"
      // B023 AC1: catch 路径 append 不 overwrite — 保留流式累积的 assistantContent，
      // 末尾追加 [runtime] 错误信息。修复前直接覆盖导致前端看到内容瞬间消失。
      const composedContent = composeFinalContentOnError({
        assistantContent: contentAcc.current || "",
        errorMessage: message,
      })
      // F026 P11 · 错误终态也派生 content_blocks（保 thinking + error text 结构）
      const existingErrorBlocksJson = this.sessions.getContentBlocksJson(assistant.id)
      const derivedErrorBlocks = deriveContentBlocks({
        content: composedContent,
        thinking: thinkingAcc.current,
      })
      const mergedErrorBlocks = mergeDerivedWithExistingBlocks(
        existingErrorBlocksJson,
        derivedErrorBlocks,
      )
      this.sessions.overwriteMessage(assistant.id, {
        content: composedContent,
        thinking: thinkingAcc.current,
        toolEvents: toolEventsJson,
        contentBlocks: JSON.stringify(mergedErrorBlocks),
      })
      // B026 德彪 r1 P2-2 · 错误终态也广播 message.updated：spawn 前失败时 running
      // 从未 true、无下降沿，snapshot delta 又只 append 不 replace——前端占位气泡的
      // 等待骨架只能靠本事件按消息 ID 精确收口（同时把错误终稿上屏，免得刷新才可见）。
      const errorTimeline = this.sessions.toTimelineMessage(thread.id, assistant.id)
      if (errorTimeline) {
        options.emit({
          type: "message.updated",
          payload: {
            threadId: thread.id,
            sessionGroupId: thread.sessionGroupId,
            message: errorTimeline,
          },
        })
      }
      // Reactive self-heal: match the error message against known failure signatures so
      // we clear session only when doing so actually helps, and give the user a concrete
      // hint (wait/retry/re-auth) instead of just dumping the raw exception.
      const classification = classifyFailure("", message)
      if (classification.shouldClearSession) {
        this.sessions.updateThread(thread.id, thread.currentModel, null)
      }

      this.events.emit({
        type: "invocation.failed",
        invocationId: identity.invocationId,
        threadId: thread.id,
        agentId: thread.alias,
        status: "error",
        error: message,
        exitCode: null,
        // F040 D16：错误终态也带终稿+root，供渠道回执溯源投递
        assistantMessageId: assistant.id,
        rootMessageId: options.rootMessageId,
        createdAt: new Date().toISOString(),
      })

      options.emit({
        type: "status",
        payload: {
          sessionGroupId: thread.sessionGroupId,
          message: `${thread.alias}：${classification.userMessage}`,
        },
      })
      this.emitThreadSnapshot(thread.sessionGroupId, options.emit)
      await this.flushDispatchQueue(thread.sessionGroupId, options.emit)
      this.settlementDetector?.clearContinuationInFlight(
        thread.sessionGroupId,
        identity.invocationId,
      )
      this.settlementDetector?.notifyStateChange(thread.sessionGroupId)
      return null
    }
  }

  private async flushDispatchQueue(sessionGroupId: string, emit: EmitEvent) {
    if (this.flushingGroups.has(sessionGroupId)) {
      return
    }

    this.log.info({ sessionGroupId }, "flushing dispatch queue")
    this.flushingGroups.add(sessionGroupId)

    try {
      // Outer loop: keep draining until queue is empty AND no slots are running.
      // Inner loop: dispatch all currently-available entries in parallel.
      // After all parallel turns settle, loop again to pick up newly enqueued items.
      while (true) {
        const batch: Array<{ entry: QueueEntry; threadId: string }> = []

        while (true) {
          // F026 P0 silent-drop fix: isProviderBusy 让 dispatch 在 take 阶段就跳过
          // "thread 已有 active invocation" 的 provider —— 否则 entry 会被 take 出来后
          // 在 runThreadTurn (message-service.ts:817) 因 invocations.has === true 被
          // silent-drop（R-013 场景5：黄仁勋自己的 directTurn 还没结束，子调用回程
          // 派发到黄仁勋时 entry 永远丢失）。
          const next = this.dispatch.takeNextQueuedDispatch(sessionGroupId, {
            isProviderBusy: (provider) => {
              const t = this.sessions.findThreadByGroupAndProvider(sessionGroupId, provider)
              return !!t && this.invocations.has(t.id)
            },
          })
          if (!next) break

          const targetThread = this.sessions.findThreadByGroupAndProvider(
            sessionGroupId,
            next.to.provider,
          )
          if (!targetThread) continue

          if (!this.dispatch.acquireSlot(sessionGroupId, next.to.provider)) continue

          batch.push({ entry: next, threadId: targetThread.id })
        }

        if (!batch.length) break

        await Promise.allSettled(
          batch.map(async ({ entry, threadId }) => {
            try {
              const a2aProvider = entry.to.provider as import("@multi-agent/shared").Provider

              // F019 P4: keyword-injection layer removed. Guardian mode
              // detection now queries skillRegistry directly for acceptance-
              // guardian / vision-guardian — without going through the
              // (deleted) buildSkillHintLine string.
              const guardianCandidateNames = !this.skillRegistry
                ? []
                : this.skillRegistry.match(entry.taskSnippet, a2aProvider).map((m) => m.skill.name)
              const isGuardianMode =
                guardianCandidateNames.includes("acceptance-guardian") ||
                guardianCandidateNames.includes("vision-guardian")

              const targetThread = this.dispatch.resolveThread(threadId)
              const a2aBookmark = targetThread?.sopBookmark
                ? (() => {
                    try {
                      return JSON.parse(targetThread.sopBookmark)
                    } catch {
                      return null
                    }
                  })()
                : null
              // F018 P4 AC3.5 wiring: A2A path also feeds SessionBootstrap metadata
              // so Bootstrap prelude fires on new-session A2A invocations.
              // F018 P4 (Codex HIGH #2): previousDigest from latest sealed session
              const a2aPreviousDigest =
                !isGuardianMode && this.transcriptWriter
                  ? await this.transcriptWriter.readLatestDigest(threadId).catch(() => null)
                  : null
              const a2aThreadMemory = isGuardianMode
                ? null
                : this.sessions.getThreadMemory(threadId)
              // F026-P3 Task7 · A2A 路径 cold-target burst 兜底（guardian 模式跳过：guardian
              // 走零上下文，注入 burst 反而违反 guardian 契约）
              const a2aColdBurst = isGuardianMode
                ? undefined
                : tryBuildColdTargetBurst({
                    nativeSessionId: targetThread?.nativeSessionId ?? null,
                    threadMemoryEmpty: a2aThreadMemory == null,
                    previousDigestEmpty: a2aPreviousDigest == null,
                    roomSnapshot: entry.contextSnapshot,
                  })
              // F027 Phase 3 P20 Day 7-8 a · Adaptive Recall coordinator 调用点。
              //   - guardian 模式跳过（guardian = 零上下文，注入 recall 反而违反契约）
              //   - scenario='a2a_handoff'（A2A 派发路径）— Coordinator 内 scenario 白名单决策
              //   - 默认 noop coordinator (enabled=false) 直接 passthrough，行为不变
              //   - Phase 4 接 backend 后 hits 非空时填入 assemblePrompt.memoryPreflight
              const a2aScenario = "a2a_handoff" as const
              // Week 2 r2 (范-r1 P1): 解析 sessionGroupId → canonical roomId (R-###);
              // prompt-inspector 按 R-### 查 prompt_audit，sessionGroupId UUID 写进去读不到。
              // 无 R-### 绑定 (旧数据 / 测试 fixture) → null，audit row 的 room_id 写 null。
              const a2aCanonicalRoomId = this.sessions.getRoomId(sessionGroupId)
              const recallResult = isGuardianMode
                ? null
                : await this.adaptiveRecallCoordinator.executeIfNeeded({
                    // Coordinator/executor 内部用 roomId 作 Level3 query_messages room filter；
                    // 没有 canonical R-### 时用 sessionGroupId 兜底（仍能隔离 session），
                    // 但 audit 写入用真 canonical（见下文 promptAuditWriter.write）。
                    roomId: a2aCanonicalRoomId ?? sessionGroupId,
                    alias: entry.to.agentId,
                    scenario: a2aScenario,
                    trigger: deriveTriggerFromScenario(a2aScenario),
                    query: entry.taskSnippet,
                  })
              const memoryPreflightForAssemble =
                recallResult && recallResult.hits.length > 0
                  ? { hits: recallResult.hits.map(toAssemblePromptHits) }
                  : null

              // F027 P4 hotfix · A2A 路径也加载 viewfinder（V16.5 §4 line 407）。
              // guardian 模式跳过（零上下文契约不许注 viewfinder）。
              const a2aViewfinder = isGuardianMode
                ? null
                : await this.loadViewfinderSafe(a2aCanonicalRoomId)
              const assembled = await assemblePrompt(
                {
                  provider: entry.to.provider as import("@multi-agent/shared").Provider,
                  threadId,
                  sessionGroupId,
                  nativeSessionId: targetThread?.nativeSessionId ?? null,
                  policy: isGuardianMode ? POLICY_GUARDIAN : POLICY_FULL,
                  task: entry.taskSnippet,
                  roomSnapshot: entry.contextSnapshot,
                  sourceAlias: entry.from.agentId,
                  targetAlias: entry.to.agentId,
                  sopBookmark: a2aBookmark,
                  lastFillRatio: targetThread?.lastFillRatio ?? undefined,
                  guardianMode: isGuardianMode,
                  sessionChainIndex: isGuardianMode
                    ? undefined
                    : this.sessions.getSessionChainIndex(threadId),
                  threadMemory: a2aThreadMemory ?? undefined,
                  previousDigest: a2aPreviousDigest,
                  recallTools: isGuardianMode ? undefined : [],
                  coldTargetBurst: a2aColdBurst,
                  // F027 Phase 3 P20 Day 7-8 a · scenario + memoryPreflight 注入
                  scenario: isGuardianMode ? undefined : a2aScenario,
                  memoryPreflight: memoryPreflightForAssemble,
                  // F027 P4 hotfix · viewfinder 接通（Phase 3 缺接）
                  viewfinder: a2aViewfinder,
                  roomId: a2aCanonicalRoomId,
                  // F027 P4-A1 · capability_digest 注入（V16.5 §13）— receiver = entry.to.agentId
                  // guardian 模式跳过（V16.5 §13 line 1490 零上下文契约不许注 capability digest）
                  capabilityDigest: isGuardianMode
                    ? null
                    : this.getSelfCapabilityDigest(entry.to.agentId),
                  // F027 P4-A3 + fallback j2 P1 修 · handoffContext 注入（V16.5 §M1 line 422-431）。
                  // 实施位置矫正：gateway 路径下 entry.handoffContext 由 dispatch.ts 派发时 derive
                  // （a2a-gateway-bootstrap.deriveHandoffContext 走 envelope.protocol.on_behalf_of
                  // ?? convener_id + envelope.task.input.source_message / envelope.task.task）。
                  // 这一支符合 V16.5 §M1 "实施位置 dispatch.ts，调用方不手填"。
                  // gateway 关 / legacy fallback 时 entry.handoffContext=undefined → 退到 caller-side
                  // helper 走 entry.to.agentId + entry.taskSnippet 简化形态（行为同 P4-A3 修前）。
                  handoffContext: isGuardianMode
                    ? null
                    : (entry.handoffContext ??
                      this.buildA2AHandoffContext({
                        receiverAlias: entry.to.agentId,
                        taskSummary: entry.taskSnippet,
                        isGuardianMode,
                      })),
                },
                this.memoryService,
              )

              // F027 P4 hotfix · A2A audit 改走 writePromptAuditSafe helper。
              // direct turn / A2A 现统一一条路径写 prompt_audit（parts_json/iron_laws/raw_text/
              // total_tokens 全真）；V16.5 §18 line 2117 "每次拼装同步写一条" 接通。
              const a2aRecallPatch = buildRecallAuditPatch({
                output: recallResult?.output,
                trigger: recallResult ? deriveTriggerFromScenario(a2aScenario) : null,
                recallRequired: !isGuardianMode && recallResult?.executed === true,
              })
              this.writePromptAuditSafe({
                scenario: isGuardianMode ? "a2a_handoff_guardian" : a2aScenario,
                alias: entry.to.agentId,
                roomId: a2aCanonicalRoomId,
                assembled,
                sourceEventIds: [entry.rootMessageId],
                agentSessionRef: targetThread?.nativeSessionId ?? null,
                recallPatch: a2aRecallPatch,
              })

              // F026 P2 clean-cut · 多 @ 不再 fan-out 进 ParallelGroup；每个
              // entry 是独立 A2A 派发，groupId 用 entry.id 作为单元集合标识。
              const dispatchGroupId = entry.id
              const dispatchGroupRole = "member" as const

              await this.runThreadTurn({
                threadId,
                content: assembled.content,
                systemPrompt: assembled.systemPrompt,
                emit,
                rootMessageId: entry.rootMessageId,
                parentInvocationId: entry.parentInvocationId,
                groupId: dispatchGroupId,
                groupRole: dispatchGroupRole,
                // F026 P1 Wiring · forward gateway callId so the turn's
                // lifecycle hooks (advance/settle) hit the right registry row.
                dispatchedCallId: entry.callId,
                // r2 范-r1 P2: A2A 派发显式 scenario（虽然推断也对，显式更稳）
                scenario: "a2a_handoff",
              })
            } finally {
              this.dispatch.releaseSlot(sessionGroupId, entry.to.provider)
            }
          }),
        )
        // Loop again: completed turns may have enqueued new mentions
      }
    } finally {
      this.flushingGroups.delete(sessionGroupId)
    }
  }

  /**
   * F002: Route `[拍板]` / `[撤销拍板]` markers from an agent reply into
   * the Decision Board instead of emitting `decision.request` events
   * directly. SettlementDetector is notified so it can decide whether the
   * board is ready to flush. When no DecisionBoard has been attached
   * (e.g. unit tests that don't wire the full pipeline) this is a no-op —
   * the old direct-emit path is intentionally removed (AC3).
   *
   * `emit` is retained for future use (per-entry ack events) and to keep
   * the call signature forward-compatible.
   */
  collectDecisionsIntoBoard(
    thread: {
      id: string
      provider: import("@multi-agent/shared").Provider
      alias: string
      sessionGroupId: string
    },
    _messageId: string,
    content: string,
    _emit: EmitEvent,
  ): void {
    const board = this.decisionBoard
    if (!board) return

    const items = extractDecisionItems(content)
    for (const item of items) {
      const options = item.options.map((opt, i) => ({
        id: `opt_${i}`,
        label: opt,
      }))
      board.add({
        sessionGroupId: thread.sessionGroupId,
        raiser: {
          threadId: thread.id,
          provider: thread.provider,
          alias: thread.alias,
          raisedAt: new Date().toISOString(),
        },
        question: item.question,
        options,
      })
    }

    const withdrawals = extractWithdrawals(content)
    for (const substring of withdrawals) {
      board.withdraw(thread.sessionGroupId, thread.id, substring)
    }

    if (items.length > 0 || withdrawals.length > 0) {
      this.settlementDetector?.notifyStateChange(thread.sessionGroupId)
    }
  }

  emitThreadSnapshot(sessionGroupId: string, emit: EmitEvent) {
    const t0 = performance.now()
    this.flushActiveStreaming(sessionGroupId)
    const tFlush = performance.now()

    const runningThreadIds = new Set(this.invocations.keys())
    const dispatchState = {
      hasPendingDispatches: this.dispatch.hasQueuedDispatches(sessionGroupId),
      dispatchBarrierActive: this.dispatch.isSessionGroupCancelled(sessionGroupId),
    }

    if (this.sessions.isFirstSnapshot(sessionGroupId)) {
      const activeGroup = this.sessions.getActiveGroup(
        sessionGroupId,
        runningThreadIds,
        dispatchState,
      )
      const tGroup = performance.now()
      emit({
        type: "thread_snapshot",
        payload: { sessionGroupId, activeGroup },
      })
      // seed the timestamp tracker so next call goes delta
      this.sessions.getActiveGroupDelta(sessionGroupId, runningThreadIds, dispatchState)
      const total = performance.now() - t0
      console.log(
        `[perf] emitThreadSnapshot(${sessionGroupId.slice(0, 8)}): FULL flush=${(tFlush - t0).toFixed(1)}ms getActiveGroup=${(tGroup - tFlush).toFixed(1)}ms total=${total.toFixed(1)}ms`,
      )
      perfCollector.record("emitThreadSnapshot", total)
      perfCollector.record("emitThreadSnapshot.flush", tFlush - t0)
      perfCollector.record("emitThreadSnapshot.getActiveGroup", tGroup - tFlush)
    } else {
      const delta = this.sessions.getActiveGroupDelta(
        sessionGroupId,
        runningThreadIds,
        dispatchState,
      )
      const tDelta = performance.now()
      emit({ type: "thread_snapshot_delta", payload: delta })
      const total = performance.now() - t0
      console.log(
        `[perf] emitThreadSnapshot(${sessionGroupId.slice(0, 8)}): DELTA flush=${(tFlush - t0).toFixed(1)}ms getDelta=${(tDelta - tFlush).toFixed(1)}ms newMsgs=${delta.newMessages.length} total=${total.toFixed(1)}ms`,
      )
      perfCollector.record("emitThreadSnapshot.delta", total)
    }
  }

  private releaseInvocation(
    invocationId: string,
    dispatchCleanupTimer?: ReturnType<typeof globalThis.setTimeout>,
  ) {
    if (dispatchCleanupTimer) {
      clearTimeout(dispatchCleanupTimer)
    }
    this.invocations.revokeInvocation(invocationId)
    this.dispatch.releaseInvocation(invocationId)
    // Keep chainRegistry entry alive past the immediate release so that a
    // just-completed child can still resolve its parent for return-path
    // dispatch. The entry is cleaned by a short setTimeout to avoid leaking.
    const chainTtl = 2 * 60 * 1000
    globalThis.setTimeout(() => this.chainRegistry.release(invocationId), chainTtl).unref?.()
  }

  private emitBlockedDispatches(result: EnqueueMentionsResult, emit: EmitEvent) {
    if (!result.blocked.length) {
      return
    }

    emit({
      type: "dispatch.blocked",
      payload: {
        attempts: result.blocked,
      },
    })
  }

  private captureSnapshot(sessionGroupId: string, triggerMessageId: string): ContextMessage[] {
    const threads = this.sessions.listGroupThreads(sessionGroupId)
    const threadMeta = new Map(threads.map((t) => [t.id, { provider: t.provider, alias: t.alias }]))
    const allMessages = threads.flatMap((t) => {
      const msgs = this.sessions.listThreadMessages?.(t.id) ?? []
      return msgs.map(
        (m: {
          id: string
          role: string
          content: string
          toolEvents?: string
          createdAt: string
        }) => {
          const raw: {
            id: string
            threadId: string
            role: "user" | "assistant"
            content: string
            createdAt: string
            toolEventsSummary?: string
          } = {
            id: m.id,
            threadId: t.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            createdAt: m.createdAt,
          }
          if (m.toolEvents && m.toolEvents !== "[]") {
            try {
              const events = JSON.parse(m.toolEvents) as {
                toolName?: string
                status?: string
                toolInput?: string
                content?: string
              }[]
              if (events.length > 0) {
                raw.toolEventsSummary = events
                  .map((e) => {
                    const base = `${e.toolName ?? "unknown"}(${e.status ?? "?"})`
                    if (e.status === "error" && e.content) {
                      return `${base}: ${e.content.slice(0, 200)}`
                    }
                    if (e.toolInput) {
                      return `${base}: ${e.toolInput.slice(0, 100)}`
                    }
                    return base
                  })
                  .join(", ")
              }
            } catch {
              /* malformed JSON — skip */
            }
          }
          return raw
        },
      )
    })
    return [
      ...buildContextSnapshot(allMessages, threadMeta, {
        sessionGroupId,
        triggerMessageId,
        maxMessages: 40,
      }),
    ]
  }

  // F040：渠道网关 headless 注入前需查 group 是否忙（busy 时排队不注入）。
  // 从 private 放宽为 public 供 MessageInjector 缝合面消费，行为不变。
  getBusyStatus(threadId: string, sessionGroupId: string) {
    const thread = this.dispatch.resolveThread(threadId)
    if (!thread) return null

    if (this.dispatch.isSlotBusy(sessionGroupId, thread.provider)) {
      return `${thread.alias} 已经在运行中。`
    }

    return null
  }

  /**
   * Present a multi-choice decision card to the user.
   * Returns the selected option IDs.
   */
  async requestDecision(params: {
    kind: "multi_choice" | "fan_in_selector" | "inline_confirmation"
    title: string
    description?: string
    options: Array<{
      id: string
      label: string
      description?: string
      provider?: import("@multi-agent/shared").Provider
    }>
    sessionGroupId: string
    sourceProvider?: import("@multi-agent/shared").Provider
    sourceAlias?: string
    multiSelect?: boolean
    anchorMessageId?: string
  }): Promise<string[]> {
    if (!this.decisions) return []
    const response = await this.decisions.request(params)
    return response.decisions
      .filter((d) => d.verdict === "approved" || d.verdict === "modified")
      .map((d) => d.optionId)
  }

  private advanceSopIfNeeded(input: {
    sessionGroupId: string
    userContent: string
    llmContent: string
    sourceThread: {
      id: string
      provider: Provider
      alias: string
    }
    assistantMessageId: string
    rootMessageId: string
    parentInvocationId: string
    /** F026 R-204 follow-up · 透传 final flow 父 callId,SOP 合成派发用作 parent_call_id。 */
    dispatchedCallId?: string | null
    emit: EmitEvent
  }): void {
    if (!this.skillRegistry || !this.sopTracker) return

    // Determine which skill was just active by matching the user content that
    // triggered this turn (that's where the skill hint comes from).
    const matched = this.skillRegistry.match(input.userContent)
    if (!matched.length) return

    for (const { skill } of matched) {
      const advancement = this.sopTracker.advance(
        input.sessionGroupId,
        skill.name,
        this.skillRegistry,
      )

      if (!advancement) {
        this.sopTracker.setStage(input.sessionGroupId, `completed:${skill.name}`)
        input.emit({
          type: "status",
          payload: {
            sessionGroupId: input.sessionGroupId,
            message: `SOP 完成 ${skill.name}，等待新任务。`,
          },
        })
        break
      }

      if (skill.name !== "feat-lifecycle" && advancement.nextStage === "feat-lifecycle") {
        this.sopTracker.setStage(input.sessionGroupId, `completed:${skill.name}`)
        input.emit({
          type: "status",
          payload: {
            sessionGroupId: input.sessionGroupId,
            message: `SOP 链完成（${skill.name}），等待新任务。`,
          },
        })
        break
      }

      const sopInfo = this.skillRegistry.getSopStage(advancement.nextStage)
      const skillSuggestion = sopInfo?.suggestedSkill
        ? ` 建议加载 skill: ${sopInfo.suggestedSkill}`
        : ""
      input.emit({
        type: "status",
        payload: {
          sessionGroupId: input.sessionGroupId,
          message: `SOP 推进到 ${advancement.nextStage}。${skillSuggestion}`,
        },
      })

      // F003/P4-3: if the skill declared a next_dispatch and the LLM's reply
      // did not already @-mention the target on a line-start, synthesize a
      // forced dispatch so the SOP chain keeps rolling without human nudges.
      if (advancement.nextDispatch) {
        const plan = planForcedDispatch({
          nextDispatch: advancement.nextDispatch,
          sourceProvider: input.sourceThread.provider,
          sourceAlias: input.sourceThread.alias,
          llmContent: input.llmContent,
          resolveTargetAlias: (targetProvider) => {
            const targetThread = this.sessions.findThreadByGroupAndProvider(
              input.sessionGroupId,
              targetProvider,
            )
            return targetThread?.alias ?? null
          },
        })
        if (plan) {
          input.emit({
            type: "status",
            payload: {
              sessionGroupId: input.sessionGroupId,
              message: `SOP 自动交接 — ${input.sourceThread.alias} → ${plan.targetAlias}`,
            },
          })
          const enqueueResult = this.dispatch.enqueuePublicMentions({
            messageId: input.assistantMessageId,
            sessionGroupId: input.sessionGroupId,
            sourceProvider: input.sourceThread.provider,
            sourceAlias: input.sourceThread.alias,
            rootMessageId: input.rootMessageId,
            content: plan.syntheticContent,
            matchMode: "line-start",
            parentInvocationId: input.parentInvocationId,
            // F026 R-204 follow-up · SOP 合成派发同 final flow 时序,直传 dispatchedCallId
            // 让 child a2a_calls.parent_call_id 接通 call tree。
            parentCallId: input.dispatchedCallId ?? null,
            buildSnapshot: () =>
              this.captureSnapshot(input.sessionGroupId, input.assistantMessageId),
            extractSnippet: (c, alias) => extractTaskSnippet(c, alias),
          })
          this.emitBlockedDispatches(enqueueResult, input.emit)
        }
      }

      break // Only advance once per turn
    }
  }
}
