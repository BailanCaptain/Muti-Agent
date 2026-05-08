import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"
import { applyA2AWorklistsTreeMigration } from "./a2a-worklists-tree-migration"
import { SqliteStore } from "./sqlite"

/**
 * F026 P2 v2 Task 1 · a2a_worklists 树形 schema migration 幂等性 + 索引建立。
 *
 * 覆盖：
 *   1. 老库（不带 parent_worklist_id 列）→ migration 加列 + 加索引
 *   2. 二次调用幂等（不重复 ALTER，不抛错）
 *   3. 表不存在时跳过（迁移前 CREATE TABLE 还没跑过的边界）
 *   4. 索引 idx_a2a_worklists_root_status 也建上（树根聚合查询用）
 */

function createOldTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE a2a_worklists (
    worklist_id TEXT PRIMARY KEY,
    parent_call_id TEXT NOT NULL,
    root_call_id TEXT NOT NULL,
    session_group_id TEXT NOT NULL,
    items TEXT NOT NULL,
    current_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('active','settled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
}

describe("applyA2AWorklistsTreeMigration", () => {
  it("adds parent_worklist_id column to existing table", () => {
    const db = new DatabaseSync(":memory:")
    createOldTable(db)

    applyA2AWorklistsTreeMigration(db)

    const cols = db.prepare("PRAGMA table_info(a2a_worklists)").all() as Array<{ name: string }>
    assert.ok(
      cols.some((c) => c.name === "parent_worklist_id"),
      "parent_worklist_id column added",
    )
  })

  it("creates idx_a2a_worklists_parent_worklist index", () => {
    const db = new DatabaseSync(":memory:")
    createOldTable(db)

    applyA2AWorklistsTreeMigration(db)

    const indexes = db.prepare("PRAGMA index_list(a2a_worklists)").all() as Array<{ name: string }>
    assert.ok(
      indexes.some((i) => i.name === "idx_a2a_worklists_parent_worklist"),
      `expected idx_a2a_worklists_parent_worklist, got: ${indexes.map((i) => i.name).join(",")}`,
    )
  })

  it("creates idx_a2a_worklists_root_status index", () => {
    const db = new DatabaseSync(":memory:")
    createOldTable(db)

    applyA2AWorklistsTreeMigration(db)

    const indexes = db.prepare("PRAGMA index_list(a2a_worklists)").all() as Array<{ name: string }>
    assert.ok(
      indexes.some((i) => i.name === "idx_a2a_worklists_root_status"),
      `expected idx_a2a_worklists_root_status, got: ${indexes.map((i) => i.name).join(",")}`,
    )
  })

  it("is idempotent — applying twice is safe and does not duplicate column", () => {
    const db = new DatabaseSync(":memory:")
    createOldTable(db)
    applyA2AWorklistsTreeMigration(db)
    applyA2AWorklistsTreeMigration(db)

    const cols = db.prepare("PRAGMA table_info(a2a_worklists)").all() as Array<{ name: string }>
    const parentCols = cols.filter((c) => c.name === "parent_worklist_id")
    assert.equal(parentCols.length, 1, "parent_worklist_id column appears exactly once")
  })

  it("skips silently when a2a_worklists table does not exist (init order edge)", () => {
    const db = new DatabaseSync(":memory:")
    assert.doesNotThrow(() => applyA2AWorklistsTreeMigration(db))
  })

  it("new SqliteStore deployment: a2a_worklists table created with parent_worklist_id + 3 indexes (INIT_SQL contract)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-v2-init-"))
    try {
      const store = new SqliteStore(path.join(dir, "db.sqlite"))
      const cols = store.db
        .prepare("PRAGMA table_info(a2a_worklists)")
        .all() as Array<{ name: string }>
      assert.ok(
        cols.some((c) => c.name === "parent_worklist_id"),
        "fresh DB has parent_worklist_id column",
      )
      const indexes = store.db
        .prepare("PRAGMA index_list(a2a_worklists)")
        .all() as Array<{ name: string }>
      const names = indexes.map((i) => i.name)
      for (const expected of [
        "idx_a2a_worklists_parent_worklist",
        "idx_a2a_worklists_parent_call_active",
        "idx_a2a_worklists_root_status",
      ]) {
        assert.ok(names.includes(expected), `missing ${expected} in fresh DB; got ${names.join(",")}`)
      }
      store.db.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("legacy DB (a2a_worklists table without parent_worklist_id column) → new SqliteStore() does not throw on init", () => {
    // 回归保护：sqlite.ts INIT_SQL 不能在 applyA2AWorklistsTreeMigration 之前
    // 建引用 parent_worklist_id 的索引——否则老库（曾跑过 1B.1 schema 后被 reset
    // 到表已存在但无 parent_worklist_id 列的状态）启动时炸 "no such column".
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-v2-legacy-"))
    const dbPath = path.join(dir, "db.sqlite")
    let store: SqliteStore | undefined
    try {
      const seed = new DatabaseSync(dbPath)
      createOldTable(seed)
      seed.close()

      let constructErr: unknown
      try {
        store = new SqliteStore(dbPath)
      } catch (e) {
        constructErr = e
      }
      assert.equal(
        constructErr,
        undefined,
        `SqliteStore should not throw on legacy DB; got: ${
          constructErr instanceof Error ? constructErr.message : String(constructErr)
        }`,
      )
      assert.ok(store, "store constructed")

      const cols = store.db
        .prepare("PRAGMA table_info(a2a_worklists)")
        .all() as Array<{ name: string }>
      assert.ok(
        cols.some((c) => c.name === "parent_worklist_id"),
        "parent_worklist_id column was added by migration",
      )
      const indexes = store.db
        .prepare("PRAGMA index_list(a2a_worklists)")
        .all() as Array<{ name: string }>
      assert.ok(
        indexes.some((i) => i.name === "idx_a2a_worklists_parent_worklist"),
        "parent_worklist index built by migration",
      )
    } finally {
      try {
        store?.db.close()
      } catch {
        // best-effort close — ignore secondary errors
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        // Windows file lock may linger briefly when SqliteStore threw mid-init;
        // tmpdir cleanup is best-effort and OS will reap eventually.
      }
    }
  })

  it("preserves existing rows after migration (no data loss)", () => {
    const db = new DatabaseSync(":memory:")
    createOldTable(db)
    db.prepare(
      `INSERT INTO a2a_worklists (worklist_id, parent_call_id, root_call_id, session_group_id, items, current_index, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)`,
    ).run(
      "wl-old-1",
      "call-old-1",
      "call-old-1",
      "sg-1",
      JSON.stringify([{ alias: "桂芬", status: "pending" }]),
      "2026-04-30T00:00:00.000Z",
      "2026-04-30T00:00:00.000Z",
    )

    applyA2AWorklistsTreeMigration(db)

    const rows = db.prepare("SELECT * FROM a2a_worklists").all() as Array<Record<string, unknown>>
    assert.equal(rows.length, 1)
    assert.equal(rows[0].worklist_id, "wl-old-1")
    assert.equal(rows[0].parent_worklist_id, null, "parent_worklist_id defaults to NULL on legacy rows")
  })
})
