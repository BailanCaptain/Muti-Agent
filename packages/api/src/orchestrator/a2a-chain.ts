import type { Provider } from "@multi-agent/shared"

export type A2AChainEntry = {
  invocationId: string
  threadId: string
  provider: Provider
  alias: string
  parentInvocationId: string | null
  rootMessageId: string
  sessionGroupId: string
  createdAt: number
  /**
   * F026 Phase 2 (ADR-004): upstream agent alias that triggered this
   * invocation — render-only field surfaced to the UI for the "A 正在征询 B"
   * lineage capsule. Optional for backward compatibility with legacy entries
   * and for top-level (no-parent) turns.
   */
  senderAlias?: string
  /**
   * F026 Phase 2 (ADR-004): the message id that triggered this invocation.
   * Render-only field; consumed by the frontend to anchor lineage navigation.
   * Optional — top-level turns have no trigger message.
   */
  triggerMessageId?: string
}

export class A2AChainRegistry {
  private readonly entries = new Map<string, A2AChainEntry>()

  register(entry: A2AChainEntry): void {
    this.entries.set(entry.invocationId, entry)
  }

  get(invocationId: string): A2AChainEntry | null {
    return this.entries.get(invocationId) ?? null
  }

  getParent(invocationId: string): A2AChainEntry | null {
    const child = this.entries.get(invocationId)
    if (!child || !child.parentInvocationId) return null
    return this.entries.get(child.parentInvocationId) ?? null
  }

  release(invocationId: string): void {
    this.entries.delete(invocationId)
  }
}
