import crypto from "node:crypto"
import type { Provider } from "@multi-agent/shared"
import type { SessionService } from "../services/session-service"
import type { ContextMessage } from "./context-snapshot"
import {
  type MentionMatchMode,
  type MentionSourceRole,
  type ProviderAliases,
  resolveCallTagMentions,
  resolveMention,
  resolveMentions,
} from "./mention-router"

/**
 * F026 · A2A gateway hook contract.
 *
 * When a hook is registered via `setA2AGatewayHook()`, dispatch delegates
 * mention resolution to the hook (3-layer mention router + on-behalf
 * inference + rate-limit + `call-registry.openCall` → envelope). Without
 * an installed hook, dispatch falls back to the classic regex-based
 * `resolveMentions` path (回归基线保护)。
 */
export interface A2AGatewayPlanInput {
  sourceAgentId: string
  sourceReplyTo: string
  messageId: string
  content: string
  sessionGroupId: string
  parentInvocationId: string | null
  /**
   * F026 acceptance-guardian R-204 · parent invocation 处理过的 dispatchedCallId,
   * 由 dispatch.enqueuePublicMentions 从 invocationContexts 反查后传入,
   * a2a-gateway-bootstrap 直接桥接到 openCall.parentCallId, 接通 call tree。
   */
  parentCallId: string | null
  /** F026 方案 X · "assistant" → 仅识别 [Call:] tag；"user"/未传 → 现有路径 */
  sourceRole?: MentionSourceRole
}

export interface A2AGatewayPlanResult {
  mentions: Array<{
    provider: Provider
    alias: string
    callId: string
    /**
     * F027 P4-A3 fallback j2 P1 修 (V16.5 §M1 line 422-431)：
     * handoffContext 由 F026 EnvelopeBuilder 在 dispatch 派发时 derive，**调用方不手填**。
     * receiverAlias = envelope.protocol.on_behalf_of ?? envelope.protocol.convener_id ?? mention.alias
     *   （on-behalf 反推按 ADR-003 — convenerTransfer 时 convenerId 已是 on_behalf_of，
     *    无 convenerTransfer 时 on_behalf_of 单独存）
     * taskSummary = β path: envelope.task.input.source_message（agent 原文整段）
     *               γ path: envelope.task.task（cross-role-handoff skill 模板）
     */
    handoffContext?: { receiverAlias: string; taskSummary: string }
  }>
  blockedByGateway: Array<{ provider: Provider; alias: string; reason: string }>
}

export interface A2AGatewayHook {
  planMentions(input: A2AGatewayPlanInput): A2AGatewayPlanResult
}

export type { ContextMessage } from "./context-snapshot"

export type InvocationContext = {
  rootMessageId: string
  sessionGroupId: string
  sourceProvider: Provider
  parentInvocationId: string | null
  /**
   * F026 acceptance-guardian R-204 · 这个 invocation 正在处理的 a2a callId
   * (runThreadTurn options.dispatchedCallId 透传)。enqueuePublicMentions 反查它
   * 作为下游 mention 的 parentCallId 传给 gateway hook —— 接通 call tree。
   */
  dispatchedCallId?: string | null
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
  /**
   * F026 Phase 2 · callId from the A2A gateway when flag-on path is taken.
   * Undefined for legacy / flag-off dispatches.
   */
  callId?: string
  /**
   * F027 P4-A3 fallback j2 P1 修 (V16.5 §M1 line 422-431)：
   * handoffContext 由 F026 EnvelopeBuilder 在 dispatch 派发时自动填充（gateway 路径下来）。
   * message-service A2A caller 透传给 assemblePrompt.handoffContext，**不再 caller-side derive**。
   * undefined 时（gateway 关 / legacy fallback）caller 退到现有 buildA2AHandoffContext 简化路径。
   */
  handoffContext?: { receiverAlias: string; taskSummary: string }
}

export type BlockedDispatch = {
  sessionGroupId: string
  rootMessageId: string
  from: { agentId: string; messageId: string; provider: Provider }
  to: { agentId: string; provider: Provider }
  reason: "group_cancelled" | "max_hops" | "dedup"
  taskSnippet: string
}

export type GatewayBlocked = {
  provider: Provider
  alias: string
  reason: string
}

export type EnqueueMentionsResult = {
  queued: QueueEntry[]
  blocked: BlockedDispatch[]
  /**
   * F026 Phase 2 · gray-zone / rate-limit blocks from the A2A gateway
   * (hook path only). Surfaced for observability; dispatch itself takes no
   * further action on these entries.
   */
  blockedByGateway?: GatewayBlocked[]
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

  private a2aGateway?: A2AGatewayHook

  constructor(
    private readonly sessions: SessionService,
    private readonly aliases: ProviderAliases,
    private readonly registry?: InvocationCanceller,
  ) {}

  /**
   * F026 · install the A2A gateway hook. With a hook installed, subsequent
   * `enqueuePublicMentions` calls route mention resolution through it
   * (call-registry + envelope + rate-limit). Without an installed hook,
   * dispatch falls back to the classic regex path.
   */
  setA2AGatewayHook(hook: A2AGatewayHook): void {
    this.a2aGateway = hook
  }

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

  getAgentStatuses(
    sessionGroupId: string,
  ): Array<{ agentId: string; provider: Provider; running: boolean; queueDepth: number }> {
    const queue = this.queues.get(sessionGroupId) ?? []
    const queueCounts = new Map<Provider, number>()
    for (const entry of queue) {
      queueCounts.set(entry.to.provider, (queueCounts.get(entry.to.provider) ?? 0) + 1)
    }

    return (Object.entries(this.aliases) as Array<[Provider, string]>).map(([provider, alias]) => {
      const agentId = alias.startsWith("@") ? alias.slice(1) : alias
      return {
        agentId,
        provider,
        running: this.isSlotBusy(sessionGroupId, provider),
        queueDepth: queueCounts.get(provider) ?? 0,
      }
    })
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
    /**
     * F026 R-204 follow-up · caller 显式透传当前 invocation 处理的 callId,
     * 绕开 invocationContexts 反查（final flow 在 releaseInvocation 之后才派发,
     * 反查必拿到 undefined → null parent → 子 a2a_calls 全 orphan root）。
     * 当 explicit param 缺省时回落到反查（callbacks progress 路径仍然 work）。
     */
    parentCallId?: string | null
    buildSnapshot?: () => ContextMessage[]
    extractSnippet?: (content: string, targetAlias: string) => string
  }): EnqueueMentionsResult {
    // F026 · gateway path. With hook installed, delegate mention resolution
    // to the gateway (3-layer mention router + on-behalf + rate-limit +
    // call-registry.openCall). Downstream dedup/hop/slot constraints still
    // apply — gateway is upstream filter, not a bypass. Without a hook,
    // fall back to classic regex path.
    const useGateway = this.a2aGateway !== undefined
    // F026 方案 X · 双契约 source role 推断：sourceAlias === "user" → user 路径
    // （保持现有 line-start/anywhere 行为）；其他值（agent alias）→ assistant 路径
    // （只识别 [Call: @X 描述] tag，自由文本 @ 不派发）。
    const sourceRole: MentionSourceRole = options.sourceAlias === "user" ? "user" : "assistant"
    let mentions: Array<{ provider: Provider; alias: string }>
    let gatewayCallIds: Map<Provider, string> | undefined
    let gatewayHandoffContexts:
      | Map<Provider, { receiverAlias: string; taskSummary: string }>
      | undefined
    let blockedByGateway: GatewayBlocked[] | undefined

    if (useGateway) {
      // F026 R-204 follow-up · 桥接 parentCallId 优先级：
      //   ① caller 显式 options.parentCallId（final flow / return-path 用，绕 release 时序）
      //   ② invocationContexts 反查（callbacks progress 路径用，invocation 还活着）
      //   ③ null（user 直派 / classic path / 都没有时的 root call）
      //
      // 历史 bug (R-204 commit 4614c13)：只实现 ② 反查，但 message-service final flow
      // 在 releaseInvocation 之后 200 行才调 enqueuePublicMentions，反查必空 → 0/275
      // a2a_calls.parent_call_id 真接通。本次加 ① 显式参数绕开时序敏感。
      const parentContext = options.parentInvocationId
        ? this.invocationContexts.get(options.parentInvocationId)
        : null
      const parentCallId =
        options.parentCallId ?? parentContext?.dispatchedCallId ?? null

      const plan = this.a2aGateway!.planMentions({
        sourceAgentId: options.sourceAlias,
        sourceReplyTo: `${options.sourceProvider}:${options.sourceAlias}`,
        messageId: options.messageId,
        content: options.content,
        sessionGroupId: options.sessionGroupId,
        parentInvocationId: options.parentInvocationId ?? null,
        parentCallId,
        sourceRole,
      })
      mentions = plan.mentions.map((m) => ({ provider: m.provider, alias: m.alias }))
      gatewayCallIds = new Map(plan.mentions.map((m) => [m.provider, m.callId]))
      // F027 P4-A3 fallback j2 P1 修 — 从 gateway 透 handoffContext 进 entry（V16.5 §M1）
      gatewayHandoffContexts = new Map(
        plan.mentions
          .filter((m) => m.handoffContext !== undefined)
          .map((m) => [m.provider, m.handoffContext as { receiverAlias: string; taskSummary: string }]),
      )
      if (plan.blockedByGateway.length > 0) {
        blockedByGateway = plan.blockedByGateway
      }
    } else if (sourceRole === "assistant") {
      // F026 方案 X · gateway 关 / hook 未装时 fallback：assistant 仍走 [Call:] 强契约
      // 而非旧 line-start，保证 dev / preview 行为一致（worktree preview 默认 ON gateway）。
      const tags = resolveCallTagMentions(options.content, this.aliases)
      mentions = tags.map((t) => ({ provider: t.provider, alias: t.alias }))
    } else {
      mentions = resolveMentions(options.content, this.aliases, options.matchMode)
    }

    if (!mentions.length) {
      const empty: EnqueueMentionsResult = { queued: [], blocked: [] }
      if (blockedByGateway) empty.blockedByGateway = blockedByGateway
      return empty
    }

    const extractSnippet =
      options.extractSnippet ?? ((c: string, _alias: string) => c.slice(0, 200))

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
    const alreadyTriggered = this.invocationTriggered.get(dedupKey) ?? new Set<Provider>()
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
        callId: gatewayCallIds?.get(mention.provider),
        // F027 P4-A3 fallback j2 P1 修 (V16.5 §M1)
        handoffContext: gatewayHandoffContexts?.get(mention.provider),
      })
    }

    if (!queued.length) {
      const empty: EnqueueMentionsResult = { queued: [], blocked: [] }
      if (blockedByGateway) empty.blockedByGateway = blockedByGateway
      return empty
    }

    // F026 P2 clean-cut · 多 @ 路径不再 fan-out 进 ParallelGroup 状态机：
    // 每个 mention 是独立 QueueEntry，独立 callId（gateway 路径），独立
    // worklist 续推。"all done" 由 worklist registry + SettlementDetector
    // 接管。

    this.invocationTriggered.set(dedupKey, alreadyTriggered)
    this.rootHopCounts.set(options.rootMessageId, currentHopCount + queued.length)

    const queue = this.queues.get(options.sessionGroupId) ?? []
    queue.push(...queued)
    this.queues.set(options.sessionGroupId, queue)

    const result: EnqueueMentionsResult = { queued, blocked: [] }
    if (blockedByGateway) result.blockedByGateway = blockedByGateway
    return result
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

  clearProviderQueue(sessionGroupId: string, provider: Provider): number {
    const queue = this.queues.get(sessionGroupId)
    if (!queue) return 0
    const before = queue.length
    const filtered = queue.filter((e) => e.to.provider !== provider)
    if (filtered.length === 0) {
      this.queues.delete(sessionGroupId)
    } else {
      this.queues.set(sessionGroupId, filtered)
    }
    return before - filtered.length
  }

  hasQueuedDispatches(sessionGroupId: string) {
    return (this.queues.get(sessionGroupId)?.length ?? 0) > 0
  }

  isSessionGroupCancelled(sessionGroupId: string) {
    return this.cancelledSessionGroups.has(sessionGroupId)
  }

  takeNextQueuedDispatch(
    sessionGroupId: string,
    opts?: { isProviderBusy?: (provider: Provider) => boolean },
  ): QueueEntry | null {
    if (this.cancelledSessionGroups.has(sessionGroupId)) {
      return null
    }

    const queue = this.queues.get(sessionGroupId)
    if (!queue?.length) {
      return null
    }

    // F026 P0 silent-drop fix (R-013 场景5): isProviderBusy 让调用方注入 invocations.has
    // 这层 busy 信号。entry 被 take 出后若发现 thread 已有 active invocation，runThreadTurn
    // 在 message-service.ts:817 会 silently return null —— entry 永久丢失。
    // 把这层判定提前到 take 这一步，busy 时 entry 留在 queue，等 invocation 结束自然回到
    // flushDispatchQueue 重新尝试。
    for (let i = 0; i < queue.length; i++) {
      const provider = queue[i].to.provider
      if (this.isSlotBusy(sessionGroupId, provider)) continue
      if (opts?.isProviderBusy?.(provider)) continue
      const [entry] = queue.splice(i, 1)
      if (!queue.length) {
        this.queues.delete(sessionGroupId)
      }
      return entry
    }

    return null // all targets are busy
  }
}
