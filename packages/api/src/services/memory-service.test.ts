import assert from "node:assert/strict"
import test from "node:test"
import { MemoryService } from "./memory-service"

function createMockRepository(overrides: Record<string, unknown> = {}) {
  const threads = [
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
  ]

  const messagesByThread: Record<
    string,
    Array<{
      id: string
      threadId: string
      role: string
      content: string
      thinking: string
      messageType: string
      createdAt: string
    }>
  > = {
    "thread-1": [
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
    ],
    "thread-2": [
      {
        id: "msg-3",
        threadId: "thread-2",
        role: "assistant",
        content: "the memory feature implementation is complete",
        thinking: "",
        messageType: "final",
        createdAt: "2026-04-04T00:03:00.000Z",
      },
    ],
  }

  return {
    listThreadsByGroup: (_sessionGroupId: string) => threads,
    listMessages: (threadId: string) => messagesByThread[threadId] ?? [],
    listAllMessagesForGroup: (_sessionGroupId: string, _limit = 1000) => {
      const allMsgs: Array<Record<string, unknown>> = []
      for (const t of threads) {
        const msgs = messagesByThread[t.id] ?? []
        for (const m of msgs) {
          allMsgs.push({ ...m, alias: t.alias })
        }
      }
      allMsgs.sort((a, b) => (a.createdAt as string).localeCompare(b.createdAt as string))
      return allMsgs
    },
    countUserMessagesSince: (_sessionGroupId: string, since: string) => {
      let count = 0
      for (const t of threads) {
        const msgs = messagesByThread[t.id] ?? []
        for (const m of msgs) {
          if (m.role === "user" && m.createdAt > since) count++
        }
      }
      return count
    },
    createMemory: (_sessionGroupId: string, summary: string, keywords: string) => ({
      id: "memory-1",
      sessionGroupId: _sessionGroupId,
      summary,
      keywords,
      createdAt: "2026-04-04T00:04:00.000Z",
    }),
    getLatestMemory: (_sessionGroupId: string) => null,
    searchMemories: (_keyword: string) => [],
    listMemories: (_sessionGroupId: string) => [],
    ...overrides,
  } as never
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

// F027 #285 S3 · getLastSummary / searchMemories 单测随方法退役删除（唯一消费者 =
// 旧 3 记忆工具 callback 后端，已删）。getOrCreateSummary（自动注入）覆盖见下方测试。

test("F027 B1-a: generateRollingSummary 用注入的 Opus 4.6 runner 输出并写 createMemory", async () => {
  let capturedSummary = ""
  let promptSeen = ""
  const repo = createMockRepository({
    createMemory: (g: string, summary: string, k: string) => {
      capturedSummary = summary
      return { id: "m", sessionGroupId: g, summary, keywords: k, createdAt: "x" }
    },
  })
  const fakeRunner = {
    runPrompt: async (prompt: string) => {
      promptSeen = prompt
      return { ok: true, text: "## 话题\nOpus 4.6 压缩摘要", durationMs: 1 }
    },
  }
  const service = new MemoryService(repo as never, fakeRunner as never)
  const summary = await service.generateRollingSummary("group-1")
  assert.equal(summary, "## 话题\nOpus 4.6 压缩摘要", "应用 runner 的抽象压缩输出")
  assert.equal(capturedSummary, summary, "写入 createMemory 的是 runner 输出")
  assert.ok(promptSeen.includes("会话摘要生成器"), "prompt 走 runner（含摘要指令模板）")
  assert.ok(promptSeen.includes("memory feature"), "prompt 拼入真实对话内容")
})

test("F027 B1-a: runner 失败 → fail-soft 退回 extractive 摘要（不阻断）", async () => {
  let capturedSummary = ""
  const repo = createMockRepository({
    createMemory: (g: string, summary: string, k: string) => {
      capturedSummary = summary
      return { id: "m", sessionGroupId: g, summary, keywords: k, createdAt: "x" }
    },
  })
  const fakeRunner = {
    runPrompt: async () => ({ ok: false, text: "", durationMs: 1, error: "timeout" }),
  }
  const service = new MemoryService(repo as never, fakeRunner as never)
  const summary = await service.generateRollingSummary("group-1")
  assert.ok(summary.length > 0, "fail-soft 不返回空")
  assert.ok(
    summary.includes("[Timeline]") || summary.includes("话题关键词"),
    "退回 buildExtractiveSummary 抽取式摘要",
  )
  assert.equal(capturedSummary, summary, "extractive 摘要照常写入 createMemory")
})

test("F027 B1-a 德彪 codex P2: runner ok 但只吐空白 → 退回 extractive（不存空摘要污染自动注入）", async () => {
  let capturedSummary = ""
  const repo = createMockRepository({
    createMemory: (g: string, summary: string, k: string) => {
      capturedSummary = summary
      return { id: "m", sessionGroupId: g, summary, keywords: k, createdAt: "x" }
    },
  })
  // ok=true 但 text 全空白：不能直接当有效摘要存（会经 POLICY_FULL 自动注入污染上下文）
  const fakeRunner = {
    runPrompt: async () => ({ ok: true, text: "\n   \n", durationMs: 1 }),
  }
  const service = new MemoryService(repo as never, fakeRunner as never)
  const summary = await service.generateRollingSummary("group-1")
  assert.ok(summary.trim().length > 0, "不能存空白摘要")
  assert.ok(
    summary.includes("[Timeline]") || summary.includes("话题关键词"),
    "空白 runner 输出 → 退回 extractive",
  )
  assert.equal(capturedSummary, summary)
})

// ─── F027 #285 S1 · 双写：滚动摘要写表后同步写 wiki/rooms/<roomId>/session-summary.md ───

test("F027 #285 S1: generateRollingSummary 写表后调 sessionSummaryWriter（双写）", async () => {
  const writes: Array<{ sessionGroupId: string; summary: string; keywords: string }> = []
  const repo = createMockRepository({
    createMemory: (g: string, summary: string, k: string) => ({
      id: "m",
      sessionGroupId: g,
      summary,
      keywords: k,
      createdAt: "2026-06-10T08:00:00.000Z",
    }),
  })
  const fakeRunner = {
    runPrompt: async () => ({ ok: true, text: "压缩摘要", durationMs: 1 }),
  }
  const service = new MemoryService(repo as never, fakeRunner as never)
  service.setSessionSummaryWriter({ write: (input) => writes.push(input) })
  await service.generateRollingSummary("group-1")
  assert.equal(writes.length, 1, "写表后应双写 wiki 一次")
  assert.equal(writes[0]!.sessionGroupId, "group-1")
  assert.equal(writes[0]!.summary, "压缩摘要")
})

test("F027 #285 S1: summarizeSession 同样双写", () => {
  const writes: Array<{ sessionGroupId: string; summary: string }> = []
  const repo = createMockRepository({
    createMemory: (g: string, summary: string, k: string) => ({
      id: "m",
      sessionGroupId: g,
      summary,
      keywords: k,
      createdAt: "2026-06-10T08:00:00.000Z",
    }),
  })
  const service = new MemoryService(repo as never)
  service.setSessionSummaryWriter({ write: (input) => writes.push(input) })
  service.summarizeSession("group-2")
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.sessionGroupId, "group-2")
})

test("F027 #285 S1: writer 未注入 → 行为不变（向后兼容，不抛）", async () => {
  const repo = createMockRepository({
    createMemory: (g: string, summary: string, k: string) => ({
      id: "m",
      sessionGroupId: g,
      summary,
      keywords: k,
      createdAt: "x",
    }),
  })
  const fakeRunner = {
    runPrompt: async () => ({ ok: true, text: "ok", durationMs: 1 }),
  }
  const service = new MemoryService(repo as never, fakeRunner as never)
  const summary = await service.generateRollingSummary("group-1")
  assert.equal(summary, "ok")
})
