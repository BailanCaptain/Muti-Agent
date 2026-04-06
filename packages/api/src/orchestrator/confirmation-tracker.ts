import type { PendingConfirmationItem } from "@multi-agent/shared"

/**
 * Tracks pending confirmation items at the session-group level.
 * Items raised by agents that haven't been resolved by the user
 * are carried forward across phases and surfaced before dev begins.
 */
export class ConfirmationTracker {
  private readonly items = new Map<string, PendingConfirmationItem[]>()

  /**
   * Add a pending confirmation for a session group.
   */
  add(
    sessionGroupId: string,
    item: Omit<PendingConfirmationItem, "id" | "createdAt">,
  ): PendingConfirmationItem {
    const full: PendingConfirmationItem = {
      ...item,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    const list = this.items.get(sessionGroupId) ?? []
    list.push(full)
    this.items.set(sessionGroupId, list)
    return full
  }

  /**
   * Resolve a specific confirmation.
   */
  resolve(
    sessionGroupId: string,
    confirmationId: string,
    resolution: { resolvedBy: "user" | "consensus"; resolution: string },
  ): boolean {
    const list = this.items.get(sessionGroupId)
    if (!list) return false
    const item = list.find(i => i.id === confirmationId)
    if (!item || item.status !== "pending") return false
    item.status = "resolved"
    item.resolvedBy = resolution.resolvedBy
    item.resolution = resolution.resolution
    return true
  }

  /**
   * Mark a confirmation as deferred (user skipped it).
   */
  defer(sessionGroupId: string, confirmationId: string): boolean {
    const list = this.items.get(sessionGroupId)
    if (!list) return false
    const item = list.find(i => i.id === confirmationId)
    if (!item || item.status !== "pending") return false
    item.status = "deferred"
    return true
  }

  /**
   * Get all unresolved items for a session group.
   */
  getUnresolved(sessionGroupId: string): PendingConfirmationItem[] {
    return (this.items.get(sessionGroupId) ?? []).filter(i => i.status === "pending")
  }

  /**
   * Get all deferred items for a session group.
   */
  getDeferred(sessionGroupId: string): PendingConfirmationItem[] {
    return (this.items.get(sessionGroupId) ?? []).filter(i => i.status === "deferred")
  }

  /**
   * Get all items (any status) for a session group.
   */
  getAll(sessionGroupId: string): PendingConfirmationItem[] {
    return this.items.get(sessionGroupId) ?? []
  }

  /**
   * Import items from a parallel group (after Phase 2 ends).
   */
  importFromPhase(sessionGroupId: string, items: PendingConfirmationItem[]): void {
    const list = this.items.get(sessionGroupId) ?? []
    for (const item of items) {
      if (!list.some(existing => existing.id === item.id)) {
        list.push(item)
      }
    }
    this.items.set(sessionGroupId, list)
  }
}
