import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import type { AppEventBus } from "../events/event-bus"
import type { ContextMessage } from "../orchestrator/context-snapshot"
import { buildContextSnapshot, extractTaskSnippet } from "../orchestrator/context-snapshot"
import type {
  DispatchOrchestrator,
  EnqueueMentionsResult,
  QueueEntry,
} from "../orchestrator/dispatch"
import type { InvocationRegistry } from "../orchestrator/invocation-registry"
import { ParallelGroupRegistry } from "../orchestrator/parallel-group"
import { runTurn } from "../runtime/cli-orchestrator"
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

  constructor(
    private readonly sessions: SessionService,
    private readonly dispatch: DispatchOrchestrator,
    private readonly invocations: InvocationRegistry<ActiveRun>,
    private readonly events: AppEventBus,
    private readonly apiBaseUrl: string,
  ) {}

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
    const enqueueResult = this.dispatch.enqueuePublicMentions({
      messageId: userMessage.id,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider,
      sourceAlias: thread.alias,
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
        }),
    })
    this.emitBlockedDispatches(enqueueResult, emit)

    // The user's message was sent to a specific thread — run that thread's turn concurrently with queued dispatches.
    const directTurn = this.runThreadTurn({
      threadId: thread.id,
      content: event.payload.content,
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
  }) {
    const thread = this.dispatch.resolveThread(options.threadId)
    if (!thread) {
      options.emit({
        type: "status",
        payload: { message: "未找到相关线程。" },
      })
      return
    }

    if (this.invocations.has(thread.id)) {
      options.emit({
        type: "status",
        payload: { message: `${thread.alias} 已经在运行中。` },
      })
      return
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

      this.emitThreadSnapshot(thread.sessionGroupId, options.emit)
      await this.flushDispatchQueue(thread.sessionGroupId, options.emit)
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
              await this.runThreadTurn({
                threadId,
                content: this.buildA2APrompt(entry),
                emit,
                rootMessageId: entry.rootMessageId,
                parentInvocationId: entry.parentInvocationId,
              })

              // P7 fix: check parallel group join on completion
              if (entry.parallelGroupId) {
                const thread = this.dispatch.resolveThread(threadId)
                const joinResult = this.parallelGroups.markCompleted(
                  entry.parallelGroupId,
                  entry.to.provider,
                  { messageId: "", content: thread?.alias ?? entry.to.agentId },
                )
                if (joinResult?.allDone && joinResult.group.joinBehavior === "notify_originator") {
                  const summaryParts = [...joinResult.group.completedResults.entries()].map(
                    ([, r]) => r.content,
                  )
                  emit({
                    type: "status",
                    payload: {
                      message: `并行 review 已全部完成（${summaryParts.join("、")}）。`,
                    },
                  })
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
    return [
      `[A2A 协作请求 from ${entry.from.agentId}]`,
      ``,
      `任务: ${entry.taskSnippet}`,
      ``,
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
}
