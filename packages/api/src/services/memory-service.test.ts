import assert from "node:assert/strict"
import test from "node:test"
import { MemoryService } from "./memory-service"
import type { SessionMemoryRecord } from "../db/sqlite"

function createMockRepository(overrides: Record<string, unknown> = {}) {
  return {
    listThreadsByGroup: (_sessionGroupId: string) => [
      {
        id: "thread-1",
        sessionGroupId: "group-1",
        provider: "claude",
        alias: "Reviewer",
        currentModel: null,
        nativeSessionId: null,
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
      {
        id: "thread-2",
        sessionGroupId: "group-1",
        provider: "codex",
        alias: "Coder",
        currentModel: null,
        nativeSessionId: null,
        updatedAt: "2026-04-04T00:00:00.000Z",
      },
    ],
    listMessages: (threadId: string) => {
      if (threadId === "thread-1") {
        return [
          {
            id: "msg-1",
            threadId: "thread-1",
            role: "user",
            content: "please implement the memory feature for session",
            thinking: "",
            messageType: "final",
            createdAt: "2026-04-04T00:01:00.000Z",
          },
          {
            id: "msg-2",
            threadId: "thread-1",
            role: "assistant",
            content: "OK I will implement the memory feature with summary and keywords",
            thinking: "",
            messageType: "final",
            createdAt: "2026-04-04T00:02:00.000Z",
          },
        ]
      }
      if (threadId === "thread-2") {
        return [
          {
            id: "msg-3",
            threadId: "thread-2",
            role: "assistant",
            content: "the memory feature implementation is complete",
            thinking: "",
            messageType: "final",
            createdAt: "2026-04-04T00:03:00.000Z",
          },
        ]
      }
      return []
    },
    createMemory: (_sessionGroupId: string, summary: string, keywords: string): SessionMemoryRecord => ({
      id: "memory-1",
      sessionGroupId: _sessionGroupId,
      summary,
      keywords,
      createdAt: "2026-04-04T00:04:00.000Z",
    }),
    getLatestMemory: (_sessionGroupId: string): SessionMemoryRecord | null => null,
    searchMemories: (_keyword: string): SessionMemoryRecord[] => [],
    listMemories: (_sessionGroupId: string): SessionMemoryRecord[] => [],
    ...overrides,
  }
}

test("summarizeSession generates summary from messages", () => {
  const repo = createMockRepository()
  const service = new MemoryService(repo as never)

  const result = service.summarizeSession("group-1")

  assert.ok(result.summary.includes("[用户]"))
  assert.ok(result.summary.includes("[Reviewer]"))
  assert.ok(result.summary.includes("[Coder]"))
  assert.ok(result.summary.includes("memory"))
  // "memory" and "feature" appear in multiple messages, so they should be extracted
  assert.ok(result.keywords.includes("memory"))
  assert.ok(result.keywords.includes("feature"))
})

test("getLastSummary returns null when no memories exist", () => {
  const repo = createMockRepository({
    getLatestMemory: () => null,
  })
  const service = new MemoryService(repo as never)

  const result = service.getLastSummary("group-1")
  assert.equal(result, null)
})

test("getLastSummary returns summary when memory exists", () => {
  const repo = createMockRepository({
    getLatestMemory: (): SessionMemoryRecord => ({
      id: "memory-1",
      sessionGroupId: "group-1",
      summary: "Previous session discussed A2A alignment",
      keywords: "A2A,alignment",
      createdAt: "2026-04-04T00:00:00.000Z",
    }),
  })
  const service = new MemoryService(repo as never)

  const result = service.getLastSummary("group-1")
  assert.equal(result, "Previous session discussed A2A alignment")
})

test("searchMemories delegates to repository", () => {
  const expectedResults: SessionMemoryRecord[] = [
    {
      id: "memory-1",
      sessionGroupId: "group-1",
      summary: "Discussed memory features",
      keywords: "memory,features",
      createdAt: "2026-04-04T00:00:00.000Z",
    },
  ]
  const repo = createMockRepository({
    searchMemories: (_keyword: string) => expectedResults,
  })
  const service = new MemoryService(repo as never)

  const results = service.searchMemories("memory")
  assert.deepEqual(results, expectedResults)
})
