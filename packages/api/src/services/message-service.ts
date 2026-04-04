import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import type { AppEventBus } from "../events/event-bus"
import type { DispatchOrchestrator, EnqueueMentionsResult } from "../orchestrator/dispatch"
import type { InvocationRegistry } from "../orchestrator/invocation-registry"
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

    await this.runThreadTurn({
      threadId: thread.id,
      content: event.payload.content,
      emit,
      rootMessageId,
    })

    const enqueueResult = this.dispatch.enqueuePublicMentions({
      messageId: userMessage.id,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider,
      sourceAlias: thread.alias,
      rootMessageId,
      content: event.payload.content,
      matchMode: "anywhere",
    })
    this.emitBlockedDispatches(enqueueResult, emit)
    await this.flushDispatchQueue(thread.sessionGroupId, emit)
  }

  private async runThreadTurn(options: {
    threadId: string
    content: string
    emit: EmitEvent
    rootMessageId: string
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
      while (true) {
        const next = this.dispatch.takeNextQueuedDispatch(
          sessionGroupId,
          new Set(this.invocations.keys()),
        )
        if (!next) {
          return
        }

        const targetThread = this.sessions.findThreadByGroupAndProvider(
          sessionGroupId,
          next.targetProvider,
        )
        if (!targetThread) {
          continue
        }

        await this.runThreadTurn({
          threadId: targetThread.id,
          content: next.content,
          emit,
          rootMessageId: next.rootMessageId,
        })
      }
    } finally {
      this.flushingGroups.delete(sessionGroupId)
    }
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

  private getBusyStatus(threadId: string, sessionGroupId: string) {
    const runningThreadIds = new Set(this.invocations.keys())
    const runningThread = this.sessions
      .listGroupThreads(sessionGroupId)
      .find((candidate) => runningThreadIds.has(candidate.id))

    if (runningThread) {
      return runningThread.id === threadId
        ? `${runningThread.alias} 已经在运行中。`
        : `${runningThread.alias} 已在此房间运行。请等待当前轮次结束或先手动停止。`
    }

    if (this.dispatch.hasQueuedDispatches(sessionGroupId)) {
      return "此房间仍在处理队列中的跟进任务。请等待当前协作链完成。"
    }

    return null
  }
}
