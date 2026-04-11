import type { PendingConfirmationItem, Provider } from "@multi-agent/shared"

// ── State machine ────────────────────────────────────────────────────

export type ParallelGroupStatus = "pending" | "running" | "partial" | "aggregating" | "done" | "timeout" | "failed"

const TERMINAL_STATES = new Set<ParallelGroupStatus>(["done", "timeout", "failed"])

const VALID_TRANSITIONS: ReadonlyMap<ParallelGroupStatus, ReadonlySet<ParallelGroupStatus>> =
  new Map([
    ["pending", new Set<ParallelGroupStatus>(["running", "failed"])],
    ["running", new Set<ParallelGroupStatus>(["partial", "aggregating", "done", "timeout", "failed"])],
    ["partial", new Set<ParallelGroupStatus>(["aggregating", "done", "timeout"])],
    ["aggregating", new Set<ParallelGroupStatus>(["done", "failed"])],
    ["done", new Set<ParallelGroupStatus>()],
    ["timeout", new Set<ParallelGroupStatus>()],
    ["failed", new Set<ParallelGroupStatus>()],
  ])

export function isTerminal(status: ParallelGroupStatus): boolean {
  return TERMINAL_STATES.has(status)
}

export function isValidTransition(from: ParallelGroupStatus, to: ParallelGroupStatus): boolean {
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false
}

// ── Types ────────────────────────────────────────────────────────────

export type ParallelGroupInitiator = "user" | "agent"

export type Phase2Reply = {
  round: number
  provider: Provider
  messageId: string
  content: string
}

export type ParallelGroup = {
  id: string
  parentMessageId: string
  originatorAgentId: string
  originatorProvider: Provider
  /**
   * Session group this parallel group belongs to. Optional for older
   * call sites; populated by all production call sites in message-service
   * so SettlementDetector can scope "any active group" checks per session.
   */
  sessionGroupId: string
  callbackTo: Provider | null
  question: string | null
  initiatedBy: ParallelGroupInitiator
  participantProviders: Provider[]
  pendingProviders: Set<Provider>
  completedResults: Map<Provider, { messageId: string; content: string }>
  /**
   * Phase 2 (serial discussion) replies, appended in chronological order.
   * Order in participantProviders defines the per-round speaking order.
   * Agents that failed in a prior round are skipped in later rounds.
   */
  phase2Replies: Phase2Reply[]
  joinBehavior: "notify_originator" | "silent"
  status: ParallelGroupStatus
  timeoutMinutes: number
  timeoutTimer: ReturnType<typeof setTimeout> | null
  /** Unresolved confirmation items raised by agents across phases */
  pendingConfirmations: PendingConfirmationItem[]
  idempotencyKey: string | null
  createdAt: string
}

// ── Registry ─────────────────────────────────────────────────────────

export class ParallelGroupRegistry {
  private readonly groups = new Map<string, ParallelGroup>()
  private readonly idempotencyIndex = new Map<string, string>()

  create(options: {
    parentMessageId: string
    originatorAgentId: string
    originatorProvider: Provider
    targetProviders: Provider[]
    joinBehavior: "notify_originator" | "silent"
    callbackTo?: Provider
    question?: string
    timeoutMinutes?: number
    idempotencyKey?: string
    initiatedBy?: ParallelGroupInitiator
    sessionGroupId?: string
  }): ParallelGroup {
    if (options.idempotencyKey) {
      const existing = this.idempotencyIndex.get(options.idempotencyKey)
      if (existing) {
        const group = this.groups.get(existing)
        if (group) return group
      }
    }

    const id = crypto.randomUUID()
    const group: ParallelGroup = {
      id,
      parentMessageId: options.parentMessageId,
      originatorAgentId: options.originatorAgentId,
      originatorProvider: options.originatorProvider,
      sessionGroupId: options.sessionGroupId ?? "",
      callbackTo: options.callbackTo ?? null,
      question: options.question ?? null,
      initiatedBy: options.initiatedBy ?? "user",
      participantProviders: [...options.targetProviders],
      pendingProviders: new Set(options.targetProviders),
      completedResults: new Map(),
      phase2Replies: [],
      pendingConfirmations: [],
      joinBehavior: options.joinBehavior,
      status: "pending",
      timeoutMinutes: options.timeoutMinutes ?? 8,
      timeoutTimer: null,
      idempotencyKey: options.idempotencyKey ?? null,
      createdAt: new Date().toISOString(),
    }
    this.groups.set(id, group)

    if (options.idempotencyKey) {
      this.idempotencyIndex.set(options.idempotencyKey, id)
    }

    return group
  }

  start(groupId: string): void {
    this.transition(groupId, "running")
  }

  markCompleted(
    groupId: string,
    provider: Provider,
    result: { messageId: string; content: string },
  ): {
    allDone: boolean
    group: ParallelGroup
  } | null {
    const group = this.groups.get(groupId)
    if (!group) return null

    if (isTerminal(group.status)) return { allDone: true, group }

    if (group.completedResults.has(provider)) {
      return { allDone: group.pendingProviders.size === 0, group }
    }

    group.completedResults.set(provider, result)
    group.pendingProviders.delete(provider)

    if (group.pendingProviders.size === 0) {
      this.transition(groupId, group.initiatedBy === "user" ? "aggregating" : "done")
      this.clearTimeout(groupId)
    } else if (group.status === "running") {
      this.transition(groupId, "partial")
    }

    return { allDone: group.pendingProviders.size === 0, group }
  }

  /**
   * Append a Phase 2 (serial discussion) reply. Phase 2 runs AFTER the group
   * reaches terminal state (done/timeout), so this intentionally does not
   * touch the status machine — it's pure data accumulation.
   */
  addPhase2Reply(
    groupId: string,
    reply: Phase2Reply,
  ): ParallelGroup | null {
    const group = this.groups.get(groupId)
    if (!group) return null
    group.phase2Replies.push(reply)
    return group
  }

  markAggregationDone(groupId: string): void {
    const group = this.groups.get(groupId)
    if (!group) return
    if (group.status === "aggregating") {
      this.transition(groupId, "done")
    }
  }

  handleTimeout(groupId: string): void {
    const group = this.groups.get(groupId)
    if (!group) return
    if (isTerminal(group.status)) return

    for (const provider of group.pendingProviders) {
      group.completedResults.set(provider, {
        messageId: "",
        content: `[timeout: ${provider} 未在 ${group.timeoutMinutes} 分钟内响应]`,
      })
    }
    group.pendingProviders.clear()
    this.transition(groupId, "timeout")
  }

  handleFailure(groupId: string): void {
    const group = this.groups.get(groupId)
    if (!group) return
    if (isTerminal(group.status)) return
    this.transition(groupId, "failed")
    this.clearTimeout(groupId)
  }

  /**
   * True if any group scoped to the given sessionGroupId is still active
   * (pending, running, partial, or aggregating). Used by SettlementDetector
   * to decide whether to arm the Decision Board flush timer.
   */
  hasAnyActiveInSession(sessionGroupId: string): boolean {
    for (const group of this.groups.values()) {
      if (group.sessionGroupId !== sessionGroupId) continue
      if (!isTerminal(group.status)) return true
    }
    return false
  }

  /**
   * Anti-cascade: check if a provider is currently an active target
   * in any running/partial group for the given sessionGroupId.
   */
  isActiveTarget(provider: Provider): boolean {
    for (const group of this.groups.values()) {
      if (!isTerminal(group.status) && group.status !== "pending") {
        if (group.pendingProviders.has(provider)) return true
      }
    }
    return false
  }

  startTimeout(groupId: string, onTimeout: () => void): void {
    const group = this.groups.get(groupId)
    if (!group) return
    this.clearTimeout(groupId)
    group.timeoutTimer = setTimeout(onTimeout, group.timeoutMinutes * 60 * 1000)
  }

  get(groupId: string): ParallelGroup | undefined {
    return this.groups.get(groupId)
  }

  remove(groupId: string): void {
    this.clearTimeout(groupId)
    const group = this.groups.get(groupId)
    if (group?.idempotencyKey) {
      this.idempotencyIndex.delete(group.idempotencyKey)
    }
    this.groups.delete(groupId)
  }

  /**
   * Track a new pending confirmation item raised by an agent.
   */
  addPendingConfirmation(
    groupId: string,
    item: Omit<PendingConfirmationItem, "id" | "createdAt">,
  ): PendingConfirmationItem | null {
    const group = this.groups.get(groupId)
    if (!group) return null
    const full: PendingConfirmationItem = {
      ...item,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    group.pendingConfirmations.push(full)
    return full
  }

  /**
   * Resolve a pending confirmation (user selected or team consensus).
   */
  resolvePendingConfirmation(
    groupId: string,
    confirmationId: string,
    resolution: { resolvedBy: "user" | "consensus"; resolution: string; selectedIds?: string[] },
  ): boolean {
    const group = this.groups.get(groupId)
    if (!group) return false
    const item = group.pendingConfirmations.find(c => c.id === confirmationId)
    if (!item || item.status !== "pending") return false
    item.status = "resolved"
    item.resolvedBy = resolution.resolvedBy
    item.resolution = resolution.resolution
    return true
  }

  /**
   * Get all unresolved confirmations for a group.
   */
  getUnresolvedConfirmations(groupId: string): PendingConfirmationItem[] {
    const group = this.groups.get(groupId)
    if (!group) return []
    return group.pendingConfirmations.filter(c => c.status === "pending")
  }

  private clearTimeout(groupId: string): void {
    const group = this.groups.get(groupId)
    if (group?.timeoutTimer) {
      clearTimeout(group.timeoutTimer)
      group.timeoutTimer = null
    }
  }

  private transition(groupId: string, to: ParallelGroupStatus): void {
    const group = this.groups.get(groupId)
    if (!group) throw new Error(`ParallelGroup not found: ${groupId}`)

    if (!isValidTransition(group.status, to)) {
      throw new Error(`Invalid transition: ${group.status} → ${to}`)
    }
    group.status = to
  }
}
