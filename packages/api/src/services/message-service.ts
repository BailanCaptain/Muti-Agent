import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared";
import type { AppEventBus } from "../events/event-bus";
import type { DispatchOrchestrator } from "../orchestrator/dispatch";
import type { InvocationRegistry } from "../orchestrator/invocation-registry";
import { runTurn } from "../runtime/cli-orchestrator";
import type { SessionService } from "./session-service";

type ActiveRun = ReturnType<typeof runTurn>;
type EmitEvent = (event: RealtimeServerEvent) => void;

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

function extractPromptFromActivityChunk(chunk: string) {
  const lines = stripAnsi(chunk)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return null;
  }

  const promptLikeLines = lines.filter((line) => {
    if (line.length < 6) {
      return false;
    }

    if (
      /(please confirm|need your confirmation|awaiting your confirmation|do you want|would you like|should i|can you clarify|please provide|please choose|approval required|user input required)/i.test(
        line
      )
    ) {
      return true;
    }

    if (
      /(\u8bf7\u786e\u8ba4|\u9700\u8981\u4f60\u786e\u8ba4|\u9700\u8981\u786e\u8ba4|\u7b49\u5f85\u4f60\u7684\u786e\u8ba4|\u8bf7\u63d0\u4f9b|\u8bf7\u8865\u5145|\u8bf7\u9009\u62e9|\u8bf7\u95ee)/.test(
        line
      )
    ) {
      return true;
    }

    return /(?:\?|\uFF1F)$/.test(line);
  });

  if (!promptLikeLines.length) {
    return null;
  }

  return promptLikeLines.join("\n").slice(0, 1200);
}

export class MessageService {
  private readonly flushingGroups = new Set<string>();

  constructor(
    private readonly sessions: SessionService,
    private readonly dispatch: DispatchOrchestrator,
    private readonly invocations: InvocationRegistry<ActiveRun>,
    private readonly events: AppEventBus,
    private readonly apiBaseUrl: string
  ) {}

  handleClientEvent(event: RealtimeClientEvent, emit: EmitEvent) {
    if (event.type === "stop_thread") {
      this.invocations.get(event.payload.threadId)?.cancel();
      return;
    }

    void this.handleSendMessage(event, emit);
  }

  async handleAgentPublicMessage(options: {
    threadId: string;
    messageId: string;
    content: string;
    invocationId: string;
    emit: EmitEvent;
  }) {
    const thread = this.dispatch.resolveThread(options.threadId);
    if (!thread || !options.content.trim()) {
      return;
    }

    const invocation = this.dispatch.resolveInvocation(options.invocationId);
    if (!invocation) {
      return;
    }

    this.dispatch.attachMessageToRoot(options.messageId, invocation.rootMessageId);
    this.dispatch.enqueuePublicMentions({
      messageId: options.messageId,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider,
      sourceAlias: thread.alias,
      rootMessageId: invocation.rootMessageId,
      content: options.content
    });

    await this.flushDispatchQueue(thread.sessionGroupId, options.emit);
  }

  private async handleSendMessage(
    event: Extract<RealtimeClientEvent, { type: "send_message" }>,
    emit: EmitEvent
  ) {
    const thread = this.dispatch.resolveThread(event.payload.threadId);
    if (!thread) {
      emit({
        type: "status",
        payload: { message: "Thread not found." }
      });
      return;
    }

    const userMessage = this.sessions.appendUserMessage(thread.id, event.payload.content);
    // Every user turn starts a new root chain so direct replies and later A2A hops stay correlated.
    const rootMessageId = this.dispatch.registerUserRoot(userMessage.id);
    const userTimeline = this.sessions.toTimelineMessage(thread.id, userMessage.id);
    if (userTimeline) {
      emit({
        type: "message.created",
        payload: {
          threadId: thread.id,
          message: userTimeline
        }
      });
    }

    emit({
      type: "thread_snapshot",
      payload: {
        activeGroup: this.sessions.getActiveGroup(thread.sessionGroupId, new Set(this.invocations.keys()))
      }
    });

    await this.runThreadTurn({
      threadId: thread.id,
      content: event.payload.content,
      emit,
      historyMode: "thread",
      rootMessageId
    });

    this.dispatch.enqueuePublicMentions({
      messageId: userMessage.id,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider,
      sourceAlias: thread.alias,
      rootMessageId,
      content: event.payload.content
    });
    await this.flushDispatchQueue(thread.sessionGroupId, emit);
  }

  private async runThreadTurn(options: {
    threadId: string;
    content: string;
    emit: EmitEvent;
    historyMode: "thread" | "shared";
    rootMessageId: string;
  }) {
    const thread = this.dispatch.resolveThread(options.threadId);
    if (!thread) {
      options.emit({
        type: "status",
        payload: { message: "Thread not found." }
      });
      return;
    }

    if (this.invocations.has(thread.id)) {
      options.emit({
        type: "status",
        payload: { message: `${thread.alias} is already running.` }
      });
      return;
    }

    const history =
      options.historyMode === "shared"
        ? this.sessions.listSharedHistory(thread.sessionGroupId)
        : this.sessions.listHistory(thread.id);

    // The placeholder is created before the CLI starts so deltas always know which bubble to append into.
    const assistant = this.sessions.appendAssistantMessage(thread.id, "");
    this.dispatch.attachMessageToRoot(assistant.id, options.rootMessageId);
    const assistantTimeline = this.sessions.toTimelineMessage(thread.id, assistant.id);
    if (assistantTimeline) {
      options.emit({
        type: "message.created",
        payload: {
          threadId: thread.id,
          message: assistantTimeline
        }
      });
    }

    const identity = this.invocations.createInvocation(thread.id, thread.alias);
    this.dispatch.bindInvocation(identity.invocationId, {
      rootMessageId: options.rootMessageId,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider
    });

    const startedAt = new Date().toISOString();
    let promptRequestedByCli: string | null = null;
    let run: ActiveRun | null = null;

    this.events.emit({
      type: "invocation.started",
      invocationId: identity.invocationId,
      threadId: identity.threadId,
      agentId: identity.agentId,
      callbackToken: identity.callbackToken,
      status: "running",
      createdAt: startedAt
    });

    options.emit({
      type: "status",
      payload: { message: `Running ${thread.alias}` }
    });

    run = runTurn({
      invocationId: identity.invocationId,
      threadId: thread.id,
      provider: thread.provider,
      agentId: thread.alias,
      apiBaseUrl: this.apiBaseUrl,
      callbackToken: identity.callbackToken,
      model: thread.currentModel,
      nativeSessionId: thread.nativeSessionId,
      history,
      userMessage: options.content,
      onAssistantDelta: (delta: string) => {
        options.emit({
          type: "assistant_delta",
          payload: { messageId: assistant.id, delta }
        });
      },
      onSession: () => {},
      onModel: () => {},
      onActivity: (activity) => {
        this.events.emit({
          type: "invocation.activity",
          invocationId: identity.invocationId,
          threadId: thread.id,
          agentId: thread.alias,
          stream: activity.stream,
          chunk: activity.chunk,
          status: activity.stream === "stdout" ? "replying" : "thinking",
          createdAt: activity.at
        });

        if (promptRequestedByCli || activity.stream !== "stderr") {
          return;
        }

        // Some CLIs surface clarifications on stderr while waiting for the user; promote that into the timeline and stop.
        const prompt = extractPromptFromActivityChunk(activity.chunk);
        if (!prompt) {
          return;
        }

        promptRequestedByCli = prompt;
        this.sessions.overwriteMessage(assistant.id, prompt);
        options.emit({
          type: "status",
          payload: { message: `${thread.alias} needs your confirmation. The current run was paused, reply to continue.` }
        });
        options.emit({
          type: "thread_snapshot",
          payload: {
            activeGroup: this.sessions.getActiveGroup(thread.sessionGroupId, new Set(this.invocations.keys()))
          }
        });

        run?.cancel();
      }
    });

    this.invocations.attachRun(thread.id, identity.invocationId, run);

    options.emit({
      type: "thread_snapshot",
      payload: {
        activeGroup: this.sessions.getActiveGroup(thread.sessionGroupId, new Set(this.invocations.keys()))
      }
    });

    try {
      const result = await run.promise;
      this.invocations.invalidateInvocation(identity.invocationId);
      this.dispatch.releaseInvocation(identity.invocationId);
      this.sessions.updateThread(thread.id, result.currentModel, result.nativeSessionId);
      if (!promptRequestedByCli) {
        this.sessions.overwriteMessage(assistant.id, result.content || "[empty response]");
      }

      this.events.emit({
        type: "invocation.finished",
        invocationId: identity.invocationId,
        threadId: thread.id,
        agentId: thread.alias,
        status: "idle",
        exitCode: result.exitCode,
        createdAt: new Date().toISOString()
      });

      if (!promptRequestedByCli && result.content.trim()) {
        this.dispatch.enqueuePublicMentions({
          messageId: assistant.id,
          sessionGroupId: thread.sessionGroupId,
          sourceProvider: thread.provider,
          sourceAlias: thread.alias,
          rootMessageId: options.rootMessageId,
          content: result.content
        });
      }

      options.emit({
        type: "thread_snapshot",
        payload: {
          activeGroup: this.sessions.getActiveGroup(thread.sessionGroupId, new Set(this.invocations.keys()))
        }
      });

      await this.flushDispatchQueue(thread.sessionGroupId, options.emit);
    } catch (error) {
      this.invocations.invalidateInvocation(identity.invocationId);
      this.dispatch.releaseInvocation(identity.invocationId);
      const message = error instanceof Error ? error.message : "Unknown error";
      this.sessions.overwriteMessage(assistant.id, `Error: ${message}`);

      this.events.emit({
        type: "invocation.failed",
        invocationId: identity.invocationId,
        threadId: thread.id,
        agentId: thread.alias,
        status: "error",
        error: message,
        exitCode: null,
        createdAt: new Date().toISOString()
      });

      options.emit({
        type: "status",
        payload: { message }
      });

      options.emit({
        type: "thread_snapshot",
        payload: {
          activeGroup: this.sessions.getActiveGroup(thread.sessionGroupId, new Set(this.invocations.keys()))
        }
      });

      await this.flushDispatchQueue(thread.sessionGroupId, options.emit);
    }
  }

  private async flushDispatchQueue(sessionGroupId: string, emit: EmitEvent) {
    if (this.flushingGroups.has(sessionGroupId)) {
      return;
    }

    this.flushingGroups.add(sessionGroupId);

    try {
      while (true) {
        // A2A hops are serialized per session group so shared context evolves in a predictable order.
        const next = this.dispatch.takeNextQueuedDispatch(sessionGroupId, new Set(this.invocations.keys()));
        if (!next) {
          return;
        }

        const targetThread = this.sessions.findThreadByGroupAndProvider(sessionGroupId, next.targetProvider);
        if (!targetThread) {
          continue;
        }

        await this.runThreadTurn({
          threadId: targetThread.id,
          content: next.content,
          emit,
          historyMode: "shared",
          rootMessageId: next.rootMessageId
        });
      }
    } finally {
      this.flushingGroups.delete(sessionGroupId);
    }
  }
}
