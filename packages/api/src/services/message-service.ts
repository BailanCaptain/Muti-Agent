import type {
  ConnectorSource,
  Provider,
  RealtimeClientEvent,
  RealtimeServerEvent,
} from "@multi-agent/shared"
import { perfCollector } from "../lib/perf-collector"
import { PROVIDER_ALIASES, getContextWindowForModel } from "@multi-agent/shared"
import type { AppEventBus } from "../events/event-bus"
import type { ApprovalManager } from "../orchestrator/approval-manager"
import type { ContextMessage } from "../orchestrator/context-snapshot"
import { buildContextSnapshot, extractTaskSnippet } from "../orchestrator/context-snapshot"
import type {
  DispatchOrchestrator,
  EnqueueMentionsResult,
  QueueEntry,
} from "../orchestrator/dispatch"
import type { InvocationRegistry } from "../orchestrator/invocation-registry"
import {
  type DecisionItemParsed,
  extractDecisionItems,
  extractWithdrawals,
  generateAggregatedResult,
} from "../orchestrator/aggregate-result"
import type { DecisionBoard, DecisionBoardEntry } from "../orchestrator/decision-board"
import type { SettlementDetector } from "../orchestrator/settlement-detector"
import type { ChainStarterResolver } from "../orchestrator/chain-starter-resolver"
import { type ParallelGroup, ParallelGroupRegistry } from "../orchestrator/parallel-group"
import { buildPhase1Header } from "../orchestrator/phase1-header"
import { buildPhase2Turn } from "../orchestrator/phase2-header"
import { runTurn } from "../runtime/cli-orchestrator"
import { runContinuationLoop } from "../runtime/continuation-loop"
import { A2AChainRegistry } from "../orchestrator/a2a-chain"
import { planReturnPathDispatch } from "../orchestrator/return-path"
import { planForcedDispatch } from "../orchestrator/forced-dispatch"
import {
  assemblePrompt,
  assembleDirectTurnPrompt,
  type AssemblePromptResult,
} from "../orchestrator/context-assembler"
import { extractSOPBookmark } from "../orchestrator/sop-bookmark"
import { shouldAutoResume, buildAutoResumeMessage, MAX_AUTO_RESUMES } from "../orchestrator/auto-resume"
import { detectFBloat } from "../orchestrator/fbloat-detector"
import type { SOPBookmark } from "../orchestrator/sop-bookmark"
import { POLICY_FULL, POLICY_GUARDIAN, POLICY_INDEPENDENT } from "../orchestrator/context-policy"
import { classifyFailure } from "../runtime/failure-classifier"
import { loadRuntimeConfig, resolveEffectiveOverride } from "../runtime/runtime-config"
import type { DecisionManager } from "../orchestrator/decision-manager"
import type { SkillRegistry } from "../skills/registry"
import { applySlashCommandHint } from "../skills/slash-route"
import type { SopTracker } from "../skills/sop-tracker"
import type { MemoryService } from "./memory-service"
import type { WorkflowSopService as WorkflowSopServiceType } from "./workflow-sop-service"
import type { SessionService } from "./session-service"
import { computeEffectiveSessionId } from "./session-effectiveness"
import { createLogger } from "../lib/logger"

type ActiveRun = ReturnType<typeof runTurn>
type EmitEvent = (event: RealtimeServerEvent) => void

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

export class MessageService {
  private readonly log = createLogger("message-service")
  private readonly flushingGroups = new Set<string>()
  private readonly parallelGroups = new ParallelGroupRegistry()
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
  private readonly chainRegistry = new A2AChainRegistry()
  private readonly pendingBoardFlushes = new Map<string, DecisionBoardEntry[]>()
  private readonly streamingFlushers = new Map<string, { sessionGroupId: string; flush: () => void }>()

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
      choice:
        | { kind: "option"; optionId: string }
        | { kind: "custom"; text: string }
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
    const rootMessageId = this.dispatch.registerUserRoot(
      userMessage.id,
      payload.sessionGroupId,
    )
    const userTimeline = this.sessions.toTimelineMessage(target.threadId, userMessage.id)
    if (userTimeline) {
      emit({
        type: "message.created",
        payload: { threadId: target.threadId, sessionGroupId: payload.sessionGroupId, message: userTimeline },
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
      choice:
        | { kind: "option"; optionId: string }
        | { kind: "custom"; text: string }
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
    return this.dispatch
      .getAgentStatuses(sessionGroupId)
      .some((status) => status.running)
  }

  /**
   * SettlementDetector signal: is any parallel group (Phase 1 fan-out or
   * its Phase 2 serial discussion) still active for this session group?
   */
  hasActiveParallelGroupInSession(sessionGroupId: string): boolean {
    return this.parallelGroups.hasAnyActiveInSession(sessionGroupId)
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
      payload: { sessionGroupId: thread.sessionGroupId, message: `正在停止 ${thread.alias} 房间内的待执行协作任务。` },
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
      payload: { sessionGroupId: thread.sessionGroupId, message: `已停止 ${targetThread.alias} 的运行。` },
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
      extractSnippet: (c, alias) => extractTaskSnippet(c, alias),
      createParallelGroup: (targetProviders) => {
        const group = this.parallelGroups.create({
          parentMessageId: options.messageId,
          originatorAgentId: thread.alias,
          originatorProvider: thread.provider,
          targetProviders,
          joinBehavior: "notify_originator",
          initiatedBy: "agent",
          sessionGroupId: thread.sessionGroupId,
        })
        this.parallelGroups.start(group.id)
        return group
      },
    })
    this.emitBlockedDispatches(enqueueResult, options.emit)

    // A2A single dispatch: emit "A2A 协助" header connector for each
    // agent-initiated single-target dispatch (no parallelGroupId).
    for (const entry of enqueueResult.queued) {
      if (!entry.parallelGroupId) {
        const targetThread = this.sessions.findThreadByGroupAndProvider(
          thread.sessionGroupId,
          entry.to.provider,
        )
        if (targetThread) {
          const a2aConnectorSource: ConnectorSource = {
            kind: "multi_mention_result",
            label: "A2A 协助",
            fromAlias: thread.alias,
            toAlias: entry.to.agentId,
            targets: [entry.to.provider],
          }
          const a2aConnector = this.sessions.appendConnectorMessage(
            targetThread.id,
            "",
            a2aConnectorSource,
            entry.id,
            "header",
          )
          const a2aTimeline = this.sessions.toTimelineMessage(targetThread.id, a2aConnector.id)
          if (a2aTimeline) {
            options.emit({
              type: "message.created",
              payload: { threadId: targetThread.id, sessionGroupId: thread.sessionGroupId, message: a2aTimeline },
            })
          }
        }
      }
    }

    await this.flushDispatchQueue(thread.sessionGroupId, options.emit)
  }

  private async handleSendMessage(
    event: Extract<RealtimeClientEvent, { type: "send_message" }>,
    emit: EmitEvent,
  ) {
    this.log.info({ provider: event.payload.provider, content: event.payload.content.slice(0, 80) }, "user message received")
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
    const userMessage = this.sessions.appendUserMessage(thread.id, event.payload.content, contentBlocksJson)
    const rootMessageId = this.dispatch.registerUserRoot(userMessage.id, thread.sessionGroupId)
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
      buildSnapshot: () => this.captureSnapshot(thread.sessionGroupId, userMessage.id),
      extractSnippet: (c, alias) => extractTaskSnippet(c, alias),
      createParallelGroup: (targetProviders) => {
        const group = this.parallelGroups.create({
          parentMessageId: userMessage.id,
          originatorAgentId: thread.alias,
          originatorProvider: thread.provider,
          targetProviders,
          joinBehavior: "notify_originator",
          initiatedBy: "user",
          sessionGroupId: thread.sessionGroupId,
        })
        this.parallelGroups.start(group.id)

        // Emit Phase 1 header connector at the START of the parallel group
        const phase1ConnectorSource: ConnectorSource = {
          kind: "multi_mention_result",
          label: "并行独立思考",
          targets: targetProviders,
        }
        const phase1Connector = this.sessions.appendConnectorMessage(
          thread.id,
          "",
          phase1ConnectorSource,
          group.id,
          "header",
        )
        const phase1Timeline = this.sessions.toTimelineMessage(thread.id, phase1Connector.id)
        if (phase1Timeline) {
          emit({
            type: "message.created",
            payload: { threadId: thread.id, sessionGroupId: thread.sessionGroupId, message: phase1Timeline },
          })
        }

        return group
      },
    })
    this.emitBlockedDispatches(enqueueResult, emit)

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

    // The user's message was sent to a specific thread — run that thread's turn concurrently with queued dispatches.
    const directTurn = this.runThreadTurn({
      threadId: thread.id,
      content: effectiveContent,
      emit,
      rootMessageId,
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
  }): Promise<{ messageId: string; content: string } | null> {
    const thread = this.dispatch.resolveThread(options.threadId)
    if (!thread) {
      options.emit({
        type: "status",
        payload: { message: "未找到相关线程。" },
      })
      return null
    }
    this.log.info({ threadId: thread.id, agentId: thread.alias, provider: thread.provider }, "turn started")

    if (this.invocations.has(thread.id)) {
      options.emit({
        type: "status",
        payload: { sessionGroupId: thread.sessionGroupId, message: `${thread.alias} 已经在运行中。` },
      })
      return null
    }

    // F021 Phase 5: flush pending → active and resolve effective model BEFORE
    // appending the assistant placeholder, so the message row carries the
    // correct snapshot for the chat bubble pill. Order: snapshot → resolve →
    // append. The same snapshot is later emitted on invocation.started.
    const sessionSnapshot = this.sessions.flushSessionPending(thread.sessionGroupId) as Record<
      string,
      { model?: string; effort?: string }
    >
    const hasSessionSnapshot = Object.keys(sessionSnapshot).length > 0
    const globalOverride = loadRuntimeConfig()[thread.provider]
    const snapshotForProvider = sessionSnapshot[thread.provider]
    // F021 P1 (范德彪 review): merge at field granularity so a session snapshot
    // that only sets `effort` still inherits `model` from the global override.
    const runtimeOverride = resolveEffectiveOverride(snapshotForProvider, globalOverride)
    const resolvedModel = runtimeOverride?.model ?? thread.currentModel

    const assistant = this.sessions.appendAssistantMessage(
      thread.id,
      "",
      "",
      "final",
      options.groupId ?? null,
      options.groupRole ?? null,
      "[]",
      resolvedModel,
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
    const dispatchCleanupTimer = globalThis.setTimeout(() => {
      this.dispatch.releaseInvocation(identity.invocationId)
    }, dispatchContextTtlMs)
    dispatchCleanupTimer.unref?.()
    this.dispatch.bindInvocation(identity.invocationId, {
      rootMessageId: options.rootMessageId,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider,
      parentInvocationId: options.parentInvocationId ?? null,
    })
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
    let thinking = ""
    let stderrLineBuf = ""
    let toolEventsJson = "[]"
    let run: ActiveRun | null = null
    let assistantContent = ""
    let lastContentFlushAt = Date.now()
    const CONTENT_FLUSH_INTERVAL_MS = 3000

    const flushKey = identity.invocationId
    this.streamingFlushers.set(flushKey, {
      sessionGroupId: thread.sessionGroupId,
      flush: () => {
        this.sessions.overwriteMessage(assistant.id, {
          content: assistantContent,
          thinking,
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
    if (!options.systemPrompt) {
      const roomSnapshot = this.captureSnapshot(
        thread.sessionGroupId,
        options.rootMessageId,
      )
      const parsedBookmark = thread.sopBookmark ? (() => { try { return JSON.parse(thread.sopBookmark) } catch { return null } })() : null
      // F018 P4 AC3.5 wiring: when starting a new session, pass bootstrap metadata
      // so assemblePrompt injects SessionBootstrap prelude (reference-only + Do NOT guess).
      // F018 P4 (Codex HIGH #2 fix): Feed the most recent sealed digest as
      // `previousDigest` so the Bootstrap includes [Previous Session Summary].
      const previousDigest = this.transcriptWriter
        ? await this.transcriptWriter.readLatestDigest(thread.id).catch(() => null)
        : null
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
          threadMemory: this.sessions.getThreadMemory(thread.id),
          previousDigest,
          recallTools: [],
        },
        this.memoryService,
      )
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

    const createRun = (userMessage: string) => runTurn({
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
      nativeSessionId: thread.nativeSessionId,
      userMessage,
      onAssistantDelta: (delta: string) => {
        assistantContent += delta
        options.emit({
          type: "assistant_delta",
          payload: { sessionGroupId: thread.sessionGroupId, messageId: assistant.id, delta },
        })
        const now = Date.now()
        if (now - lastContentFlushAt >= CONTENT_FLUSH_INTERVAL_MS) {
          lastContentFlushAt = now
          this.sessions.overwriteMessage(assistant.id, {
            content: assistantContent,
            thinking,
            toolEvents: toolEventsJson,
          })
        }
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
        thinking += `${line}\n`
        options.emit({
          type: "assistant_thinking_delta",
          payload: { sessionGroupId: thread.sessionGroupId, messageId: assistant.id, delta: `${line}\n` },
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
              thinking += cleanedChunk
              options.emit({
                type: "assistant_thinking_delta",
                payload: { sessionGroupId: thread.sessionGroupId, messageId: assistant.id, delta: cleanedChunk },
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
          thinking,
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
    this.settlementDetector?.markContinuationInFlight(
      thread.sessionGroupId,
      identity.invocationId,
    )

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
            payload: { sessionGroupId: thread.sessionGroupId, message: `${thread.alias}：${message}` },
          })
        },
        onIterationContent: (accumulated) => {
          if (!promptRequestedByCli) {
            this.sessions.overwriteMessage(assistant.id, {
              content: accumulated || "[empty response]",
              thinking,
              toolEvents: toolEventsJson,
            })
          }
        },
      })
      const result = loopResult.lastResult
      const accumulatedContent = loopResult.accumulatedContent

      // F018 P5 AC6.2: fire-and-forget embedding generation for this assistant
      // message so recall_similar_context can find it later by semantic similarity.
      // Failures (model unavailable / disk error) are silently ignored per 铁律.
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

      this.invocations.detachRun(thread.id)
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
          options.emit({
            type: "status",
            payload: {
              sessionGroupId: thread.sessionGroupId,
              message: `${thread.alias} 上下文已用 ${pct}%，自动封存，下一轮开新 session。`,
            },
          })
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

      if (result.usage) {
        const prevTokens = this.prevUsedTokens.get(thread.id) ?? 0
        const bloat = detectFBloat(prevTokens, result.usage.usedTokens)
        if (bloat.detected) {
          result.fBloatDetected = true
          options.emit({
            type: "status",
            payload: { sessionGroupId: thread.sessionGroupId, message: `${thread.alias} CLI 内部压缩检测到（token 突降 ${Math.round(bloat.dropRatio * 100)}%），下轮将强制重注入 system prompt。` },
          })
          this.memoryService?.invalidateSummary(thread.sessionGroupId)
        }
        this.prevUsedTokens.set(thread.id, result.usage.usedTokens)
      }

      if (stderrLineBuf.trim()) {
        const remainder = filterStderrNoise(stderrLineBuf)
        if (remainder.trim()) {
          thinking += remainder
        }
        stderrLineBuf = ""
      }

      this.streamingFlushers.delete(flushKey)
      const lastFillRatio = result.sealDecision?.fillRatio
      this.sessions.updateThread(thread.id, result.currentModel, effectiveSessionId, undefined, lastFillRatio)
      if (!promptRequestedByCli) {
        this.sessions.overwriteMessage(assistant.id, {
          content: accumulatedContent || "[empty response]",
          thinking,
          toolEvents: toolEventsJson,
        })
      }

      // F002: route [拍板] / [撤销拍板] markers into the Decision Board
      // instead of emitting decision.request directly. SettlementDetector
      // will flush the board once the discussion settles.
      if (!promptRequestedByCli && accumulatedContent.trim()) {
        this.collectDecisionsIntoBoard(
          thread,
          assistant.id,
          accumulatedContent,
          options.emit,
        )
      }

      this.events.emit({
        type: "invocation.finished",
        invocationId: identity.invocationId,
        threadId: thread.id,
        agentId: thread.alias,
        status: "idle",
        exitCode: result.exitCode,
        createdAt: new Date().toISOString(),
      })

      let enqueueResultForReturnPath: EnqueueMentionsResult | null = null
      if (!promptRequestedByCli && accumulatedContent.trim() && !options.suppressOutboundDispatch) {
        const enqueueResult = this.dispatch.enqueuePublicMentions({
          messageId: assistant.id,
          sessionGroupId: thread.sessionGroupId,
          sourceProvider: thread.provider,
          sourceAlias: thread.alias,
          rootMessageId: options.rootMessageId,
          content: accumulatedContent,
          matchMode: "line-start",
          parentInvocationId: identity.invocationId,
          buildSnapshot: () => this.captureSnapshot(thread.sessionGroupId, assistant.id),
          extractSnippet: (c, alias) => extractTaskSnippet(c, alias),
        })
        this.emitBlockedDispatches(enqueueResult, options.emit)
        enqueueResultForReturnPath = enqueueResult
      }

      // F003/P3: if the child reply has no outbound mention but we can still
      // see the parent in the chain registry on the same root, synthesize a
      // return-path dispatch so the parent continues its flow without waiting
      // on the user to manually @ it back.
      if (
        !promptRequestedByCli &&
        accumulatedContent.trim() &&
        !options.suppressOutboundDispatch
      ) {
        const activeSkillName =
          this.skillRegistry?.match(accumulatedContent)[0]?.skill.name ?? null
        const returnPlan = planReturnPathDispatch({
          chainRegistry: this.chainRegistry,
          childInvocationId: identity.invocationId,
          childContent: accumulatedContent,
          queuedOutboundMentionCount: enqueueResultForReturnPath?.queued.length ?? 0,
          currentRootMessageId: options.rootMessageId,
          activeSkillName,
        })
        if (returnPlan) {
          options.emit({
            type: "status",
            payload: {
              sessionGroupId: returnPlan.parentSessionGroupId,
              message: `A2A 回程 — ${returnPlan.childAlias} → ${returnPlan.parentAlias}`,
            },
          })
          // Fire-and-forget: runThreadTurn resolves on its own thread lifecycle.
          void this.runThreadTurn({
            threadId: returnPlan.parentThreadId,
            content: returnPlan.prompt,
            emit: options.emit,
            rootMessageId: options.rootMessageId,
            parentInvocationId: null,
          }).catch((err) => {
            this.log.error({ err }, "A2A return-turn unhandled rejection")
          })
        }
      }

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
        emit: options.emit,
      })

      // Extract SOP bookmark AFTER advanceSopIfNeeded so it reflects the latest stage
      const sopStage = this.sopTracker?.getStage(thread.sessionGroupId) ?? null
      const bookmark = extractSOPBookmark(accumulatedContent, sopStage)
      const bookmarkJson = bookmark.skill ? JSON.stringify(bookmark) : null
      if (bookmarkJson) {
        this.sessions.updateThread(thread.id, result.currentModel, effectiveSessionId, bookmarkJson, lastFillRatio)
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
      if (loopResult.stoppedReason === "sealed" && this.transcriptWriter && sessionForSeal) {
        try {
          await this.transcriptWriter.flush(sessionForSeal)
          const digest = await this.transcriptWriter.readDigest(sessionForSeal, thread.id)
          if (digest) {
            const { appendSession } = await import("./thread-memory")
            const existing = this.sessions.getThreadMemory(thread.id)
            const contextWindow = getContextWindowForModel(thread.currentModel) ?? 200_000
            const updated = appendSession(existing, digest, contextWindow)
            this.sessions.setThreadMemory(thread.id, updated)
          }
          this.sessions.incrementSessionChainIndex(thread.id)
        } catch (err) {
          this.log.warn({ err, threadId: thread.id }, "F018 seal hook failed (non-fatal)")
        }
      }

      if (loopResult.stoppedReason === "sealed" && bookmarkJson) {
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
            payload: { sessionGroupId: thread.sessionGroupId, message: `记忆重组中，自动续接 (${resumeCount + 1}/${MAX_AUTO_RESUMES})` },
          })
          const resumeResult = await this.runThreadTurn({
            threadId: thread.id,
            content: resumeMsg,
            emit: options.emit,
            rootMessageId: options.rootMessageId,
            autoResumeCount: resumeCount + 1,
          })
          if (resumeResult) {
            return { messageId: resumeResult.messageId, content: accumulatedContent + resumeResult.content }
          }
        }
      }

      return { messageId: assistant.id, content: accumulatedContent || "" }
    } catch (error) {
      this.log.error({ err: error, threadId: thread.id, agentId: thread.alias }, "turn failed")
      this.streamingFlushers.delete(flushKey)
      this.invocations.detachRun(thread.id)
      this.releaseInvocation(identity.invocationId, dispatchCleanupTimer)
      const message = error instanceof Error ? error.message : "Unknown error"
      this.sessions.overwriteMessage(assistant.id, {
        content: `Error: ${message}`,
        thinking,
        toolEvents: toolEventsJson,
      })
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
        createdAt: new Date().toISOString(),
      })

      options.emit({
        type: "status",
        payload: { sessionGroupId: thread.sessionGroupId, message: `${thread.alias}：${classification.userMessage}` },
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
          const next = this.dispatch.takeNextQueuedDispatch(sessionGroupId)
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
            let slotReleased = false
            try {
              // Determine policy: Phase 1 parallel group → INDEPENDENT, else FULL
              const modeBGroup = entry.parallelGroupId
                ? this.parallelGroups.get(entry.parallelGroupId)
                : undefined
              const phase1HeaderText = modeBGroup
                ? buildPhase1Header(modeBGroup.participantProviders.length)
                : undefined
              const a2aProvider = entry.to.provider as import("@multi-agent/shared").Provider

              // F019 P4: keyword-injection layer removed. Guardian mode
              // detection now queries skillRegistry directly for acceptance-
              // guardian / vision-guardian — without going through the
              // (deleted) buildSkillHintLine string. Phase 1 independent
              // thinking still wins over guardian mode (keeps Mode B
              // independence guarantee).
              const guardianCandidateNames = phase1HeaderText || !this.skillRegistry
                ? []
                : this.skillRegistry
                    .match(entry.taskSnippet, a2aProvider)
                    .map((m) => m.skill.name)
              const isGuardianMode =
                guardianCandidateNames.includes("acceptance-guardian") ||
                guardianCandidateNames.includes("vision-guardian")

              const targetThread = this.dispatch.resolveThread(threadId)
              const a2aBookmark = targetThread?.sopBookmark
                ? (() => { try { return JSON.parse(targetThread.sopBookmark) } catch { return null } })()
                : null
              // F018 P4 AC3.5 wiring: A2A path also feeds SessionBootstrap metadata
              // so Bootstrap prelude fires on new-session A2A invocations.
              // F018 P4 (Codex HIGH #2): previousDigest from latest sealed session
              const a2aPreviousDigest =
                !isGuardianMode && this.transcriptWriter
                  ? await this.transcriptWriter.readLatestDigest(threadId).catch(() => null)
                  : null
              const assembled = await assemblePrompt({
                provider: entry.to.provider as import("@multi-agent/shared").Provider,
                threadId,
                sessionGroupId,
                nativeSessionId: targetThread?.nativeSessionId ?? null,
                policy: isGuardianMode
                  ? POLICY_GUARDIAN
                  : entry.parallelGroupId ? POLICY_INDEPENDENT : POLICY_FULL,
                task: entry.taskSnippet,
                roomSnapshot: entry.contextSnapshot,
                sourceAlias: entry.from.agentId,
                targetAlias: entry.to.agentId,
                phase1HeaderText,
                sopBookmark: a2aBookmark,
                lastFillRatio: targetThread?.lastFillRatio ?? undefined,
                guardianMode: isGuardianMode,
                sessionChainIndex: isGuardianMode ? undefined : this.sessions.getSessionChainIndex(threadId),
                threadMemory: isGuardianMode ? undefined : this.sessions.getThreadMemory(threadId),
                previousDigest: a2aPreviousDigest,
                recallTools: isGuardianMode ? undefined : [],
              }, this.memoryService)

              // Determine groupId/groupRole for collapsible groups:
              // - Phase 1 parallel group → member of that group
              // - A2A single dispatch (no parallelGroupId) → member of the dispatch entry's A2A group
              const dispatchGroupId = entry.parallelGroupId ?? entry.id
              const dispatchGroupRole = "member" as const

              const turnResult = await this.runThreadTurn({
                threadId,
                content: assembled.content,
                systemPrompt: assembled.systemPrompt,
                emit,
                rootMessageId: entry.rootMessageId,
                parentInvocationId: entry.parentInvocationId,
                suppressOutboundDispatch: !!entry.parallelGroupId,
                groupId: dispatchGroupId,
                groupRole: dispatchGroupRole,
              })

              // Parallel group join: mark this provider done with its real reply.
              if (entry.parallelGroupId) {
                const joinResult = this.parallelGroups.markCompleted(
                  entry.parallelGroupId,
                  entry.to.provider,
                  {
                    messageId: turnResult?.messageId ?? "",
                    content: turnResult?.content ?? "",
                  },
                )
                if (joinResult?.allDone) {
                  // Release slot BEFORE Phase 2 / fan-in — those call
                  // runThreadTurn on THIS same provider (the last to complete)
                  // and user-followup paths use getBusyStatus which checks
                  // the slot. Holding it here would deadlock both.
                  this.dispatch.releaseSlot(sessionGroupId, entry.to.provider)
                  slotReleased = true
                  await this.handleParallelGroupAllDone(
                    sessionGroupId,
                    joinResult.group,
                    emit,
                  )
                  this.parallelGroups.markAggregationDone(entry.parallelGroupId)
                  this.parallelGroups.remove(entry.parallelGroupId)
                  this.settlementDetector?.notifyStateChange(sessionGroupId)
                }
              }
            } finally {
              if (!slotReleased) {
                this.dispatch.releaseSlot(sessionGroupId, entry.to.provider)
              }
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
      console.log(`[perf] emitThreadSnapshot(${sessionGroupId.slice(0, 8)}): FULL flush=${(tFlush - t0).toFixed(1)}ms getActiveGroup=${(tGroup - tFlush).toFixed(1)}ms total=${total.toFixed(1)}ms`)
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
      console.log(`[perf] emitThreadSnapshot(${sessionGroupId.slice(0, 8)}): DELTA flush=${(tFlush - t0).toFixed(1)}ms getDelta=${(tDelta - tFlush).toFixed(1)}ms newMsgs=${delta.newMessages.length} total=${total.toFixed(1)}ms`)
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
      return msgs.map((m: { id: string; role: string; content: string; toolEvents?: string; createdAt: string }) => {
        const raw: { id: string; threadId: string; role: "user" | "assistant"; content: string; createdAt: string; toolEventsSummary?: string } = {
          id: m.id,
          threadId: t.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          createdAt: m.createdAt,
        }
        if (m.toolEvents && m.toolEvents !== "[]") {
          try {
            const events = JSON.parse(m.toolEvents) as { toolName?: string; status?: string; toolInput?: string; content?: string }[]
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
          } catch { /* malformed JSON — skip */ }
        }
        return raw
      })
    })
    return [...buildContextSnapshot(allMessages, threadMeta, { sessionGroupId, triggerMessageId, maxMessages: 40 })]
  }

  private getBusyStatus(threadId: string, sessionGroupId: string) {
    const thread = this.dispatch.resolveThread(threadId)
    if (!thread) return null

    if (this.dispatch.isSlotBusy(sessionGroupId, thread.provider)) {
      return `${thread.alias} 已经在运行中。`
    }

    return null
  }

  /**
   * Agent 主动触发的多 agent 并行思考。
   * 创建 ParallelGroup → 向每个 target agent 派发同一 question → 收集回复 → 回调 callbackTo。
   */
  async handleParallelThink(
    sessionGroupId: string,
    params: {
      targets: string[]
      question: string
      callbackTo: string
      sourceProvider: import("@multi-agent/shared").Provider
      invocationId: string
      context?: string
      timeoutMinutes?: number
      idempotencyKey?: string
      emit: EmitEvent
    },
  ): Promise<{ ok: true; groupId: string }> {
    const { PROVIDER_ALIASES } = await import("@multi-agent/shared")

    // Resolve target aliases to providers
    const targetProviders: import("@multi-agent/shared").Provider[] = []
    for (const alias of params.targets) {
      const provider = Object.entries(PROVIDER_ALIASES).find(
        ([, a]) => a === alias,
      )?.[0] as import("@multi-agent/shared").Provider | undefined
      if (provider) targetProviders.push(provider)
    }

    if (!targetProviders.length) {
      return { ok: true, groupId: "none" }
    }

    // Resolve callbackTo provider
    const callbackToProvider = Object.entries(PROVIDER_ALIASES).find(
      ([, a]) => a === params.callbackTo,
    )?.[0] as import("@multi-agent/shared").Provider | undefined

    // Create parallel group with state machine
    const group = this.parallelGroups.create({
      parentMessageId: params.invocationId,
      originatorAgentId: params.callbackTo,
      originatorProvider: params.sourceProvider,
      targetProviders,
      joinBehavior: "notify_originator",
      callbackTo: callbackToProvider ?? params.sourceProvider,
      question: params.question,
      timeoutMinutes: params.timeoutMinutes,
      idempotencyKey: params.idempotencyKey,
      initiatedBy: "agent",
      sessionGroupId,
    })

    this.parallelGroups.start(group.id)

    // Emit Phase 1 header connector for agent-initiated parallel think
    const agentSourceThread = this.sessions.findThreadByGroupAndProvider(sessionGroupId, params.sourceProvider)
    if (agentSourceThread) {
      const phase1ConnectorSource: ConnectorSource = {
        kind: "multi_mention_result",
        label: "并行独立思考",
        targets: targetProviders,
      }
      const phase1Connector = this.sessions.appendConnectorMessage(
        agentSourceThread.id,
        "",
        phase1ConnectorSource,
        group.id,
        "header",
      )
      const phase1Timeline = this.sessions.toTimelineMessage(agentSourceThread.id, phase1Connector.id)
      if (phase1Timeline) {
        params.emit({
          type: "message.created",
          payload: { threadId: agentSourceThread.id, sessionGroupId, message: phase1Timeline },
        })
      }
    }

    // Start timeout: on expiry, fill placeholders and run allDone handler
    // (agent-initiated → aggregate delivered directly to callbackTo).
    this.parallelGroups.startTimeout(group.id, () => {
      this.parallelGroups.handleTimeout(group.id)
      const timedOutGroup = this.parallelGroups.get(group.id)
      if (timedOutGroup) {
        void this.handleParallelGroupAllDone(sessionGroupId, timedOutGroup, params.emit).finally(
          () => this.parallelGroups.remove(group.id),
        )
      }
    })

    // Build prompt with context. Reuse buildPhase1Header so agent-initiated
    // parallel_think shares the same Phase 1 independence rules as the
    // user-mention fan-out path (message-service:619-625).
    const contextLine = params.context ? `\n\n背景信息：${params.context}` : ""
    const phase1Header = buildPhase1Header(targetProviders.length)
    const prompt = `${phase1Header}\n\n问题：${params.question}${contextLine}`

    // Use source thread to create a root message for dispatch tracking
    const sourceThread = this.sessions.findThreadByGroupAndProvider(sessionGroupId, params.sourceProvider)
    const rootMessageId = sourceThread
      ? this.sessions.appendUserMessage(sourceThread.id, prompt).id
      : crypto.randomUUID()

    // Fan out in parallel; each provider's reply feeds markCompleted.
    // When all participants are done, run the shared allDone handler
    // (agent-initiated → aggregate goes directly to group.callbackTo).
    // F019 P4: the old skill-hint keyword injection that Mode B had to dodge
    // is gone; Phase 1 header alone is the independence contract.
    for (const provider of targetProviders) {
      const thread = this.sessions.findThreadByGroupAndProvider(sessionGroupId, provider)
      if (!thread) continue

      void (async () => {
        const turnResult = await this.runThreadTurn({
          threadId: thread.id,
          content: prompt,
          emit: params.emit,
          rootMessageId,
          parentInvocationId: params.invocationId,
          groupId: group.id,
          groupRole: "member",
        })
        const joinResult = this.parallelGroups.markCompleted(group.id, provider, {
          messageId: turnResult?.messageId ?? "",
          content: turnResult?.content ?? "",
        })
        if (joinResult?.allDone) {
          await this.handleParallelGroupAllDone(sessionGroupId, joinResult.group, params.emit)
          this.parallelGroups.markAggregationDone(group.id)
          this.parallelGroups.remove(group.id)
        }
      })().catch((err) => {
        this.log.error({ err, provider }, "parallel group member turn unhandled rejection")
      })
    }

    return { ok: true, groupId: group.id }
  }

  /**
   * Present a multi-choice decision card to the user.
   * Returns the selected option IDs.
   */
  async requestDecision(params: {
    kind: "multi_choice" | "fan_in_selector"
    title: string
    description?: string
    options: Array<{ id: string; label: string; description?: string; provider?: import("@multi-agent/shared").Provider }>
    sessionGroupId: string
    sourceProvider?: import("@multi-agent/shared").Provider
    sourceAlias?: string
    multiSelect?: boolean
  }): Promise<string[]> {
    if (!this.decisions) return []
    const response = await this.decisions.request(params)
    return response.decisions
      .filter(d => d.verdict === "approved" || d.verdict === "modified")
      .map(d => d.optionId)
  }

  /**
   * Parallel group terminal handler (allDone / timeout).
   *
   * - user  → compact Phase 2 header, run serial discussion, pop fan-in card
   * - agent → emit Phase 1 aggregate bubble, route to group.callbackTo
   */
  private async handleParallelGroupAllDone(
    sessionGroupId: string,
    group: ParallelGroup,
    emit: EmitEvent,
  ): Promise<void> {
    const { PROVIDER_ALIASES } = await import("@multi-agent/shared")

    const aggregate = generateAggregatedResult(
      { question: group.question, completedResults: group.completedResults },
      PROVIDER_ALIASES,
    )

    const originatorThread = this.sessions.findThreadByGroupAndProvider(
      sessionGroupId,
      group.originatorProvider,
    )

    if (group.initiatedBy === "user") {
      // User-initiated: don't emit the Phase 1 aggregate bubble (it duplicates
      // each agent's individual reply already visible in the timeline). Just
      // drop a compact Phase 2 header before the serial discussion starts.
      await this.emitPhase2HeaderConnector(originatorThread, group, emit)
      await this.runPhase2SerialDiscussion(sessionGroupId, group, aggregate, emit)
      await this.selectFanInAndNotify(sessionGroupId, group, emit)
    } else {
      // Agent-initiated (parallel_think tool): the callback agent did NOT
      // participate, so it has no context in its CLI session. It still needs
      // the full aggregate, and the bubble helps the user follow along.
      if (originatorThread) {
        const connectorSource: ConnectorSource = {
          kind: "multi_mention_result",
          label: "并行思考结果",
          initiator: group.originatorProvider,
          targets: group.participantProviders,
        }
        const connectorMessage = this.sessions.appendConnectorMessage(
          originatorThread.id,
          aggregate,
          connectorSource,
        )
        const timelineMessage = this.sessions.toTimelineMessage(
          originatorThread.id,
          connectorMessage.id,
        )
        if (timelineMessage) {
          emit({
            type: "message.created",
            payload: { threadId: originatorThread.id, sessionGroupId, message: timelineMessage },
          })
        }
      }
      this.notifyCallbackAgent(sessionGroupId, group, aggregate, emit)
    }
  }

  /**
   * Run Phase 2 serial discussion: PHASE2_ROUNDS rounds × N agents, in
   * participantProviders order. If an agent fails or returns empty, it's
   * skipped in later rounds and the discussion continues with the rest.
   */
  private async runPhase2SerialDiscussion(
    sessionGroupId: string,
    group: ParallelGroup,
    phase1Aggregate: string,
    emit: EmitEvent,
  ): Promise<void> {
    // SKILL says 2-3 rounds. Default to 3 so agents get one round to react
    // to others' reactions. If everyone's signaled [consensus], we stop early.
    const PHASE2_ROUNDS = 3
    const skipped = new Set<import("@multi-agent/shared").Provider>()
    const consensusSignaled = new Set<import("@multi-agent/shared").Provider>()

    emit({
      type: "status",
      payload: { sessionGroupId, message: `开始串行讨论（${PHASE2_ROUNDS} 轮）` },
    })

    for (let round = 1; round <= PHASE2_ROUNDS; round++) {
      for (const provider of group.participantProviders) {
        if (skipped.has(provider)) continue

        const thread = this.sessions.findThreadByGroupAndProvider(sessionGroupId, provider)
        if (!thread) {
          skipped.add(provider)
          continue
        }

        const prompt = buildPhase2Turn({
          agentAlias: thread.alias,
          round,
          totalRounds: PHASE2_ROUNDS,
          phase1Aggregate,
          priorReplies: group.phase2Replies,
          aliases: PROVIDER_ALIASES,
        })

        const phase2GroupId = `${group.id}_phase2`
        let turnResult: { messageId: string; content: string } | null = null
        try {
          turnResult = await this.runThreadTurn({
            threadId: thread.id,
            content: prompt,
            emit,
            rootMessageId: group.parentMessageId,
            suppressOutboundDispatch: true,
            groupId: phase2GroupId,
            groupRole: "member",
          })
        } catch (err) {
          this.log.error({ err, threadId: thread.id, provider }, "parallel think turn failed")
          turnResult = null
        }

        if (!turnResult || !turnResult.content.trim()) {
          skipped.add(provider)
          continue
        }

        this.parallelGroups.addPhase2Reply(group.id, {
          round,
          provider,
          messageId: turnResult.messageId,
          content: turnResult.content,
        })

        // Track per-round consensus signal. Reset next round so the signal
        // has to be repeated — prevents a stale signal ending the discussion
        // after someone else raises a new point.
        if (/\[consensus\]\s*$/i.test(turnResult.content.trim())) {
          consensusSignaled.add(provider)
        }
      }

      // Early termination: from round 2 onward, if every still-active agent
      // signaled consensus THIS round, the discussion has converged.
      if (round >= 2) {
        const activeProviders = group.participantProviders.filter((p) => !skipped.has(p))
        const allConsensus =
          activeProviders.length > 0 && activeProviders.every((p) => consensusSignaled.has(p))
        if (allConsensus) {
          this.decisionBoard?.markAllConverged(sessionGroupId)
          emit({
            type: "status",
            payload: { sessionGroupId, message: `串行讨论已在第 ${round} 轮达成共识，提前结束` },
          })
          break
        }
      }
      consensusSignaled.clear()
    }
  }

  /**
   * Compact Phase 2 header bubble placed in the timeline BEFORE the serial
   * discussion starts. It's a visual marker/separator — no transcript. The
   * individual agent replies stream in naturally as regular bubbles under it.
   */
  private async emitPhase2HeaderConnector(
    originatorThread: { id: string } | null,
    group: ParallelGroup,
    emit: EmitEvent,
  ): Promise<void> {
    if (!originatorThread) return

    // Header-only marker: the bubble header (label + participant avatars)
    // already conveys the info. No body content — the individual agent
    // replies appear below as normal bubbles in the timeline.
    const connectorSource: ConnectorSource = {
      kind: "multi_mention_result",
      label: "串行讨论",
      targets: group.participantProviders,
    }
    const phase2GroupId = `${group.id}_phase2`
    const connectorMessage = this.sessions.appendConnectorMessage(
      originatorThread.id,
      "",
      connectorSource,
      phase2GroupId,
      "header",
    )
    const timelineMessage = this.sessions.toTimelineMessage(
      originatorThread.id,
      connectorMessage.id,
    )
    if (timelineMessage) {
      emit({
        type: "message.created",
        payload: { threadId: originatorThread.id, sessionGroupId: group.sessionGroupId, message: timelineMessage },
      })
    }
  }

  /**
   * Post-discussion user-input card. Lets the user pick a synthesizer,
   * type a follow-up instruction, or both. Routing:
   *   - option + text    → synthesizer runs with aggregate + user's instruction
   *   - option only      → synthesizer runs with default synthesis prompt
   *   - text only        → user's text becomes a new user message in the
   *                        originator thread; normal @-routing takes over
   *   - neither          → no-op (status only)
   */
  private async selectFanInAndNotify(
    sessionGroupId: string,
    group: ParallelGroup,
    emit: EmitEvent,
  ): Promise<void> {
    // Options scoped to this group's participants only — not all providers,
    // and not 村长 (no self-synthesis option).
    const options = group.participantProviders.map((p) => ({
      id: p,
      label: PROVIDER_ALIASES[p],
      description: `由 ${PROVIDER_ALIASES[p]} 综合各方观点`,
      provider: p,
    }))

    if (!this.decisions) return

    const boardEntries = this.decisionBoard?.getPending(sessionGroupId) ?? []
    const convergedItems = boardEntries.filter((e) => e.converged)
    const divergentItems = boardEntries.filter((e) => !e.converged)

    const descParts: string[] = [
      "讨论已完成。选一个 agent 综合各方观点，或直接输入你的想法/下一步指令（两者可以都填）。",
    ]
    if (convergedItems.length > 0) {
      descParts.push(
        `\n\n✅ 团队已收敛观点：\n${convergedItems.map((i) => `- ${i.question}`).join("\n")}`,
      )
    }
    if (divergentItems.length > 0) {
      descParts.push(
        `\n\n⚠️ 未收敛分歧点（需要你决定）：\n${divergentItems.map((i) => `- ${i.question}`).join("\n")}`,
      )
    }
    const description = descParts.join("")

    const response = await this.decisions.request({
      kind: "fan_in_selector",
      title: "下一步",
      description,
      options,
      sessionGroupId,
      multiSelect: false,
      allowTextInput: true,
      textInputPlaceholder:
        divergentItems.length > 0
          ? "回应上面的分歧点，或给综合者的指令…"
          : "想让谁做什么？或留给选定的综合者的额外指令…",
      timeoutMs: 10 * 60 * 1000,
    })

    const approvedDecision = response.decisions.find(d => d.verdict === "approved" || d.verdict === "modified")
    const selectedProvider = (approvedDecision?.optionId) as
      | import("@multi-agent/shared").Provider
      | undefined
    const userInput = response.userInput.trim()

    if (selectedProvider) {
      group.callbackTo = selectedProvider
      await this.runSynthesizerTurn(sessionGroupId, group, userInput, emit)
      return
    }

    if (userInput) {
      // No synthesizer picked — user just wants to steer. Route their text
      // through the normal chat path so @-mentions and panel routing apply.
      await this.injectUserFollowUp(sessionGroupId, group, userInput, emit)
      return
    }

    emit({
      type: "status",
      payload: { sessionGroupId, message: "未选择综合者，讨论结果已归档" },
    })
  }

  /**
   * Collect `[拍板]` questions from Phase 1 results + Phase 2 replies, deduped
   * by question text, minus any `[撤销拍板]` withdrawals. Returns only items
   * that are still unresolved after the full discussion.
   */
  private collectPendingDecisionItems(group: ParallelGroup): string[] {
    const seen = new Set<string>()
    const questions: string[] = []
    const withdrawn = new Set<string>()

    const collectWithdrawals = (content: string) => {
      for (const w of extractWithdrawals(content)) {
        withdrawn.add(w)
      }
    }

    for (const provider of group.participantProviders) {
      const reply = group.completedResults.get(provider)
      if (reply) collectWithdrawals(reply.content)
    }
    for (const reply of group.phase2Replies) {
      collectWithdrawals(reply.content)
    }

    const push = (candidates: DecisionItemParsed[]) => {
      for (const c of candidates) {
        if (seen.has(c.question)) continue
        const isWithdrawn = [...withdrawn].some((w) => c.question.includes(w))
        if (isWithdrawn) continue
        seen.add(c.question)
        questions.push(c.question)
      }
    }

    for (const provider of group.participantProviders) {
      const reply = group.completedResults.get(provider)
      if (reply) push(extractDecisionItems(reply.content))
    }
    for (const reply of group.phase2Replies) {
      push(extractDecisionItems(reply.content))
    }
    return questions
  }

  /**
   * Run the chosen synthesizer with a MINIMAL prompt. The synthesizer is one
   * of the parallel participants — its CLI native session already contains
   * Phase 1 + all Phase 2 prompts/replies, so we don't re-dump the aggregate.
   */
  private async runSynthesizerTurn(
    sessionGroupId: string,
    group: ParallelGroup,
    userInstruction: string,
    emit: EmitEvent,
  ): Promise<void> {
    if (!group.callbackTo) return

    const callbackThread = this.sessions.findThreadByGroupAndProvider(
      sessionGroupId,
      group.callbackTo,
    )
    if (!callbackThread) return

    const prompt = userInstruction
      ? `${userInstruction}\n\n（请基于刚才并行+串行讨论的上下文回答；你已经看到过所有人的观点）`
      : "请综合刚才并行+串行讨论的各方观点，整理共识、分歧和行动项。你已经看到过所有人的观点。"
    const rootMessage = this.sessions.appendUserMessage(callbackThread.id, prompt)

    await this.runThreadTurn({
      threadId: callbackThread.id,
      content: prompt,
      emit,
      rootMessageId: rootMessage.id,
      suppressOutboundDispatch: true,
    })
  }

  /**
   * User typed free text without picking a synthesizer. Post it as a user
   * message in the originator thread and let normal @-routing handle it.
   */
  private async injectUserFollowUp(
    sessionGroupId: string,
    group: ParallelGroup,
    userInput: string,
    emit: EmitEvent,
  ): Promise<void> {
    const originatorThread = this.sessions.findThreadByGroupAndProvider(
      sessionGroupId,
      group.originatorProvider,
    )
    if (!originatorThread) return

    await this.handleSendMessage(
      {
        type: "send_message",
        payload: {
          threadId: originatorThread.id,
          provider: originatorThread.provider,
          content: userInput,
          alias: originatorThread.alias,
        },
      },
      emit,
    )
  }

  private notifyCallbackAgent(
    sessionGroupId: string,
    group: ParallelGroup,
    aggregate: string,
    emit: EmitEvent,
  ): void {
    if (!group.callbackTo) return

    const callbackThread = this.sessions.findThreadByGroupAndProvider(
      sessionGroupId,
      group.callbackTo,
    )
    if (!callbackThread) return

    const prompt = `${aggregate}\n请综合以上各方观点，整理共识、分歧和行动项。`
    const rootMessage = this.sessions.appendUserMessage(callbackThread.id, prompt)

    this.runThreadTurn({
      threadId: callbackThread.id,
      content: prompt,
      emit,
      rootMessageId: rootMessage.id,
      suppressOutboundDispatch: true,
    })
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
          payload: { sessionGroupId: input.sessionGroupId, message: `SOP 完成 ${skill.name}，等待新任务。` },
        })
        break
      }

      if (skill.name !== "feat-lifecycle" && advancement.nextStage === "feat-lifecycle") {
        this.sopTracker.setStage(input.sessionGroupId, `completed:${skill.name}`)
        input.emit({
          type: "status",
          payload: { sessionGroupId: input.sessionGroupId, message: `SOP 链完成（${skill.name}），等待新任务。` },
        })
        break
      }

      const sopInfo = this.skillRegistry.getSopStage(advancement.nextStage)
      const skillSuggestion = sopInfo?.suggestedSkill
        ? ` 建议加载 skill: ${sopInfo.suggestedSkill}`
        : ""
      input.emit({
        type: "status",
        payload: { sessionGroupId: input.sessionGroupId, message: `SOP 推进到 ${advancement.nextStage}。${skillSuggestion}` },
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
