import type { Provider } from "@multi-agent/shared"

export type ChainStarterTarget = {
  threadId: string
  provider: Provider
  alias: string
}

export type BoardEntryLite = {
  raisers: Array<{
    threadId: string
    raisedAt: string
    provider?: string
    alias?: string
  }>
}

export type ResolveInput = {
  sessionGroupId: string
  boardEntries: BoardEntryLite[]
}

type RepoLike = {
  listThreadsByGroup(sessionGroupId: string): Array<{
    id: string
    provider: string
    alias: string
    sessionGroupId: string
  }>
  listMessages(threadId: string): Array<{
    id: string
    role: string
    createdAt: string
    threadId: string
  }>
  getThread(threadId: string): { id: string; provider: string; alias: string } | null
}

export class ChainStarterResolver {
  constructor(private readonly repository: RepoLike) {}

  resolve(input: ResolveInput): ChainStarterTarget | null {
    const threads = this.repository.listThreadsByGroup(input.sessionGroupId)

    type Msg = { threadId: string; role: string; createdAt: string }
    const all: Msg[] = []
    for (const t of threads) {
      for (const m of this.repository.listMessages(t.id)) {
        all.push({ threadId: m.threadId, role: m.role, createdAt: m.createdAt })
      }
    }
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    let lastUserIdx = -1
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].role === "user") {
        lastUserIdx = i
        break
      }
    }

    if (lastUserIdx >= 0) {
      for (let i = lastUserIdx + 1; i < all.length; i++) {
        if (all[i].role === "assistant") {
          const starterThreadId = all[i].threadId
          const thread = threads.find((t) => t.id === starterThreadId)
          if (thread) {
            return {
              threadId: thread.id,
              provider: thread.provider as Provider,
              alias: thread.alias,
            }
          }
        }
      }
    }

    if (input.boardEntries.length === 0) return null

    let earliest: { threadId: string; raisedAt: string; provider?: string; alias?: string } | null =
      null
    for (const entry of input.boardEntries) {
      for (const r of entry.raisers) {
        if (!earliest || r.raisedAt.localeCompare(earliest.raisedAt) < 0) {
          earliest = r
        }
      }
    }
    if (!earliest) return null

    const thread =
      threads.find((t) => t.id === earliest!.threadId) ??
      this.repository.getThread(earliest.threadId)
    if (thread) {
      return {
        threadId: thread.id,
        provider: thread.provider as Provider,
        alias: thread.alias,
      }
    }

    return {
      threadId: earliest.threadId,
      provider: (earliest.provider ?? "unknown") as Provider,
      alias: earliest.alias ?? "unknown",
    }
  }
}
