import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { SqliteStore } from "./sqlite"

/**
 * F026 P5 T4 · agent_events.invocation_id NOT NULL → nullable rebuild migration.
 *
 * 覆盖：
 *   1. 新部署 DB：CREATE TABLE 直接是 nullable（无需 rebuild）
 *   2. 老 DB（手动 CREATE NOT NULL agent_events）→ runRebuildMigrations 跑后
 *      列变 nullable + 已有数据保留 + 索引重建
 *   3. 二次启动幂等 — rebuild 不会重复跑（PRAGMA 检测 notnull=0 短路）
 *   4. 系统级事件（invocation_id=NULL）可以 INSERT 成功
 */

function tmpDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p5-t4-migration-"))
  return { dir, dbPath: path.join(dir, "db.sqlite") }
}

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function getColumnNotNull(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
    notnull: number
  }>
  const row = rows.find((r) => r.name === column)
  if (!row) throw new Error(`column ${column} not found in ${table}`)
  return row.notnull === 1
}

test("F026 P5 T4 · 新部署 DB：agent_events.invocation_id 直接是 nullable", () => {
  const t = tmpDb()
  try {
    const store = new SqliteStore(t.dbPath)
    assert.equal(getColumnNotNull(store.db, "agent_events", "invocation_id"), false)
    store.db.close()
  } finally {
    cleanup(t.dir)
  }
})

test("F026 P5 T4 · 老 DB rebuild：手动 NOT NULL → 升级后 nullable + 数据保留", () => {
  const t = tmpDb()
  try {
    // 1) 模拟老 DB：手动建一个 agent_events NOT NULL 表 + 塞数据
    const oldDb = new DatabaseSync(t.dbPath)
    oldDb.exec(`
      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    oldDb
      .prepare(
        "INSERT INTO agent_events (id, invocation_id, thread_id, agent_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "ev-old-1",
        "inv-1",
        "thr-1",
        "黄仁勋",
        "legacy_event",
        '{"x":1}',
        "2026-01-01T00:00:00.000Z",
      )
    assert.equal(getColumnNotNull(oldDb, "agent_events", "invocation_id"), true)
    oldDb.close()

    // 2) SqliteStore init → runRebuildMigrations 触发 rebuild
    const store = new SqliteStore(t.dbPath)
    assert.equal(getColumnNotNull(store.db, "agent_events", "invocation_id"), false)

    // 3) 数据保留
    const rows = store.db.prepare("SELECT * FROM agent_events").all() as Array<
      Record<string, unknown>
    >
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, "ev-old-1")
    assert.equal(rows[0].invocation_id, "inv-1")
    assert.equal(rows[0].thread_id, "thr-1")
    assert.equal(rows[0].event_type, "legacy_event")

    // 4) 现在可以塞 NULL invocation_id
    store.db
      .prepare(
        "INSERT INTO agent_events (id, invocation_id, thread_id, agent_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "ev-system-1",
        null,
        "thr-1",
        "system",
        "system_legacy_event",
        "{}",
        "2026-04-29T00:00:00.000Z",
      )
    const sysRow = store.db
      .prepare("SELECT * FROM agent_events WHERE id = ?")
      .get("ev-system-1") as Record<string, unknown>
    assert.equal(sysRow.invocation_id, null)

    store.db.close()
  } finally {
    cleanup(t.dir)
  }
})

test("F026 P5 T4 · 二次启动幂等：已 nullable 的 schema 不会重复 rebuild（数据无丢失）", () => {
  const t = tmpDb()
  try {
    // 第一次启动 → nullable
    const store1 = new SqliteStore(t.dbPath)
    store1.db
      .prepare(
        "INSERT INTO agent_events (id, invocation_id, thread_id, agent_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("ev-1", "inv-1", "thr-1", "agent", "type1", "{}", "2026-04-29T00:00:00.000Z")
    store1.db.close()

    // 第二次启动 → PRAGMA 检测 notnull=0 → 不 rebuild
    const store2 = new SqliteStore(t.dbPath)
    assert.equal(getColumnNotNull(store2.db, "agent_events", "invocation_id"), false)
    const rows = store2.db.prepare("SELECT * FROM agent_events").all() as Array<
      Record<string, unknown>
    >
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, "ev-1")
    store2.db.close()
  } finally {
    cleanup(t.dir)
  }
})

test("F026 P5 T4 · rebuild 后 invocation_id / thread_id 索引仍存在", () => {
  const t = tmpDb()
  try {
    // 模拟老 DB 走 rebuild 路径
    const oldDb = new DatabaseSync(t.dbPath)
    oldDb.exec(`
      CREATE TABLE agent_events (
        id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    oldDb.close()

    const store = new SqliteStore(t.dbPath)
    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_events'")
      .all() as Array<{ name: string }>
    const names = indexes.map((i) => i.name)
    assert.ok(
      names.includes("idx_agent_events_invocation_id"),
      `expected idx, got: ${names.join(",")}`,
    )
    assert.ok(names.includes("idx_agent_events_thread_id"), `expected idx, got: ${names.join(",")}`)
    store.db.close()
  } finally {
    cleanup(t.dir)
  }
})
