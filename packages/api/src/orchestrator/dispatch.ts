import crypto from "node:crypto"
import type { Provider } from "@multi-agent/shared"
import type { ContextMessage } from "./context-snapshot"
import type { SessionService } from "../services/session-service"
import {
  type MentionMatchMode,
  type ProviderAliases,
  resolveMention,
  resolveMentions,
} from "./mention-router"

export type { ContextMessage } from "./context-snapshot"

export type InvocationContext = {
  rootMessageId: string
  sessionGroupId: string
  sourceProvider: Provider
  parentInvocationId: string | null
}

type InvocationCanceller = {
  invalidateInvocation: (invocationId: string) => void
}

export type QueueEntry = {
  id: string
  sessionGroupId: string
  rootMessageId: string
  from: {
    agentId: string
    messageId: string
    provider: Provider
  }
  to: {
    agentId: string
    provider: Provider
  }
  taskSnippet: string
  contextSnapshot: ContextMessage[]
  parentInvocationId: string | null
  hopIndex: number
  parallelGroupId: string | null
}

export type BlockedDispatch = {
  sessionGroupId: string
  rootMessageId: string
  from: { agentId: string; messageId: string; provider: Provider }
  to: { agentId: string; provider: Provider }
  reason: "group_cancelled" | "max_hops" | "dedup"
  taskSnippet: string
}

export type EnqueueMentionsResult = {
  queued: QueueEntry[]
  blocked: BlockedDispatch[]
}

export class DispatchOrchestrator {
  private static readonly MAX_HOPS = 15

  private readonly messageRoots = new Map<string, string>()
  private readonly rootHopCounts = new Map<string, number>()
  private readonly invocationTriggered = new Map<string, Set<Provider>>()
  private readonly invocationContexts = new Map<string, InvocationContext>()
  private readonly activeInvocations = new Map<string, Set<string>>()
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly cancelledSessionGroups = new Set<string>()
  private readonly runningSlots = new Map<string, Set<Provider>>()

  constructor(
    private readonly sessions: SessionService,
    private readonly aliases: ProviderAliases,
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
    // P4 fix: clean up invocation-scoped dedup entry to prevent memory leak
    this.invocationTriggered.delete(invocationId)
    this.invocationContexts.delete(invocationId)
  }

  acquireSlot(sessionGroupId: string, provider: Provider): boolean {
    const slots = this.runningSlots.get(sessionGroupId) ?? new Set<Provider>()
    if (slots.has(provider)) return false
    slots.add(provider)
    this.runningSlots.set(sessionGroupId, slots)
    return true
  }

  releaseSlot(sessionGroupId: string, provider: Provider): void {
    const slots = this.runningSlots.get(sessionGroupId)
    if (!slots) return
    slots.delete(provider)
    if (slots.size === 0) {
      this.runningSlots.delete(sessionGroupId)
    }
  }

  isSlotBusy(sessionGroupId: string, provider: Provider): boolean {
    return this.runningSlots.get(sessionGroupId)?.has(provider) ?? false
  }

  getAgentStatuses(sessionGroupId: string): Array<{ agentId: string; provider: Provider; running: boolean; queueDepth: number }> {
    const queue = this.queues.get(sessionGroupId) ?? []
    const queueCounts = new Map<Provider, number>()
    for (const entry of queue) {
      queueCounts.set(entry.to.provider, (queueCounts.get(entry.to.provider) ?? 0) + 1)
    }

    return (Object.entries(this.aliases) as Array<[Provider, string]>).map(
      ([provider, alias]) => {
        const agentId = alias.startsWith("@") ? alias.slice(1) : alias
        return {
          agentId,
          provider,
          running: this.isSlotBusy(sessionGroupId, provider),
          queueDepth: queueCounts.get(provider) ?? 0,
        }
      },
    )
  }

  enqueuePublicMentions(options: {
    messageId: string
    sessionGroupId: string
    sourceProvider: Provider
    sourceAlias: string
    rootMessageId: string
    content: string
    matchMode?: MentionMatchMode
    parentInvocationId?: string | null
    buildSnapshot?: () => ContextMessage[]
    extractSnippet?: (content: string, targetAlias: string) => string
    createParallelGroup?: (targetProviders: Provider[]) => { id: string }
  }): EnqueueMentionsResult {
    const mentions = resolveMentions(options.content, this.aliases, options.matchMode)
    if (!mentions.length) {
      return { queued: [], blocked: [] }
    }

    const extractSnippet = options.extractSnippet ?? ((c: string, _alias: string) => c.slice(0, 200))

    if (this.cancelledSessionGroups.has(options.sessionGroupId)) {
      const userInitiatedFanOut = options.sourceAlias === "user" && mentions.length >= 2
      return {
        queued: [],
        blocked: mentions
          .filter((mention) => userInitiatedFanOut || mention.provider !== options.sourceProvider)
          .map((mention) => ({
            sessionGroupId: options.sessionGroupId,
            rootMessageId: options.rootMessageId,
            from: {
              agentId: options.sourceAlias,
              messageId: options.messageId,
              provider: options.sourceProvider,
            },
            to: {
              agentId: mention.alias,
              provider: mention.provider,
            },
            reason: "group_cancelled" as const,
            taskSnippet: extractSnippet(options.content, mention.alias),
          })),
      }
    }

    const dedupKey = options.parentInvocationId ?? options.rootMessageId
    const alreadyTriggered =
      this.invocationTriggered.get(dedupKey) ?? new Set<Provider>()
    const currentHopCount = this.rootHopCounts.get(options.rootMessageId) ?? 0
    const remainingHops = Math.max(0, DispatchOrchestrator.MAX_HOPS - currentHopCount)
    if (remainingHops <= 0) {
      return { queued: [], blocked: [] }
    }

    const queued: QueueEntry[] = []
    const dedupedProviders = new Set<Provider>()
    const buildSnapshot = options.buildSnapshot ?? (() => [])
    const parentInvocationId = options.parentInvocationId ?? null

    // User-initiated multi-mention: if user @s the panel agent among 2+ targets,
    // enqueue the panel agent too so it joins the parallel group. The caller
    // must then skip directTurn for that provider (queueFlush handles it).
    // Agent-initiated or user single-@: keep skipping sourceProvider.
    const userInitiatedFanOut = options.sourceAlias === "user" && mentions.length >= 2

    for (const mention of mentions) {
      if (queued.length >= remainingHops) {
        break
      }

      if (mention.provider === options.sourceProvider && !userInitiatedFanOut) {
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
        id: crypto.randomUUID(),
        sessionGroupId: options.sessionGroupId,
        rootMessageId: options.rootMessageId,
        from: {
          agentId: options.sourceAlias,
          messageId: options.messageId,
          provider: options.sourceProvider,
        },
        to: {
          agentId: mention.alias,
          provider: mention.provider,
        },
        taskSnippet: extractSnippet(options.content, mention.alias),
        contextSnapshot: buildSnapshot(),
        parentInvocationId,
        hopIndex: currentHopCount + queued.length,
        parallelGroupId: null,
      })
    }

    if (!queued.length) {
      return { queued: [], blocked: [] }
    }

    // Fan-out detection: if single message mentions 2+ providers, create a parallel group
    if (queued.length >= 2 && options.createParallelGroup) {
      const group = options.createParallelGroup(queued.map((e) => e.to.provider))
      for (const entry of queued) {
        entry.parallelGroupId = group.id
      }
    }

    this.invocationTriggered.set(dedupKey, alreadyTriggered)
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

  takeNextQueuedDispatch(sessionGroupId: string): QueueEntry | null {
    if (this.cancelledSessionGroups.has(sessionGroupId)) {
      return null
    }

    const queue = this.queues.get(sessionGroupId)
    if (!queue?.length) {
      return null
    }

    for (let i = 0; i < queue.length; i++) {
      if (!this.isSlotBusy(sessionGroupId, queue[i].to.provider)) {
        const [entry] = queue.splice(i, 1)
        if (!queue.length) {
          this.queues.delete(sessionGroupId)
        }
        return entry
      }
    }

    return null // all targets are busy
  }
}
