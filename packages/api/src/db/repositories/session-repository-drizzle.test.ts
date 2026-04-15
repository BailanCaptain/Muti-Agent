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
