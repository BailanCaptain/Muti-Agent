import test from "node:test"
import assert from "node:assert/strict"
import { ChainStarterResolver } from "./chain-starter-resolver"

function makeFakeRepo(
  messages: Array<{
    threadId: string
    role: "user" | "assistant"
    createdAt: string
    provider?: string
    alias?: string
  }>,
) {
  const threads = new Map<
    string,
    { id: string; provider: string; alias: string; sessionGroupId: string }
  >()
  for (const m of messages) {
    const existing = threads.get(m.threadId)
    if (!existing) {
      threads.set(m.threadId, {
        id: m.threadId,
        provider: m.provider ?? "claude",
        alias: m.alias ?? "unknown",
        sessionGroupId: "g1",
      })
    } else if (m.role === "assistant" && (m.alias || m.provider)) {
      existing.provider = m.provider ?? existing.provider
      existing.alias = m.alias ?? existing.alias
    }
  }

  return {
    listThreadsByGroup: (_sg: string) => Array.from(threads.values()),
    listMessages: (threadId: string) =>
      messages
        .filter((m) => m.threadId === threadId)
        .map((m) => ({
          id: `${m.threadId}-${m.createdAt}`,
          role: m.role,
          content: "",
          createdAt: m.createdAt,
          threadId: m.threadId,
        })),
    getThread: (id: string) => threads.get(id) ?? null,
  } as any
}

test("ChainStarterResolver returns first assistant after most recent user msg", () => {
  const repo = makeFakeRepo([
    { threadId: "t-claude", role: "user", createdAt: "2026-04-10T10:00:00Z" },
    {
      threadId: "t-claude",
      role: "assistant",
      createdAt: "2026-04-10T10:00:05Z",
      alias: "黄仁勋",
    },
    {
      threadId: "t-codex",
      role: "assistant",
      createdAt: "2026-04-10T10:00:15Z",
      alias: "范德彪",
    },
    {
      threadId: "t-claude",
      role: "assistant",
      createdAt: "2026-04-10T10:00:25Z",
      alias: "黄仁勋",
    },
  ])
  const resolver = new ChainStarterResolver(repo)
  const target = resolver.resolve({
    sessionGroupId: "g1",
    boardEntries: [
      { raisers: [{ threadId: "t-codex", raisedAt: "2026-04-10T10:00:15Z" }] },
    ],
  })
  assert.equal(target?.threadId, "t-claude")
  assert.equal(target?.alias, "黄仁勋")
})

test("ChainStarterResolver picks earliest assistant when multiple threads started simultaneously", () => {
  const repo = makeFakeRepo([
    { threadId: "root-user", role: "user", createdAt: "2026-04-10T10:00:00Z" },
    {
      threadId: "t-codex",
      role: "assistant",
      createdAt: "2026-04-10T10:00:10Z",
      alias: "范德彪",
    },
    {
      threadId: "t-gemini",
      role: "assistant",
      createdAt: "2026-04-10T10:00:12Z",
      alias: "桂芬",
    },
  ])
  const resolver = new ChainStarterResolver(repo)
  const target = resolver.resolve({
    sessionGroupId: "g1",
    boardEntries: [
      { raisers: [{ threadId: "t-gemini", raisedAt: "2026-04-10T10:00:12Z" }] },
    ],
  })
  assert.equal(target?.threadId, "t-codex")
})

test("ChainStarterResolver falls back to earliest raiser if no user trigger found", () => {
  const repo = makeFakeRepo([])
  const resolver = new ChainStarterResolver(repo)
  const target = resolver.resolve({
    sessionGroupId: "g1",
    boardEntries: [
      { raisers: [{ threadId: "t-codex", raisedAt: "2026-04-10T10:00:20Z" }] },
      { raisers: [{ threadId: "t-claude", raisedAt: "2026-04-10T10:00:10Z" }] },
    ],
  })
  assert.equal(target?.threadId, "t-claude")
})

test("ChainStarterResolver returns null when board empty and no messages", () => {
  const repo = makeFakeRepo([])
  const resolver = new ChainStarterResolver(repo)
  const target = resolver.resolve({ sessionGroupId: "g1", boardEntries: [] })
  assert.equal(target, null)
})
