import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}

function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Windows file locks from WAL mode — best effort
  }
}

test("createDrizzleDb returns a working drizzle instance on a fresh database", async () => {
  const { createDrizzleDb } = await import("./drizzle-instance")
  const tempDir = safeTempDir("drizzle-test-")
  const dbPath = path.join(tempDir, "test.sqlite")

  const { db, close } = createDrizzleDb(dbPath)
  try {
    const { sessionGroups } = await import("./schema")
    const { eq } = await import("drizzle-orm")

    db.insert(sessionGroups).values({
      id: "sg-1",
      title: "Test Group",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }).run()

    const rows = db.select().from(sessionGroups).where(eq(sessionGroups.id, "sg-1")).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, "Test Group")
    assert.equal(rows[0].projectTag, null)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("createDrizzleDb enables WAL mode and foreign keys", async () => {
  const { createDrizzleDb } = await import("./drizzle-instance")
  const tempDir = safeTempDir("drizzle-pragma-test-")
  const dbPath = path.join(tempDir, "test.sqlite")

  const { raw, close } = createDrizzleDb(dbPath)
  try {
    const walResult = raw.pragma("journal_mode") as Array<{ journal_mode: string }>
    assert.equal(walResult[0].journal_mode, "wal")

    const fkResult = raw.pragma("foreign_keys") as Array<{ foreign_keys: number }>
    assert.equal(fkResult[0].foreign_keys, 1)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("createDrizzleDb can read a database created by node:sqlite (SqliteStore)", async () => {
  const { SqliteStore } = await import("./sqlite")
  const { createDrizzleDb } = await import("./drizzle-instance")
  const { sessionGroups, threads } = await import("./schema")
  const { eq } = await import("drizzle-orm")

  const tempDir = safeTempDir("drizzle-compat-test-")
  const dbPath = path.join(tempDir, "test.sqlite")

  const store = new SqliteStore(dbPath)
  store.db
    .prepare("INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("sg-compat", "Compat Test", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
  store.db
    .prepare("INSERT INTO threads (id, session_group_id, provider, alias, current_model, native_session_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("t-1", "sg-compat", "claude", "Claude", null, null, "2026-01-01T00:00:00Z")
  store.db.close()

  const { db, close } = createDrizzleDb(dbPath)
  try {
    const groups = db.select().from(sessionGroups).all()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, "sg-compat")

    const threadRows = db.select().from(threads).where(eq(threads.sessionGroupId, "sg-compat")).all()
    assert.equal(threadRows.length, 1)
    assert.equal(threadRows[0].provider, "claude")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})
