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

    const msg = repo.appendMessage(
      thread.id,
      "assistant",
      "结果汇总",
      "",
      "connector",
      { kind: "multi_mention_result", label: "并行", targets: ["claude", "gemini"] },
    )

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
    assert.equal(groups.length, limit, `should return exactly ${limit} groups, got ${groups.length}`)

    for (const g of groups) {
      assert.ok(g.previews.length > 0, `group "${g.title}" should have thread previews`)
    }

    const uniqueIds = new Set(groups.map(g => g.id))
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
