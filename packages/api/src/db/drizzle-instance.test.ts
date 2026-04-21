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

// ==== F022 Phase 1: 历史 session roomId 回填 ====

test("F022 AC-03: 历史 session 按 createdAt 升序回填 roomId", async () => {
  const tempDir = safeTempDir("drizzle-f022-backfill-")
  const dbPath = path.join(tempDir, "test.sqlite")

  // 模拟 pre-F022 DB：session_groups 无 room_id 列，种 3 条历史
  const { DatabaseSync } = await import("node:sqlite")
  const oldDb = new DatabaseSync(dbPath)
  oldDb.exec(`
    CREATE TABLE session_groups (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_tag TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  oldDb.prepare("INSERT INTO session_groups VALUES (?, ?, NULL, ?, ?)")
    .run("u-newest", "newest", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z")
  oldDb.prepare("INSERT INTO session_groups VALUES (?, ?, NULL, ?, ?)")
    .run("u-oldest", "oldest", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
  oldDb.prepare("INSERT INTO session_groups VALUES (?, ?, NULL, ?, ?)")
    .run("u-middle", "middle", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z")
  oldDb.close()

  // 首次打开：migrate 加列 + backfill 回填
  const { createDrizzleDb } = await import("./drizzle-instance")
  const { raw, close } = createDrizzleDb(dbPath)
  try {
    const rows = raw.prepare(
      "SELECT id, room_id FROM session_groups ORDER BY created_at ASC",
    ).all() as Array<{ id: string; room_id: string }>
    assert.equal(rows[0].id, "u-oldest")
    assert.equal(rows[0].room_id, "R-001")
    assert.equal(rows[1].id, "u-middle")
    assert.equal(rows[1].room_id, "R-002")
    assert.equal(rows[2].id, "u-newest")
    assert.equal(rows[2].room_id, "R-003")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022 AC-03: 回填幂等 — 首次打开回填后，再打开不改变 roomId", async () => {
  const tempDir = safeTempDir("drizzle-f022-idempotent-")
  const dbPath = path.join(tempDir, "test.sqlite")

  // 模拟 pre-F022 旧库：建表不含 room_id 列 + 种两条数据
  const { DatabaseSync } = await import("node:sqlite")
  const oldDb = new DatabaseSync(dbPath)
  oldDb.exec(`
    CREATE TABLE session_groups (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, project_tag TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  oldDb.prepare("INSERT INTO session_groups VALUES (?, ?, NULL, ?, ?)")
    .run("u-a", "a", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
  oldDb.prepare("INSERT INTO session_groups VALUES (?, ?, NULL, ?, ?)")
    .run("u-b", "b", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z")
  oldDb.close()

  const { createDrizzleDb } = await import("./drizzle-instance")

  // 首次：触发 migrate + backfill
  const first = createDrizzleDb(dbPath)
  const firstRoomIds = first.raw.prepare(
    "SELECT id, room_id FROM session_groups ORDER BY id ASC",
  ).all() as Array<{ id: string; room_id: string }>
  // 首次打开后 roomId 应已全部回填，非 NULL
  assert.ok(firstRoomIds.every(r => r.room_id && r.room_id.startsWith("R-")),
    `首次打开后 roomId 应全部非 NULL，实际: ${JSON.stringify(firstRoomIds)}`)
  first.close()

  // 第二次：backfill 应跳过所有已回填的行（幂等）
  const second = createDrizzleDb(dbPath)
  try {
    const secondRoomIds = second.raw.prepare(
      "SELECT id, room_id FROM session_groups ORDER BY id ASC",
    ).all() as Array<{ id: string; room_id: string }>
    assert.deepEqual(secondRoomIds, firstRoomIds, "第二次打开 roomId 应保持不变")
  } finally {
    second.close()
    safeCleanup(tempDir)
  }
})

test("F022 AC-03/04: 混合数据 — 已有 R-005 + 两条 NULL，回填从 R-006 起", async () => {
  const tempDir = safeTempDir("drizzle-f022-mixed-")
  const dbPath = path.join(tempDir, "test.sqlite")

  // 先让 drizzle 建好表结构（含 room_id 列）
  const { createDrizzleDb } = await import("./drizzle-instance")
  const bootstrap = createDrizzleDb(dbPath)
  // 种一条已有 R-005 的行
  bootstrap.raw.prepare(
    "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("u-existing", "R-005", "existing", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
  // 种两条 NULL roomId 的行（模拟 migrate 后有未回填）
  bootstrap.raw.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("u-older", "older", "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z")
  bootstrap.raw.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("u-newer", "newer", "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z")
  bootstrap.close()

  // 重开：backfill 应接 R-005 之后从 R-006 起按 createdAt 分配
  const reopen = createDrizzleDb(dbPath)
  try {
    const rows = reopen.raw.prepare(
      "SELECT id, room_id FROM session_groups ORDER BY created_at ASC",
    ).all() as Array<{ id: string; room_id: string }>
    assert.equal(rows[0].id, "u-existing")
    assert.equal(rows[0].room_id, "R-005", "已有 R-005 不应被改动")
    assert.equal(rows[1].id, "u-older")
    assert.equal(rows[1].room_id, "R-006")
    assert.equal(rows[2].id, "u-newer")
    assert.equal(rows[2].room_id, "R-007")
  } finally {
    reopen.close()
    safeCleanup(tempDir)
  }
})

test("F022 AC-04: 旧库 ALTER 路径回填后，room_id 列也必须受 UNIQUE 约束保护", async () => {
  const tempDir = safeTempDir("drizzle-f022-unique-")
  const dbPath = path.join(tempDir, "test.sqlite")

  // 模拟 pre-F022 旧库（ALTER 路径，不是 CREATE TABLE 路径）
  const { DatabaseSync } = await import("node:sqlite")
  const oldDb = new DatabaseSync(dbPath)
  oldDb.exec(`
    CREATE TABLE session_groups (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, project_tag TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  oldDb.close()

  const { createDrizzleDb } = await import("./drizzle-instance")
  const { raw, close } = createDrizzleDb(dbPath)
  try {
    raw.prepare(
      "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("u-1", "R-001", "first", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")

    // 旧库 ALTER 不带 UNIQUE，但 migrate 需通过 CREATE UNIQUE INDEX 补齐
    assert.throws(() => {
      raw.prepare(
        "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("u-2", "R-001", "dup", "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z")
    }, /UNIQUE|constraint/i)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022 Phase 1 review P2 (范德彪): fresh DB 只保留一个 UNIQUE index on room_id（不与 sqlite_autoindex 并存）", async () => {
  const tempDir = safeTempDir("drizzle-f022-dup-idx-")
  const dbPath = path.join(tempDir, "test.sqlite")

  const { createDrizzleDb } = await import("./drizzle-instance")
  const { raw, close } = createDrizzleDb(dbPath)
  try {
    // 枚举 session_groups 表上所有 index；对每个 unique index 取覆盖列，
    // 统计"单列覆盖 room_id 且 unique"的索引数量，期望恰好为 1。
    const indexList = raw
      .prepare("SELECT name, \"unique\" AS is_unique FROM pragma_index_list('session_groups')")
      .all() as Array<{ name: string; is_unique: number }>
    const roomIdUniqueIndexes: string[] = []
    for (const idx of indexList) {
      if (idx.is_unique !== 1) continue
      const cols = raw
        .prepare("SELECT name FROM pragma_index_info(?)")
        .all(idx.name) as Array<{ name: string }>
      if (cols.length === 1 && cols[0].name === "room_id") {
        roomIdUniqueIndexes.push(idx.name)
      }
    }
    assert.equal(
      roomIdUniqueIndexes.length,
      1,
      `Expected exactly 1 UNIQUE index on room_id; got ${roomIdUniqueIndexes.length}: ${roomIdUniqueIndexes.join(", ")}`,
    )
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F022 Phase 1 review P2 (范德彪): 旧库 ALTER 路径下仍补齐一个 UNIQUE index on room_id", async () => {
  const tempDir = safeTempDir("drizzle-f022-altidx-")
  const dbPath = path.join(tempDir, "test.sqlite")

  // 模拟 pre-F022 旧库：CREATE TABLE 无 room_id 列
  const { DatabaseSync } = await import("node:sqlite")
  const oldDb = new DatabaseSync(dbPath)
  oldDb.exec(`
    CREATE TABLE session_groups (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, project_tag TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  oldDb.close()

  const { createDrizzleDb } = await import("./drizzle-instance")
  const { raw, close } = createDrizzleDb(dbPath)
  try {
    const indexList = raw
      .prepare("SELECT name, \"unique\" AS is_unique FROM pragma_index_list('session_groups')")
      .all() as Array<{ name: string; is_unique: number }>
    const roomIdUniqueIndexes: string[] = []
    for (const idx of indexList) {
      if (idx.is_unique !== 1) continue
      const cols = raw
        .prepare("SELECT name FROM pragma_index_info(?)")
        .all(idx.name) as Array<{ name: string }>
      if (cols.length === 1 && cols[0].name === "room_id") {
        roomIdUniqueIndexes.push(idx.name)
      }
    }
    assert.equal(
      roomIdUniqueIndexes.length,
      1,
      `ALTER 路径也要恰好有 1 个 UNIQUE index on room_id; got ${roomIdUniqueIndexes.length}: ${roomIdUniqueIndexes.join(", ")}`,
    )
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
