import type { ConnectorSource, RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
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
import { generateAggregatedResult } from "../orchestrator/aggregate-result"
import { type ParallelGroup, ParallelGroupRegistry } from "../orchestrator/parallel-group"
import { buildPhase1Header } from "../orchestrator/phase1-header"
import { runTurn } from "../runtime/cli-orchestrator"
import type { DecisionManager } from "../orchestrator/decision-manager"
import type { SkillRegistry } from "../skills/registry"
import type { SopTracker } from "../skills/sop-tracker"
import type { SessionService } from "./session-service"

type ActiveRun = ReturnType<typeof runTurn>
type EmitEvent = (event: RealtimeServerEvent) => void

const STDERR_NOISE_PATTERNS = [
  /^YOLO mode is enabled/i,
  /^All tool calls will be automatically approved/i,
  /^Loaded cached credentials/i,
  /^Using model:/i,
  /^Tip:/i,
  /^\[runtime\]/,
]

function isStderrNoiseLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  return STDERR_NOISE_PATTERNS.some((p) => p.test(trimmed))
}

function filterStderrNoise(chunk: string): string {
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
  private readonly flushingGroups = new Set<string>()
  private readonly parallelGroups = new ParallelGroupRegistry()
  private approvals: ApprovalManager | null = null
  private decisions: DecisionManager | null = null
  private skillRegistry: SkillRegistry | null = null
  private sopTracker: SopTracker | null = null

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

  handleClientEvent(event: RealtimeClientEvent, emit: EmitEvent) {
    if (event.type === "stop_thread") {
      this.cancelThreadChain(event.payload.threadId, emit)
      return
    }

    if (event.type === "end_session") {
      // TODO: 实现结束整个会话的逻辑
      return
    }

    void this.handleSendMessage(event, emit)
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
      payload: { message: `正在停止 ${thread.alias} 房间内的待执行协作任务。` },
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
      createParallelGroup: (targetProviders) =>
        this.parallelGroups.create({
          parentMessageId: options.messageId,
          originatorAgentId: thread.alias,
          originatorProvider: thread.provider,
          targetProviders,
          joinBehavior: "notify_originator",
          initiatedBy: "agent",
        }),
    })
    this.emitBlockedDispatches(enqueueResult, options.emit)

    await this.flushDispatchQueue(thread.sessionGroupId, options.emit)
  }

  private async handleSendMessage(
    event: Extract<RealtimeClientEvent, { type: "send_message" }>,
    emit: EmitEvent,
  ) {
    const thread = this.dispatch.resolveThread(event.payload.threadId)
    if (!thread) {
      emit({
        type: "status",
        payload: { message: "未找到相关线程。" },
      })
      return
    }

    const groupBusyMessage = this.getBusyStatus(thread.id, thread.sessionGroupId)
    if (groupBusyMessage) {
      emit({
        type: "status",
        payload: { message: groupBusyMessage },
      })
      this.emitThreadSnapshot(thread.sessionGroupId, emit)
      return
    }

    const userMessage = this.sessions.appendUserMessage(thread.id, event.payload.content)
    const rootMessageId = this.dispatch.registerUserRoot(userMessage.id, thread.sessionGroupId)
    const userTimeline = this.sessions.toTimelineMessage(thread.id, userMessage.id)
    if (userTimeline) {
      emit({
        type: "message.created",
        payload: {
          threadId: thread.id,
          message: userTimeline,
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
      createParallelGroup: (targetProviders) =>
        this.parallelGroups.create({
          parentMessageId: userMessage.id,
          originatorAgentId: thread.alias,
          originatorProvider: thread.provider,
          targetProviders,
          joinBehavior: "notify_originator",
          initiatedBy: "user",
        }),
    })
    this.emitBlockedDispatches(enqueueResult, emit)

    // Inject skill hint into the prompt sent to the direct thread's CLI.
    const effectiveContent = this.prependSkillHint(event.payload.content, thread.provider)

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
  }): Promise<{ messageId: string; content: string } | null> {
    const thread = this.dispatch.resolveThread(options.threadId)
    if (!thread) {
      options.emit({
        type: "status",
        payload: { message: "未找到相关线程。" },
      })
      return null
    }

    if (this.invocations.has(thread.id)) {
      options.emit({
        type: "status",
        payload: { message: `${thread.alias} 已经在运行中。` },
      })
      return null
    }

    const assistant = this.sessions.appendAssistantMessage(thread.id, "")
    this.dispatch.attachMessageToRoot(assistant.id, options.rootMessageId)
    const assistantTimeline = this.sessions.toTimelineMessage(thread.id, assistant.id)
    if (assistantTimeline) {
      options.emit({
        type: "message.created",
        payload: {
          threadId: thread.id,
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

    const startedAt = new Date().toISOString()
    let promptRequestedByCli: string | null = null
    let thinking = ""
    let run: ActiveRun | null = null

    this.events.emit({
      type: "invocation.started",
      invocationId: identity.invocationId,
      threadId: identity.threadId,
      agentId: identity.agentId,
      callbackToken: identity.callbackToken,
      status: "running",
      createdAt: startedAt,
    })

    options.emit({
      type: "status",
      payload: { message: `正在运行 ${thread.alias}` },
    })

    run = runTurn({
      invocationId: identity.invocationId,
      threadId: thread.id,
      provider: thread.provider,
      agentId: thread.alias,
      apiBaseUrl: this.apiBaseUrl,
      callbackToken: identity.callbackToken,
      model: thread.currentModel,
      nativeSessionId: thread.nativeSessionId,
      userMessage: options.content,
      onAssistantDelta: (delta: string) => {
        options.emit({
          type: "assistant_delta",
          payload: { messageId: assistant.id, delta },
        })
      },
      onSession: () => {},
      onModel: () => {},
      onToolActivity: (line: string) => {
        thinking += `${line}\n`
        options.emit({
          type: "assistant_thinking_delta",
          payload: { messageId: assistant.id, delta: `${line}\n` },
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
          const cleanedChunk = filterStderrNoise(stripAnsi(activity.chunk))
          if (cleanedChunk.trim()) {
            thinking += cleanedChunk
            options.emit({
              type: "assistant_thinking_delta",
              payload: { messageId: assistant.id, delta: cleanedChunk },
            })
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
        })
        options.emit({
          type: "status",
          payload: {
            message: `${thread.alias} 需要你的确认。当前运行已暂停，请回复以继续。`,
          },
        })
        this.emitThreadSnapshot(thread.sessionGroupId, options.emit)

        run?.cancel()
      },
    })

    this.invocations.attachRun(thread.id, identity.invocationId, run)
    this.emitThreadSnapshot(thread.sessionGroupId, options.emit)

    try {
      const result = await run.promise
      this.invocations.detachRun(thread.id)
      this.releaseInvocation(identity.invocationId, dispatchCleanupTimer)
      const effectiveSessionId =
        !result.content.trim() && result.nativeSessionId === thread.nativeSessionId
          ? null
          : result.nativeSessionId
      this.sessions.updateThread(thread.id, result.currentModel, effectiveSessionId)
      if (!promptRequestedByCli) {
        this.sessions.overwriteMessage(assistant.id, {
          content: result.content || "[empty response]",
          thinking,
        })
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

      if (!promptRequestedByCli && result.content.trim()) {
        const enqueueResult = this.dispatch.enqueuePublicMentions({
          messageId: assistant.id,
          sessionGroupId: thread.sessionGroupId,
          sourceProvider: thread.provider,
          sourceAlias: thread.alias,
          rootMessageId: options.rootMessageId,
          content: result.content,
          matchMode: "line-start",
          parentInvocationId: identity.invocationId,
          buildSnapshot: () => this.captureSnapshot(thread.sessionGroupId, assistant.id),
          extractSnippet: (c, alias) => extractTaskSnippet(c, alias),
        })
        this.emitBlockedDispatches(enqueueResult, options.emit)
      }

      // SOP advancement: if a skill was active, advance to next stage
      this.advanceSopIfNeeded(thread.sessionGroupId, options.content, options.emit)

      this.emitThreadSnapshot(thread.sessionGroupId, options.emit)
      await this.flushDispatchQueue(thread.sessionGroupId, options.emit)
      return { messageId: assistant.id, content: result.content || "" }
    } catch (error) {
      this.invocations.detachRun(thread.id)
      this.releaseInvocation(identity.invocationId, dispatchCleanupTimer)
      const message = error instanceof Error ? error.message : "Unknown error"
      this.sessions.overwriteMessage(assistant.id, {
        content: `Error: ${message}`,
        thinking,
      })
      // Clear native session so next run starts fresh instead of retrying a broken session.
      this.sessions.updateThread(thread.id, thread.currentModel, null)

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
        payload: { message },
      })
      this.emitThreadSnapshot(thread.sessionGroupId, options.emit)
      await this.flushDispatchQueue(thread.sessionGroupId, options.emit)
      return null
    }
  }

  private async flushDispatchQueue(sessionGroupId: string, emit: EmitEvent) {
    if (this.flushingGroups.has(sessionGroupId)) {
      return
    }

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
            try {
              const turnResult = await this.runThreadTurn({
                threadId,
                content: this.buildA2APrompt(entry),
                emit,
                rootMessageId: entry.rootMessageId,
                parentInvocationId: entry.parentInvocationId,
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
                  await this.handleParallelGroupAllDone(
                    sessionGroupId,
                    joinResult.group,
                    emit,
                  )
                  this.parallelGroups.remove(entry.parallelGroupId)
                }
              }
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

  private buildA2APrompt(entry: QueueEntry): string {
    const isUserInitiated = entry.from.agentId === "user"
    const header = isUserInitiated
      ? `[用户请求]`
      : `[A2A 协作请求 from ${entry.from.agentId}]`

    // Mode B (parallel group): inject Phase 1 hard-rule header instead of skillHint,
    // so agents don't race to load full SKILL.md and play synthesizer prematurely.
    // Structural guarantee of independent thinking (complements thread-per-provider
    // + snapshot-freeze isolation).
    const modeBGroup = entry.parallelGroupId
      ? this.parallelGroups.get(entry.parallelGroupId)
      : undefined
    const modeBHeader = modeBGroup
      ? buildPhase1Header(modeBGroup.participantProviders.length)
      : null

    // Match skills against taskSnippet for the target agent's provider (only when not Mode B)
    const skillHintLine = modeBHeader
      ? null
      : this.buildSkillHintLine(
          entry.taskSnippet,
          entry.to.provider as import("@multi-agent/shared").Provider,
        )

    return [
      header,
      ``,
      `任务: ${entry.taskSnippet}`,
      ``,
      ...(modeBHeader ? [modeBHeader, ``] : []),
      ...(skillHintLine ? [skillHintLine, ``] : []),
      `--- 上下文快照 (${entry.contextSnapshot.length} 条消息) ---`,
      ...entry.contextSnapshot.map((m) => `[${m.agentId}]: ${m.content.slice(0, 300)}`),
      `---`,
      ``,
      `你是 ${entry.to.agentId}。请完成上述任务。`,
    ].join("\n")
  }

  emitThreadSnapshot(sessionGroupId: string, emit: EmitEvent) {
    emit({
      type: "thread_snapshot",
      payload: {
        activeGroup: this.sessions.getActiveGroup(
          sessionGroupId,
          new Set(this.invocations.keys()),
          {
            hasPendingDispatches: this.dispatch.hasQueuedDispatches(sessionGroupId),
            dispatchBarrierActive: this.dispatch.isSessionGroupCancelled(sessionGroupId),
          },
        ),
      },
    })
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
      return msgs.map((m: { id: string; role: string; content: string; createdAt: string }) => ({
        id: m.id,
        threadId: t.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        createdAt: m.createdAt,
      }))
    })
    return [...buildContextSnapshot(allMessages, threadMeta, { sessionGroupId, triggerMessageId })]
  }

  private getBusyStatus(threadId: string, sessionGroupId: string) {
    const thread = this.dispatch.resolveThread(threadId)
    if (!thread) return null

    if (this.dispatch.isSlotBusy(sessionGroupId, thread.provider)) {
      return `${thread.alias} 已经在运行中。`
    }

    return null
  }

  // ── Skill hint helpers ──────────────────────────────────────────────

  private prependSkillHint(content: string, provider: import("@multi-agent/shared").Provider): string {
    if (!this.skillRegistry) return content

    // Slash command takes priority over trigger matching
    const slashSkill = this.skillRegistry.matchSlashCommand(content)
    if (slashSkill) {
      return `⚡ 加载 skill: ${slashSkill.name} — 请按 skill 流程执行。\n\n${content}`
    }

    const matched = this.skillRegistry.match(content, provider)
    if (!matched.length) return content

    const names = matched.map((m) => m.skill.name).join(", ")
    return `⚡ 匹配 skill: ${names} — 请加载并按 skill 流程执行。\n\n${content}`
  }

  private buildSkillHintLine(
    content: string,
    provider: import("@multi-agent/shared").Provider,
  ): string | null {
    if (!this.skillRegistry) return null

    const matched = this.skillRegistry.match(content, provider)
    if (!matched.length) return null

    const names = matched.map((m) => m.skill.name).join(", ")
    return `⚡ 匹配 skill: ${names} — 请加载并按 skill 流程执行。`
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
    })

    this.parallelGroups.start(group.id)

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

    // Build prompt with context
    const contextLine = params.context ? `\n\n背景信息：${params.context}` : ""
    const prompt = `[并行思考请求] 请独立思考以下问题，给出你的分析和观点。不要预测其他 agent 的回答。\n\n${params.question}${contextLine}`

    // Use source thread to create a root message for dispatch tracking
    const sourceThread = this.sessions.findThreadByGroupAndProvider(sessionGroupId, params.sourceProvider)
    const rootMessageId = sourceThread
      ? this.sessions.appendUserMessage(sourceThread.id, prompt).id
      : crypto.randomUUID()

    // Fan out in parallel; each provider's reply feeds markCompleted.
    // When all participants are done, run the shared allDone handler
    // (agent-initiated → aggregate goes directly to group.callbackTo).
    for (const provider of targetProviders) {
      const thread = this.sessions.findThreadByGroupAndProvider(sessionGroupId, provider)
      if (!thread) continue

      const enrichedPrompt = this.prependSkillHint(prompt, provider)
      void (async () => {
        const turnResult = await this.runThreadTurn({
          threadId: thread.id,
          content: enrichedPrompt,
          emit: params.emit,
          rootMessageId,
          parentInvocationId: params.invocationId,
        })
        const joinResult = this.parallelGroups.markCompleted(group.id, provider, {
          messageId: turnResult?.messageId ?? "",
          content: turnResult?.content ?? "",
        })
        if (joinResult?.allDone) {
          await this.handleParallelGroupAllDone(sessionGroupId, joinResult.group, params.emit)
          this.parallelGroups.remove(group.id)
        }
      })()
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
    return this.decisions.request(params)
  }

  /**
   * Parallel group terminal handler (allDone / timeout).
   *
   * 1. Render aggregate markdown from completedResults.
   * 2. Append ConnectorMessage to originator thread, broadcast message.created.
   * 3. Split on initiatedBy:
   *    - user  → pop fan_in_selector card, route aggregate to chosen provider
   *    - agent → route aggregate directly to group.callbackTo (set by parallel_think)
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
    if (originatorThread) {
      const connectorSource: ConnectorSource = {
        kind: "multi_mention_result",
        label: "并行思考结果",
        initiator: group.initiatedBy === "agent" ? group.originatorProvider : undefined,
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
          payload: { threadId: originatorThread.id, message: timelineMessage },
        })
      }
    }

    if (group.initiatedBy === "user") {
      await this.selectFanInAndNotify(sessionGroupId, group, aggregate, emit)
    } else {
      this.notifyCallbackAgent(sessionGroupId, group, aggregate, emit)
    }
  }

  /**
   * Ask the user to pick which agent should synthesize the parallel results,
   * then route the aggregate to that agent.
   */
  private async selectFanInAndNotify(
    sessionGroupId: string,
    group: ParallelGroup,
    aggregate: string,
    emit: EmitEvent,
  ): Promise<void> {
    const { PROVIDER_ALIASES, PROVIDERS } = await import("@multi-agent/shared")

    // Build fan-in options from all available agents
    const options = PROVIDERS.map((p) => ({
      id: p,
      label: PROVIDER_ALIASES[p],
      description: `由 ${PROVIDER_ALIASES[p]} 综合各方观点`,
      provider: p,
    }))

    if (this.decisions) {
      const selectedIds = await this.decisions.request({
        kind: "fan_in_selector",
        title: "选择扇入综合者",
        description: "并行思考已完成，请选择由哪个 agent 来综合各方观点",
        options,
        sessionGroupId,
        multiSelect: false,
      })

      if (selectedIds.length > 0) {
        group.callbackTo = selectedIds[0] as import("@multi-agent/shared").Provider
      }
    }

    this.notifyCallbackAgent(sessionGroupId, group, aggregate, emit)
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
    })
  }

  private advanceSopIfNeeded(sessionGroupId: string, content: string, emit: EmitEvent): void {
    if (!this.skillRegistry || !this.sopTracker) return

    // Determine which skill was just active by matching the content
    const matched = this.skillRegistry.match(content)
    if (!matched.length) return

    for (const { skill } of matched) {
      const nextStage = this.sopTracker.advance(sessionGroupId, skill.name, this.skillRegistry)
      if (nextStage) {
        const sopInfo = this.skillRegistry.getSopStage(nextStage)
        const skillSuggestion = sopInfo?.suggestedSkill
          ? ` 建议加载 skill: ${sopInfo.suggestedSkill}`
          : ""
        emit({
          type: "status",
          payload: { message: `SOP 推进到 ${nextStage}。${skillSuggestion}` },
        })
        break // Only advance once per turn
      }
    }
  }
}
