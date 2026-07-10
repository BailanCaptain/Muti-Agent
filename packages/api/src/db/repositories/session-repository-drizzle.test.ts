import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

function createTestDb() {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(runtimeDir, "drizzle-repo-test-"))
  const dbPath = path.join(tempDir, "test.sqlite")
  return { dbPath, tempDir }
}

function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Windows WAL file locks
  }
}

test("createSessionGroup + listSessionGroups round-trip via drizzle", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test Room")
    assert.ok(groupId, "should return a group ID")

    const group = repo.getSessionGroupById(groupId)
    assert.ok(group)
    assert.equal(group.title, "Test Room")
    assert.equal(group.projectTag, null)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("ensureDefaultThreads creates one thread per provider", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })

    const threads = repo.listThreadsByGroup(groupId)
    assert.equal(threads.length, 3)

    const providers = threads.map((t) => t.provider).sort()
    assert.deepEqual(providers, ["claude", "codex", "gemini"])
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("appendMessage + listMessages round-trip", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "codex")
    assert.ok(thread)

    const msg = repo.appendMessage(thread.id, "user", "Hello world")
    assert.ok(msg.id)
    assert.equal(msg.content, "Hello world")
    assert.equal(msg.role, "user")

    const messages = repo.listMessages(thread.id)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].content, "Hello world")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

// F030 r4 P2：/api/bootstrap 走 Drizzle listSessionGroups 内联预览（slice 原始 content），
// 未闭合 cc_rich 的 ```cc_rich + JSON 会泄漏到侧栏。preview 必须先过 stripRichFencesForPreview。
test("F030 r4 P2: listSessionGroups preview 不泄漏未闭合 cc_rich", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "codex")
    assert.ok(thread)
    repo.appendMessage(thread.id, "assistant", '结论先行\n```cc_rich\n{"kind":"card","id":"x","title":"T"')

    const group = repo.listSessionGroups().find((g) => g.id === groupId)
    const preview = group?.previews.find((p) => p.provider === "codex")?.text ?? ""
    assert.ok(!preview.includes("cc_rich"), `preview 不应含 cc_rich，实际: "${preview}"`)
    assert.ok(!preview.includes("{"), `preview 不应含原始 JSON，实际: "${preview}"`)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

// Regression: F011 设的 default limit=1000 在长 thread (>1000 条) 上 ASC + LIMIT
// 截掉了最新消息，导致前端 timeline 看不到刚发的消息。无显式 limit 时必须返回全部。
test("listMessages without limit returns ALL messages even when count > 1000", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "codex")
    assert.ok(thread)

    for (let i = 0; i < 1001; i += 1) {
      repo.appendMessage(thread.id, "user", `msg-${i}`)
    }

    const all = repo.listMessages(thread.id)
    assert.equal(all.length, 1001, `expected 1001, got ${all.length}`)
    assert.equal(all[1000].content, "msg-1000", "newest message must be present")

    const capped = repo.listMessages(thread.id, 500)
    assert.equal(capped.length, 500, "explicit limit still honored")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F044 listGroupMessagesPage paginates newest-first windows without gaps at equal timestamps", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { messages } = await import("../schema")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("F044 cursor room")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const roomThreads = repo.listThreadsByGroup(groupId)
    assert.equal(roomThreads.length, 3)

    const insertedIds: string[] = []
    for (let index = 0; index < 205; index += 1) {
      const thread = roomThreads[index % roomThreads.length]
      const message = repo.appendMessage(thread.id, "user", `msg-${index}`)
      insertedIds.push(message.id)
    }

    // Force the worst-case cursor boundary: every row shares the same timestamp,
    // so rowid must be the deterministic tiebreaker across all provider threads.
    db.update(messages).set({ createdAt: "2026-07-10T00:00:00.000Z" }).run()

    const newest = repo.listGroupMessagesPage(groupId, { limit: 100 })
    assert.equal(newest.messages.length, 100)
    assert.equal(newest.hasMore, true)
    assert.ok(newest.nextCursor)

    const middle = repo.listGroupMessagesPage(groupId, {
      limit: 100,
      before: newest.nextCursor,
    })
    assert.equal(middle.messages.length, 100)
    assert.equal(middle.hasMore, true)
    assert.ok(middle.nextCursor)

    const oldest = repo.listGroupMessagesPage(groupId, {
      limit: 100,
      before: middle.nextCursor,
    })
    assert.equal(oldest.messages.length, 5)
    assert.equal(oldest.hasMore, false)
    assert.equal(oldest.nextCursor, null)

    const restoredIds = [...oldest.messages, ...middle.messages, ...newest.messages].map(
      (message) => message.id,
    )
    assert.deepEqual(restoredIds, insertedIds, "all pages should restore insertion order exactly once")
    assert.equal(new Set(restoredIds).size, 205, "cursor pages must not overlap")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("connector messages round-trip with connectorSource JSON", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "codex")
    assert.ok(thread)

    const msg = repo.appendMessage(thread.id, "assistant", "结果汇总", "", "connector", {
      kind: "multi_mention_result",
      label: "并行",
      targets: ["claude", "gemini"],
    })

    const restored = repo.listMessages(thread.id).find((m) => m.id === msg.id)
    assert.ok(restored)
    assert.equal(restored.messageType, "connector")
    assert.ok(restored.connectorSource)
    assert.equal(restored.connectorSource?.kind, "multi_mention_result")
    assert.deepEqual(restored.connectorSource?.targets, ["claude", "gemini"])
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("overwriteMessage updates content and thinking", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "codex")
    assert.ok(thread)

    const msg = repo.appendMessage(thread.id, "assistant", "draft")
    repo.overwriteMessage(msg.id, { content: "final", thinking: "deep thought" })

    const restored = repo.listMessages(thread.id).find((m) => m.id === msg.id)
    assert.ok(restored)
    assert.equal(restored.content, "final")
    assert.equal(restored.thinking, "deep thought")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("createInvocation + getInvocationById + updateInvocation", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "codex")
    assert.ok(thread)

    const record = {
      id: "inv-1",
      threadId: thread.id,
      agentId: "codex",
      callbackToken: "tok-123",
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      lastActivityAt: null,
    }
    repo.createInvocation(record)

    const inv = repo.getInvocationById("inv-1")
    assert.ok(inv)
    assert.equal(inv.status, "running")
    assert.equal(inv.callbackToken, "tok-123")

    repo.updateInvocation("inv-1", { status: "completed", exitCode: 0 })
    const updated = repo.getInvocationById("inv-1")
    assert.ok(updated)
    assert.equal(updated.status, "completed")
    assert.equal(updated.exitCode, 0)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F021 createInvocation persists configSnapshot (JSON) and round-trips via getInvocationById", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Snapshot")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread)

    const snapshotJson = JSON.stringify({
      claude: { model: "claude-opus-4-7", effort: "high" },
      codex: { model: "gpt-5" },
    })
    repo.createInvocation({
      id: "inv-snap",
      threadId: thread.id,
      agentId: "claude",
      callbackToken: "tok-snap",
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      lastActivityAt: null,
      configSnapshot: snapshotJson,
    })

    const got = repo.getInvocationById("inv-snap")
    assert.ok(got)
    assert.equal(got.configSnapshot, snapshotJson)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("createMemory + listMemories + getLatestMemory", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")

    repo.createMemory(groupId, "First summary", "key1,key2")
    // Ensure distinct timestamps
    const later = new Date(Date.now() + 1000).toISOString()
    repo.createMemory(groupId, "Second summary", "key3")

    const memories = repo.listMemories(groupId)
    assert.equal(memories.length, 2)
    const summaries = memories.map((m) => m.summary)
    assert.ok(summaries.includes("First summary"))
    assert.ok(summaries.includes("Second summary"))

    const latest = repo.getLatestMemory(groupId)
    assert.ok(latest)
    assert.ok(["First summary", "Second summary"].includes(latest.summary))
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("listSessionGroups returns exactly N complete groups when more than N exist", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const totalGroups = 15
    const limit = 10
    const aliases = { codex: null, claude: null, gemini: null }

    for (let i = 0; i < totalGroups; i++) {
      const gid = repo.createSessionGroup(`Room ${i}`)
      repo.ensureDefaultThreads(gid, aliases)
      const threads = repo.listThreadsByGroup(gid)
      for (const t of threads) {
        repo.appendMessage(t.id, "user", `msg in ${t.provider}`)
      }
    }

    const groups = repo.listSessionGroups(limit)
    assert.equal(
      groups.length,
      limit,
      `should return exactly ${limit} groups, got ${groups.length}`,
    )

    for (const g of groups) {
      assert.ok(g.previews.length > 0, `group "${g.title}" should have thread previews`)
    }

    const uniqueIds = new Set(groups.map((g) => g.id))
    assert.equal(uniqueIds.size, limit, "all returned groups should be distinct")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("searchMemories finds by keyword", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.createMemory(groupId, "discussion about databases", "sqlite,drizzle")
    repo.createMemory(groupId, "discussion about frontend", "react,next")

    const results = repo.searchMemories("sqlite")
    assert.equal(results.length, 1)
    assert.ok(results[0].keywords.includes("sqlite"))
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

// ==== F022 Phase 1: ROOM ID 生成 + 存储 ====

test("F022 AC-01/02: createSessionGroup 为第一个 session 分配 R-001 并持久化", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("first")
    const group = repo.getSessionGroupById(groupId) as { roomId?: string | null }
    assert.equal(group.roomId, "R-001", "第一个 session 应分配 R-001")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022 AC-01: createSessionGroup 连续创建全局递增 R-001 → R-002 → R-003", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const g1 = repo.createSessionGroup("a")
    const g2 = repo.createSessionGroup("b")
    const g3 = repo.createSessionGroup("c")
    const r1 = (repo.getSessionGroupById(g1) as { roomId?: string }).roomId
    const r2 = (repo.getSessionGroupById(g2) as { roomId?: string }).roomId
    const r3 = (repo.getSessionGroupById(g3) as { roomId?: string }).roomId
    assert.equal(r1, "R-001")
    assert.equal(r2, "R-002")
    assert.equal(r3, "R-003")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022 AC-01/04: createSessionGroup 接续已有最大序号（seed R-005 → 新分配 R-006）", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close, raw } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    // 手工种一条 R-005 的历史数据（绕过 createSessionGroup）
    raw
      .prepare(
        "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("uuid-seed", "R-005", "seed", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")

    const newId = repo.createSessionGroup("after-seed")
    const roomId = (repo.getSessionGroupById(newId) as { roomId?: string }).roomId
    assert.equal(roomId, "R-006")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022 AC-01: room_id 格式在超过 999 后自然扩位（seed R-1234 → R-1235）", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close, raw } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    raw
      .prepare(
        "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("uuid-big", "R-1234", "big", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")

    const newId = repo.createSessionGroup("after-big")
    const roomId = (repo.getSessionGroupById(newId) as { roomId?: string }).roomId
    assert.equal(roomId, "R-1235")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022 AC-02: createSessionGroupWithDefaults 也分配 roomId", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroupWithDefaults(
      { codex: null, claude: null, gemini: null },
      "with-defaults",
    )
    const roomId = (repo.getSessionGroupById(groupId) as { roomId?: string }).roomId
    assert.equal(roomId, "R-001")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022 AC-02: listSessionGroups 返回结果含 roomId", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    repo.createSessionGroup("x")
    repo.createSessionGroup("y")
    const list = repo.listSessionGroups() as Array<{ roomId?: string | null }>
    assert.equal(list.length, 2)
    for (const item of list) {
      assert.match(item.roomId ?? "", /^R-\d{3,}$/)
    }
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022-P2 updateSessionGroupTitle writes new title and bumps updatedAt", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup()
    const before = repo.getSessionGroupById(groupId)
    assert.ok(before)
    const originalUpdatedAt = before.updatedAt

    // Ensure clock ticks before update so updatedAt changes.
    await new Promise((r) => setTimeout(r, 10))

    repo.updateSessionGroupTitle(groupId, "学习 Drizzle")

    const after = repo.getSessionGroupById(groupId)
    assert.ok(after)
    assert.equal(after.title, "学习 Drizzle")
    assert.ok(after.updatedAt >= originalUpdatedAt, "updatedAt should advance")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022-P2 updateSessionGroupTitle is no-op for unknown id (does not throw)", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    // Should not throw; drizzle UPDATE with 0 rows affected is silent.
    repo.updateSessionGroupTitle("does-not-exist", "whatever")
    assert.equal(repo.getSessionGroupById("does-not-exist"), undefined)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022-P3 AC-12: listSessionGroups participants 只含真正发过消息的 provider", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("room with msgs")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const threads = repo.listThreadsByGroup(groupId)
    const claudeThread = threads.find((t) => t.provider === "claude")!
    const codexThread = threads.find((t) => t.provider === "codex")!
    repo.appendMessage(claudeThread.id, "user", "hi")
    repo.appendMessage(codexThread.id, "assistant", "ok")
    // gemini thread 存在但无消息
    const list = repo.listSessionGroups() as Array<{
      id: string
      participants?: string[]
      messageCount?: number
    }>
    const row = list.find((g) => g.id === groupId)
    assert.ok(row, "group row should be in list")
    assert.deepEqual([...(row.participants ?? [])].sort(), ["claude", "codex"])
    assert.equal(row.messageCount, 2)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022-P3 AC-15: listSessionGroups 返回 messageCount=0 + participants=[] for empty group", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("empty room")
    const list = repo.listSessionGroups() as Array<{
      id: string
      participants?: string[]
      messageCount?: number
    }>
    const row = list.find((g) => g.id === groupId)
    assert.ok(row)
    assert.equal(row.messageCount, 0)
    assert.deepEqual(row.participants, [])
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

// F022 Phase 3.5 (review P1-1): listSessionGroupsForBackfill
test("review P1-1: listSessionGroupsForBackfill 不分页，扫描 >200 条活跃会话", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    // listSessionGroups 默认 limit=200 → backfill 老路径会漏掉第 201 条
    const total = 210
    for (let i = 0; i < total; i++) repo.createSessionGroup(`Room ${i}`)

    const rows = repo.listSessionGroupsForBackfill()
    assert.equal(rows.length, total, `应该返回全部 ${total} 条，不受 200 分页限制`)
    assert.ok(
      rows.every((r) => typeof r.id === "string"),
      "每行都有 id",
    )
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("review P1-1: listSessionGroupsForBackfill 过滤软删，不过滤归档", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const active = repo.createSessionGroup("active")
    const archived = repo.createSessionGroup("archived")
    const deleted = repo.createSessionGroup("soft-deleted")
    repo.archiveSessionGroup(archived)
    repo.softDeleteSessionGroup(deleted)

    const ids = repo.listSessionGroupsForBackfill().map((r) => r.id)
    assert.ok(ids.includes(active), "活跃会话在")
    assert.ok(ids.includes(archived), "归档会话仍应被 backfill — 归档≠不命名")
    assert.ok(!ids.includes(deleted), "软删会话不应 backfill — 已被用户标记删除")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("review P1-2: title_backfill_attempts 达到 MAX 后 backfill 跳过（防 Haiku 死循环）", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const stuck = repo.createSessionGroup("haiku-keeps-failing")
    const fresh = repo.createSessionGroup("fresh")

    // 模拟 SessionTitler fallback 3 次
    for (let i = 0; i < DrizzleSessionRepository.MAX_TITLE_BACKFILL_ATTEMPTS; i++) {
      repo.incrementTitleBackfillAttempts(stuck)
    }

    const ids = repo.listSessionGroupsForBackfill().map((r) => r.id)
    assert.ok(!ids.includes(stuck), "attempts ≥ MAX 的会话永久跳过")
    assert.ok(ids.includes(fresh), "新会话仍应扫入队列")

    // 重置后重新进入扫描（例如用户手动 rename 后清锁）
    repo.resetTitleBackfillAttempts(stuck)
    const after = repo.listSessionGroupsForBackfill().map((r) => r.id)
    assert.ok(after.includes(stuck), "reset 后回到扫描队列")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

// F021 P1 (范德彪 二轮 review residual risk): 主库实际走 DrizzleSessionRepository，
// legacy SessionRepository 已有 partial-pending 测试，这里给 Drizzle 补等价断言，
// 保证两个 repo 走同一个 mergeRuntimeConfigFieldwise helper 的行为一致。
test("F021 P1 DrizzleSessionRepository.flushSessionPending merges per-field within a provider (partial pending preserves active fields)", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("Test")
    repo.setSessionRuntimeConfig(groupId, {
      claude: { model: "claude-opus-4-7", effort: "high" },
    })
    repo.setSessionPendingConfig(groupId, {
      claude: { effort: "low" },
    })

    const merged = repo.flushSessionPending(groupId)
    assert.deepEqual(merged, {
      claude: { model: "claude-opus-4-7", effort: "low" },
    })
    assert.deepEqual(repo.getSessionRuntimeConfig(groupId), {
      claude: { model: "claude-opus-4-7", effort: "low" },
    })
    assert.deepEqual(repo.getSessionPendingConfig(groupId), {})
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

// F026 P5 in-flight · DrizzleSessionRepository LEFT JOIN a2a_calls
// R-104 实证：messages 表只存 a2a_call_id 一列，前端 AtPill 反查需要 6 个协议字段
// (parentCallId / rootCallId / onBehalfOf / convenerId / status / deadlineAt) 必须 LEFT JOIN
// a2a_calls 才能拿到。drizzle 路径四个 list 方法都缺，导致 envelope status 永远 null
// → AtPill `deriveLiveAtPillStatus` 反查永远落 default → 「派发中」卡死。
// sqlite-store 路径 SQL 已经写好了，drizzle 抄一份。
// a2a_calls 表已经在 createDrizzleDb INIT_SQL 内建好，测试无需手动建表。

type A2aCallRow = {
  callId: string
  parentCallId: string | null
  rootCallId: string
  issuerId: string
  convenerId: string
  onBehalfOf: string | null
  replyTo: string
  deadlineAt: string
  status: "pending" | "working" | "done" | "failed" | "timeout" | "cancelled"
  sessionGroupId: string
}

function insertA2aCall(
  raw: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } },
  fields: A2aCallRow,
): void {
  const now = new Date().toISOString()
  raw
    .prepare(
      `INSERT INTO a2a_calls (
        call_id, parent_call_id, root_call_id, issuer_id, convener_id, on_behalf_of,
        reply_to, deadline_at, join_set_id, status, envelope_version, session_group_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.callId,
      fields.parentCallId,
      fields.rootCallId,
      fields.issuerId,
      fields.convenerId,
      fields.onBehalfOf,
      fields.replyTo,
      fields.deadlineAt,
      null, // join_set_id
      fields.status,
      "v1",
      fields.sessionGroupId,
      now,
      now,
    )
}

test("listMessages LEFT JOIN a2a_calls hydrates 6 protocol fields (R-104 root)", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, raw, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("R-104 sim")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread)

    const deadline = "2099-01-01T00:00:00.000Z"
    insertA2aCall(raw, {
      callId: "call-cc599248",
      parentCallId: "call-6d1",
      rootCallId: "call-0f9fd588",
      issuerId: "黄仁勋",
      convenerId: "user",
      onBehalfOf: "user",
      replyTo: "thread-黄仁勋",
      deadlineAt: deadline,
      status: "done",
      sessionGroupId: groupId,
    })

    repo.appendMessage(
      thread.id,
      "assistant",
      "派发桂芬",
      "",
      "connector",
      null,
      null,
      null,
      "[]",
      "[]",
      null,
      "call-cc599248",
    )

    const msgs = repo.listMessages(thread.id)
    assert.equal(msgs.length, 1)
    const m = msgs[0]
    assert.equal(m.a2aCallId, "call-cc599248")
    assert.equal(m.a2aParentCallId, "call-6d1", "parent_call_id must be LEFT JOIN hydrated")
    assert.equal(m.a2aRootCallId, "call-0f9fd588", "root_call_id must be LEFT JOIN hydrated")
    assert.equal(m.a2aOnBehalfOf, "user", "on_behalf_of must be LEFT JOIN hydrated")
    assert.equal(m.a2aConvenerId, "user", "convener_id must be LEFT JOIN hydrated")
    assert.equal(m.a2aCallStatus, "done", "status must be LEFT JOIN hydrated (AtPill needs this)")
    assert.equal(m.a2aDeadlineAt, deadline, "deadline_at must be LEFT JOIN hydrated")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("listMessagesSince LEFT JOIN a2a_calls hydrates 6 protocol fields", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, raw, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("R-104 sim")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread)

    const deadline = "2099-01-01T00:00:00.000Z"
    insertA2aCall(raw, {
      callId: "call-cc599248",
      parentCallId: null,
      rootCallId: "call-cc599248",
      issuerId: "黄仁勋",
      convenerId: "user",
      onBehalfOf: null,
      replyTo: "thread-黄仁勋",
      deadlineAt: deadline,
      status: "working",
      sessionGroupId: groupId,
    })

    const since = new Date(Date.now() - 1000).toISOString()
    repo.appendMessage(
      thread.id,
      "assistant",
      "派发桂芬",
      "",
      "connector",
      null,
      null,
      null,
      "[]",
      "[]",
      null,
      "call-cc599248",
    )

    const msgs = repo.listMessagesSince(thread.id, since)
    assert.equal(msgs.length, 1)
    const m = msgs[0]
    assert.equal(m.a2aCallId, "call-cc599248")
    assert.equal(m.a2aRootCallId, "call-cc599248")
    assert.equal(m.a2aCallStatus, "working", "status hydration is the AtPill blocker — must work")
    assert.equal(m.a2aDeadlineAt, deadline)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("listRecentMessages LEFT JOIN a2a_calls hydrates 6 protocol fields", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, raw, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("R-104 sim")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread)

    const deadline = "2099-01-01T00:00:00.000Z"
    insertA2aCall(raw, {
      callId: "call-cc599248",
      parentCallId: "call-parent",
      rootCallId: "call-root",
      issuerId: "黄仁勋",
      convenerId: "user",
      onBehalfOf: "user",
      replyTo: "thread-黄仁勋",
      deadlineAt: deadline,
      status: "pending",
      sessionGroupId: groupId,
    })

    // 多条消息混插，listRecentMessages 限 1 条只看最新
    repo.appendMessage(thread.id, "user", "first")
    repo.appendMessage(
      thread.id,
      "assistant",
      "派发桂芬",
      "",
      "connector",
      null,
      null,
      null,
      "[]",
      "[]",
      null,
      "call-cc599248",
    )

    const msgs = repo.listRecentMessages(thread.id, 1)
    assert.equal(msgs.length, 1)
    const m = msgs[0]
    assert.equal(m.a2aCallId, "call-cc599248")
    assert.equal(m.a2aParentCallId, "call-parent")
    assert.equal(m.a2aRootCallId, "call-root")
    assert.equal(m.a2aCallStatus, "pending")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("listAllMessagesForGroup LEFT JOIN a2a_calls hydrates 6 protocol fields", async () => {
  const { createDrizzleDb } = await import("../drizzle-instance")
  const { DrizzleSessionRepository } = await import("./session-repository-drizzle")
  const { dbPath, tempDir } = createTestDb()

  const { db, raw, close } = createDrizzleDb(dbPath)
  const repo = new DrizzleSessionRepository(db)

  try {
    const groupId = repo.createSessionGroup("R-104 sim")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const claudeThread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(claudeThread)

    const deadline = "2099-01-01T00:00:00.000Z"
    insertA2aCall(raw, {
      callId: "call-cc599248",
      parentCallId: null,
      rootCallId: "call-cc599248",
      issuerId: "黄仁勋",
      convenerId: "user",
      onBehalfOf: null,
      replyTo: "thread-黄仁勋",
      deadlineAt: deadline,
      status: "done",
      sessionGroupId: groupId,
    })

    repo.appendMessage(
      claudeThread.id,
      "assistant",
      "派发桂芬",
      "",
      "connector",
      null,
      null,
      null,
      "[]",
      "[]",
      null,
      "call-cc599248",
    )

    const msgs = repo.listAllMessagesForGroup(groupId)
    const connector = msgs.find((m) => m.messageType === "connector")
    assert.ok(connector, "connector message should be in group listing")
    assert.equal(connector.a2aCallId, "call-cc599248")
    assert.equal(connector.a2aRootCallId, "call-cc599248")
    assert.equal(
      connector.a2aCallStatus,
      "done",
      "status hydration also required in group-wide listing (group page envelope)",
    )
  } finally {
    close()
    safeCleanup(tempDir)
  }
})
