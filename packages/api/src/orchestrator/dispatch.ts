import type { Provider } from "@multi-agent/shared";
import type { SessionService } from "../services/session-service";
import { resolveMention, resolveMentions } from "./mention-router";

type InvocationContext = {
  /** 这次 invocation 属于哪条用户根消息链。 */
  rootMessageId: string;
  /** 这次 invocation 所在的会话组。 */
  sessionGroupId: string;
  /** 是哪一个 provider 触发了当前这次运行。 */
  sourceProvider: Provider;
};

type QueuedDispatch = {
  /** 下一跳仍然属于同一个会话组。 */
  sessionGroupId: string;
  /** 继续沿用原来的 root，保证 hop 限制按同一条协作链计算。 */
  rootMessageId: string;
  /** 是哪条公开消息触发了这次下一跳。 */
  sourceMessageId: string;
  /** 触发方 provider。 */
  sourceProvider: Provider;
  /** 触发方别名。 */
  sourceAlias: string;
  /** 目标 provider，也就是下一只要被拉起的 agent。 */
  targetProvider: Provider;
  /** 目标 provider 的显示别名。 */
  targetAlias: string;
  /** 最终发送给下一跳 agent 的任务文本。 */
  content: string;
};

export class DispatchOrchestrator {
  private static readonly MAX_HOPS = 4;
  // messageId -> root user messageId，用来把同一轮协作链串起来
  private readonly messageRoots = new Map<string, string>();
  // rootMessageId -> 已经消耗了多少跳，防止 agent 无限互相 @
  private readonly rootHopCounts = new Map<string, number>();
  // messageId -> 这条公开消息已经触发过哪些 provider，防止重复触发
  private readonly messageTriggeredProviders = new Map<string, Set<Provider>>();
  // invocationId -> 当前运行属于哪条协作链
  private readonly invocationContexts = new Map<string, InvocationContext>();
  // sessionGroupId -> 等待执行的下一跳队列；第一版故意做成串行
  private readonly queues = new Map<string, QueuedDispatch[]>();

  constructor(private readonly sessions: SessionService, private readonly aliases: Record<Provider, string>) {}

  resolveThread(threadId: string) {
    return this.sessions.findThread(threadId);
  }

  resolveMentionTarget(content: string) {
    return resolveMention(content, this.aliases);
  }

  registerUserRoot(messageId: string) {
    this.messageRoots.set(messageId, messageId);
    this.rootHopCounts.set(messageId, 0);
    return messageId;
  }

  attachMessageToRoot(messageId: string, rootMessageId: string) {
    this.messageRoots.set(messageId, rootMessageId);
  }

  bindInvocation(invocationId: string, context: InvocationContext) {
    this.invocationContexts.set(invocationId, context);
  }

  resolveInvocation(invocationId: string) {
    return this.invocationContexts.get(invocationId) ?? null;
  }

  releaseInvocation(invocationId: string) {
    this.invocationContexts.delete(invocationId);
  }

  enqueuePublicMentions(options: {
    messageId: string;
    sessionGroupId: string;
    sourceProvider: Provider;
    sourceAlias: string;
    rootMessageId: string;
    content: string;
  }) {
    // 只对“公开消息”做 mention 解析；用户消息和 agent 主动 post_message 都会走到这里。
    const mentions = resolveMentions(options.content, this.aliases);
    if (!mentions.length) {
      return [];
    }

    const alreadyTriggered = this.messageTriggeredProviders.get(options.messageId) ?? new Set<Provider>();
    const currentHopCount = this.rootHopCounts.get(options.rootMessageId) ?? 0;
    const remainingHops = Math.max(0, DispatchOrchestrator.MAX_HOPS - currentHopCount);
    if (remainingHops <= 0) {
      return [];
    }

    const queued: QueuedDispatch[] = [];
    const dedupedProviders = new Set<Provider>();

    for (const mention of mentions) {
      // hop 预算在 root 维度上消耗，避免一条链无限扩散。
      if (queued.length >= remainingHops) {
        break;
      }

      if (mention.provider === options.sourceProvider) {
        continue;
      }

      if (alreadyTriggered.has(mention.provider) || dedupedProviders.has(mention.provider)) {
        continue;
      }

      const targetThread = this.sessions.findThreadByGroupAndProvider(options.sessionGroupId, mention.provider);
      if (!targetThread) {
        continue;
      }

      dedupedProviders.add(mention.provider);
      alreadyTriggered.add(mention.provider);

      queued.push({
        sessionGroupId: options.sessionGroupId,
        rootMessageId: options.rootMessageId,
        sourceMessageId: options.messageId,
        sourceProvider: options.sourceProvider,
        sourceAlias: options.sourceAlias,
        targetProvider: mention.provider,
        targetAlias: mention.alias,
        content: [
          `You were mentioned by ${options.sourceAlias} in the shared room.`,
          `Latest public message: ${options.content}`,
          `Read the shared room context and continue the collaboration as ${mention.alias}.`
        ].join("\n")
      });
    }

    if (!queued.length) {
      return [];
    }

    this.messageTriggeredProviders.set(options.messageId, alreadyTriggered);
    this.rootHopCounts.set(options.rootMessageId, currentHopCount + queued.length);

    const queue = this.queues.get(options.sessionGroupId) ?? [];
    queue.push(...queued);
    this.queues.set(options.sessionGroupId, queue);
    return queued;
  }

  takeNextQueuedDispatch(sessionGroupId: string, runningThreadIds: Set<string>) {
    const groupThreads = this.sessions.listGroupThreads(sessionGroupId);
    // 同一会话组内只做串行调度：只要还有 agent 在跑，就先不触发下一跳。
    const hasRunningThread = groupThreads.some((thread) => runningThreadIds.has(thread.id));
    if (hasRunningThread) {
      return null;
    }

    const queue = this.queues.get(sessionGroupId);
    if (!queue?.length) {
      return null;
    }

    const next = queue.shift() ?? null;
    if (!queue.length) {
      this.queues.delete(sessionGroupId);
    }

    return next;
  }
}
