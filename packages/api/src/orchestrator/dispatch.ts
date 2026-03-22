import type { Provider } from "@multi-agent/shared"
import type { SessionService } from "../services/session-service"
import { type MentionMatchMode, resolveMention, resolveMentions } from "./mention-router"

type InvocationContext = {
  rootMessageId: string
  sessionGroupId: string
  sourceProvider: Provider
}

type InvocationCanceller = {
  invalidateInvocation: (invocationId: string) => void
}

export type QueuedDispatch = {
  sessionGroupId: string
  rootMessageId: string
  sourceMessageId: string
  sourceProvider: Provider
  sourceAlias: string
  targetProvider: Provider
  targetAlias: string
  content: string
}

export type BlockedDispatch = {
  sessionGroupId: string
  rootMessageId: string
  sourceMessageId: string
  sourceProvider: Provider
  sourceAlias: string
  targetProvider: Provider
  targetAlias: string
  reason: "group_cancelled"
  content: string
}

export type EnqueueMentionsResult = {
  queued: QueuedDispatch[]
  blocked: BlockedDispatch[]
}

export class DispatchOrchestrator {
  private static readonly MAX_HOPS = 15

  private readonly messageRoots = new Map<string, string>()
  private readonly rootHopCounts = new Map<string, number>()
  private readonly rootTriggeredProviders = new Map<string, Set<Provider>>()
  private readonly invocationContexts = new Map<string, InvocationContext>()
  private readonly activeInvocations = new Map<string, Set<string>>()
  private readonly queues = new Map<string, QueuedDispatch[]>()
  private readonly cancelledSessionGroups = new Set<string>()

  constructor(
    private readonly sessions: SessionService,
    private readonly aliases: Record<Provider, string>,
    private readonly registry?: InvocationCanceller,
  ) {}

  resolveThread(threadId: string) {
    return this.sessions.findThread(threadId)
  }

  resolveMentionTarget(content: string) {
    return resolveMention(content, this.aliases)
  }

  registerUserRoot(messageId: string, sessionGroupId?: string) {
    this.messageRoots.set(messageId, messageId)
    this.rootHopCounts.set(messageId, 0)
    this.rootTriggeredProviders.set(messageId, new Set<Provider>())
    if (sessionGroupId) {
      this.cancelledSessionGroups.delete(sessionGroupId)
    }
    return messageId
  }

  attachMessageToRoot(messageId: string, rootMessageId: string) {
    this.messageRoots.set(messageId, rootMessageId)
  }

  bindInvocation(invocationId: string, context: InvocationContext) {
    this.invocationContexts.set(invocationId, context)
    const active = this.activeInvocations.get(context.sessionGroupId) ?? new Set<string>()
    active.add(invocationId)
    this.activeInvocations.set(context.sessionGroupId, active)
  }

  resolveInvocation(invocationId: string) {
    return this.invocationContexts.get(invocationId) ?? null
  }

  releaseInvocation(invocationId: string) {
    const context = this.invocationContexts.get(invocationId)
    if (context) {
      const active = this.activeInvocations.get(context.sessionGroupId)
      if (active) {
        active.delete(invocationId)
        if (active.size === 0) {
          this.activeInvocations.delete(context.sessionGroupId)
        }
      }
    }
    this.invocationContexts.delete(invocationId)
  }

  enqueuePublicMentions(options: {
    messageId: string
    sessionGroupId: string
    sourceProvider: Provider
    sourceAlias: string
    rootMessageId: string
    content: string
    matchMode?: MentionMatchMode
  }): EnqueueMentionsResult {
    const mentions = resolveMentions(options.content, this.aliases, options.matchMode)
    if (!mentions.length) {
      return { queued: [], blocked: [] }
    }

    if (this.cancelledSessionGroups.has(options.sessionGroupId)) {
      return {
        queued: [],
        blocked: mentions
          .filter((mention) => mention.provider !== options.sourceProvider)
          .map((mention) => ({
            sessionGroupId: options.sessionGroupId,
            rootMessageId: options.rootMessageId,
            sourceMessageId: options.messageId,
            sourceProvider: options.sourceProvider,
            sourceAlias: options.sourceAlias,
            targetProvider: mention.provider,
            targetAlias: mention.alias,
            reason: "group_cancelled",
            content: options.content,
          })),
      }
    }

    const alreadyTriggered =
      this.rootTriggeredProviders.get(options.rootMessageId) ?? new Set<Provider>()
    const currentHopCount = this.rootHopCounts.get(options.rootMessageId) ?? 0
    const remainingHops = Math.max(0, DispatchOrchestrator.MAX_HOPS - currentHopCount)
    if (remainingHops <= 0) {
      return { queued: [], blocked: [] }
    }

    const queued: QueuedDispatch[] = []
    const dedupedProviders = new Set<Provider>()

    for (const mention of mentions) {
      if (queued.length >= remainingHops) {
        break
      }

      if (mention.provider === options.sourceProvider) {
        continue
      }

      if (alreadyTriggered.has(mention.provider) || dedupedProviders.has(mention.provider)) {
        continue
      }

      const targetThread = this.sessions.findThreadByGroupAndProvider(
        options.sessionGroupId,
        mention.provider,
      )
      if (!targetThread) {
        continue
      }

      dedupedProviders.add(mention.provider)
      alreadyTriggered.add(mention.provider)

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
          `Read the shared room context and continue the collaboration as ${mention.alias}.`,
        ].join("\n"),
      })
    }

    if (!queued.length) {
      return { queued: [], blocked: [] }
    }

    this.rootTriggeredProviders.set(options.rootMessageId, alreadyTriggered)
    this.rootHopCounts.set(options.rootMessageId, currentHopCount + queued.length)

    const queue = this.queues.get(options.sessionGroupId) ?? []
    queue.push(...queued)
    this.queues.set(options.sessionGroupId, queue)

    return { queued, blocked: [] }
  }

  cancelSessionGroup(sessionGroupId: string) {
    const alreadyCancelled = this.cancelledSessionGroups.has(sessionGroupId)
    const queue = this.queues.get(sessionGroupId) ?? []
    this.cancelledSessionGroups.add(sessionGroupId)
    this.queues.delete(sessionGroupId)

    const active = this.activeInvocations.get(sessionGroupId)
    const cancelledActiveCount = active?.size ?? 0
    if (active && this.registry) {
      for (const invocationId of active) {
        this.registry.invalidateInvocation(invocationId)
      }
    }
    this.activeInvocations.delete(sessionGroupId)

    return {
      alreadyCancelled,
      clearedCount: queue.length,
      cancelledActiveCount,
    }
  }

  hasQueuedDispatches(sessionGroupId: string) {
    return (this.queues.get(sessionGroupId)?.length ?? 0) > 0
  }

  isSessionGroupCancelled(sessionGroupId: string) {
    return this.cancelledSessionGroups.has(sessionGroupId)
  }

  takeNextQueuedDispatch(sessionGroupId: string, runningThreadIds: Set<string>) {
    if (this.cancelledSessionGroups.has(sessionGroupId)) {
      return null
    }

    const groupThreads = this.sessions.listGroupThreads(sessionGroupId)
    const hasRunningThread = groupThreads.some((thread) => runningThreadIds.has(thread.id))
    if (hasRunningThread) {
      return null
    }

    const queue = this.queues.get(sessionGroupId)
    if (!queue?.length) {
      return null
    }

    const next = queue.shift() ?? null
    if (!queue.length) {
      this.queues.delete(sessionGroupId)
    }

    return next
  }
}
