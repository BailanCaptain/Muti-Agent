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

test("F019: migration adds backlog_item_id to existing threads table (idempotent)", async () => {
  const { createDrizzleDb } = await import("./drizzle-instance")
  const tempDir = safeTempDir("drizzle-migration-test-")
  const dbPath = path.join(tempDir, "test.sqlite")

  // Simulate pre-F019 DB: create threads table WITHOUT backlog_item_id column
  const { DatabaseSync } = await import("node:sqlite")
  const oldDb = new DatabaseSync(dbPath)
  oldDb.exec(`
    CREATE TABLE session_groups (id TEXT PRIMARY KEY, title TEXT NOT NULL, project_tag TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      session_group_id TEXT NOT NULL REFERENCES session_groups(id),
      provider TEXT NOT NULL,
      alias TEXT NOT NULL,
      current_model TEXT,
      native_session_id TEXT,
      sop_bookmark TEXT,
      last_fill_ratio REAL,
      updated_at TEXT NOT NULL
    );
  `)
  oldDb.prepare("INSERT INTO session_groups VALUES (?, ?, NULL, ?, ?)").run("sg-1", "Old", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
  oldDb.prepare("INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES (?, ?, ?, ?, ?)").run("t-1", "sg-1", "claude", "Claude", "2026-01-01T00:00:00Z")
  oldDb.close()

  // First open: migration runs, adds backlog_item_id column, old row preserved
  const first = createDrizzleDb(dbPath)
  try {
    const cols = first.raw.pragma("table_info(threads)") as Array<{ name: string }>
    const colNames = cols.map((c) => c.name)
    assert.ok(colNames.includes("backlog_item_id"), `expected backlog_item_id column, got: ${colNames.join(",")}`)

    const existing = first.raw.prepare("SELECT id, backlog_item_id FROM threads WHERE id = 't-1'").get() as { id: string; backlog_item_id: string | null }
    assert.equal(existing.id, "t-1", "old row must survive")
    assert.equal(existing.backlog_item_id, null, "new column defaults to null for old rows")
  } finally {
    first.close()
  }

  // Second open: migration re-runs safely (no "duplicate column name" error)
  const second = createDrizzleDb(dbPath)
  try {
    const cols = second.raw.pragma("table_info(threads)") as Array<{ name: string }>
    assert.ok(cols.some((c) => c.name === "backlog_item_id"), "idempotent: column still present after 2nd migration run")
  } finally {
    second.close()
    safeCleanup(tempDir)
  }
})

test("F019: migration creates workflow_sop table on fresh DB", async () => {
  const { createDrizzleDb } = await import("./drizzle-instance")
  const tempDir = safeTempDir("drizzle-wsop-test-")
  const dbPath = path.join(tempDir, "test.sqlite")

  const { raw, close } = createDrizzleDb(dbPath)
  try {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_sop'").all() as Array<{ name: string }>
    assert.equal(tables.length, 1, "workflow_sop table must exist")

    // Smoke insert to verify column types + defaults
    raw.prepare(
      "INSERT INTO workflow_sop (backlog_item_id, feature_id, stage, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)",
    ).run("F019", "F019", "impl", "2026-04-17T00:00:00Z", "test")

    const row = raw.prepare("SELECT * FROM workflow_sop WHERE backlog_item_id = 'F019'").get() as {
      stage: string
      version: number
      resume_capsule: string
      checks: string
    }
    assert.equal(row.stage, "impl")
    assert.equal(row.version, 1, "version defaults to 1")
    assert.equal(row.resume_capsule, "{}", "resume_capsule defaults to empty JSON object")
    assert.equal(row.checks, "{}", "checks defaults to empty JSON object")
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
