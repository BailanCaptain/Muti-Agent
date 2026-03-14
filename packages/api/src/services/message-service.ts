import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared";
import type { AppEventBus } from "../events/event-bus";
import type { DispatchOrchestrator } from "../orchestrator/dispatch";
import type { InvocationRegistry } from "../orchestrator/invocation-registry";
import { runTurn } from "../runtime/cli-orchestrator";
import type { SessionService } from "./session-service";

type ActiveRun = ReturnType<typeof runTurn>;
type EmitEvent = (event: RealtimeServerEvent) => void;

export class MessageService {
  // 防止同一个 session group 被并发 flush，导致下一跳重复拉起。
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

    // agent 的公开消息也要挂到当前 root 上，这样 A2A 路由才能沿着同一条链继续传播。
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
    // 先写一个 assistant 占位消息，前端后续收到 delta 时就知道该往哪条消息上追加。
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

    // invocation 是“这一次真实运行”的身份，不等同于 thread 或 session。
    const identity = this.invocations.createInvocation(thread.id, thread.alias);
    this.dispatch.bindInvocation(identity.invocationId, {
      rootMessageId: options.rootMessageId,
      sessionGroupId: thread.sessionGroupId,
      sourceProvider: thread.provider
    });

    const startedAt = new Date().toISOString();

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
      type: "thread_snapshot",
      payload: {
        activeGroup: this.sessions.getActiveGroup(thread.sessionGroupId, new Set(this.invocations.keys()))
      }
    });

    options.emit({
      type: "status",
      payload: { message: `Running ${thread.alias}` }
    });

    const run = runTurn({
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
        // stdout 更像在正式回复，stderr 更像 thinking / tool 过程；两者都算活跃。
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
      }
    });

    this.invocations.attachRun(thread.id, identity.invocationId, run);

    try {
      const result = await run.promise;
      this.invocations.invalidateInvocation(identity.invocationId);
      this.dispatch.releaseInvocation(identity.invocationId);
      this.sessions.updateThread(thread.id, result.currentModel, result.nativeSessionId);
      this.sessions.overwriteMessage(assistant.id, result.content || "[empty response]");

      this.events.emit({
        type: "invocation.finished",
        invocationId: identity.invocationId,
        threadId: thread.id,
        agentId: thread.alias,
        status: "idle",
        exitCode: result.exitCode,
        createdAt: new Date().toISOString()
      });

      if (result.content.trim()) {
        // 普通 CLI 最终回复也被当成公开消息处理，这样 agent 文本里的 @ 也能触发下一跳。
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
        // 队列里拿出来的不是“原用户问题”，而是共享上下文下的下一跳任务。
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
