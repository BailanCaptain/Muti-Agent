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

  /** F040 P2 T14（AC13.5 Leg B）：同 root 链上的登记条目（活性由调用方结合 invocation registry 判）。 */
  listByRoot(rootMessageId: string): A2AChainEntry[] {
    const out: A2AChainEntry[] = []
    for (const entry of this.entries.values()) {
      if (entry.rootMessageId === rootMessageId) out.push(entry)
    }
    return out
  }
}

/**
 * F040 AC13.5 Leg B 判定核（纯函数，message-service 组装活性谓词后调用）：
 * 条目中是否存在起笔不晚于 beforeMs 且仍在飞的 turn。
 * 同毫秒平局用 `<=` 保守阻塞（德彪 P2 审 P2-2）：registration ms 粒度无 rowid 可比，
 * 宁等勿乱序——被阻行由对方 settle 的 rescan 或 60s sweeper 释放，不会饿死。
 * excludeInvocationId=本次结束的 invocation 自排除（isFinalEmitted 应已置位，
 * 但不赌 mark/emit 时序，双保险防「自己阻塞自己 60s」）。
 */
export function hasEarlierAliveEntry(
  entries: A2AChainEntry[],
  beforeMs: number,
  isAlive: (invocationId: string) => boolean,
  excludeInvocationId?: string,
): boolean {
  return entries.some(
    (e) =>
      e.invocationId !== excludeInvocationId && e.createdAt <= beforeMs && isAlive(e.invocationId),
  )
}
