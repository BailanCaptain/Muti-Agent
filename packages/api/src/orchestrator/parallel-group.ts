import type { Provider } from "@multi-agent/shared"

export type ParallelGroup = {
  id: string
  parentMessageId: string
  originatorAgentId: string
  originatorProvider: Provider
  pendingProviders: Set<Provider>
  completedResults: Map<Provider, { messageId: string; content: string }>
  joinBehavior: "notify_originator" | "silent"
  createdAt: string
}

export class ParallelGroupRegistry {
  private readonly groups = new Map<string, ParallelGroup>()

  create(options: {
    parentMessageId: string
    originatorAgentId: string
    originatorProvider: Provider
    targetProviders: Provider[]
    joinBehavior: "notify_originator" | "silent"
  }): ParallelGroup {
    const id = crypto.randomUUID()
    const group: ParallelGroup = {
      id,
      parentMessageId: options.parentMessageId,
      originatorAgentId: options.originatorAgentId,
      originatorProvider: options.originatorProvider,
      pendingProviders: new Set(options.targetProviders),
      completedResults: new Map(),
      joinBehavior: options.joinBehavior,
      createdAt: new Date().toISOString(),
    }
    this.groups.set(id, group)
    return group
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
    group.completedResults.set(provider, result)
    group.pendingProviders.delete(provider)
    return { allDone: group.pendingProviders.size === 0, group }
  }

  get(groupId: string): ParallelGroup | undefined {
    return this.groups.get(groupId)
  }

  remove(groupId: string): void {
    this.groups.delete(groupId)
  }
}
