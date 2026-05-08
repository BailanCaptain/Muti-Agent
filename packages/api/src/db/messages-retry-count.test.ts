import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { createDrizzleDb } from "./drizzle-instance"
import { SqliteStore } from "./sqlite"

/**
 * F026 P3.1 Task2 · `messages.retry_count` + `retry_reasons` migration
 *
 * 双源 schema 必须同步加列：
 *   - sqlite.ts (legacy raw SQL path · runtime-config / SqliteStore)
 *   - drizzle-instance.ts (drizzle ORM path · message-service / repositories)
 *
 * 否则 message-service 写 retry_count 时其中一路会 NOT NULL 失败。
 */

function withTempDb<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "f026-p3.1-retry-"))
  const path = join(dir, "test.sqlite")
  try {
    return fn(path)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows WAL files may keep handles briefly after close — ignore cleanup errors
    }
  }
}

type ColInfo = {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

test("sqlite.ts · 新建 messages 表含 retry_count + retry_reasons 列", () => {
  withTempDb((path) => {
    const store = new SqliteStore(path)
    const cols = store.db.prepare("PRAGMA table_info(messages)").all() as ColInfo[]
    const retryCount = cols.find((c) => c.name === "retry_count")
    const retryReasons = cols.find((c) => c.name === "retry_reasons")
    assert.ok(retryCount, "retry_count column missing in sqlite.ts schema")
    assert.equal(retryCount?.notnull, 1, "retry_count should be NOT NULL")
    assert.equal(String(retryCount?.dflt_value), "0", "retry_count default 0")
    assert.ok(retryReasons, "retry_reasons column missing in sqlite.ts schema")
    assert.equal(retryReasons?.notnull, 1, "retry_reasons should be NOT NULL")
    assert.equal(
      String(retryReasons?.dflt_value).replace(/'/g, ""),
      "[]",
      "retry_reasons default '[]'",
    )
    store.db.close()
  })
})

test("drizzle-instance · 新建 messages 表含 retry_count + retry_reasons 列", () => {
  withTempDb((path) => {
    const conn = createDrizzleDb(path)
    const cols = conn.raw.prepare("PRAGMA table_info(messages)").all() as ColInfo[]
    const retryCount = cols.find((c) => c.name === "retry_count")
    const retryReasons = cols.find((c) => c.name === "retry_reasons")
    assert.ok(retryCount, "retry_count column missing in drizzle path")
    assert.equal(retryCount?.notnull, 1)
    assert.equal(String(retryCount?.dflt_value), "0")
    assert.ok(retryReasons, "retry_reasons column missing in drizzle path")
    assert.equal(retryReasons?.notnull, 1)
    assert.equal(String(retryReasons?.dflt_value).replace(/'/g, ""), "[]")
    conn.close()
  })
})

test("ALTER 兼容 · 旧 DB（无 retry_count 列）启动后被 idempotent ALTER 补齐", () => {
  withTempDb((path) => {
    // 模拟 pre-P3.1 旧 DB
    const old = new DatabaseSync(path)
    old.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        thinking TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL DEFAULT 'final',
        connector_source TEXT,
        group_id TEXT,
        group_role TEXT,
        tool_events TEXT NOT NULL DEFAULT '[]',
        content_blocks TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        model TEXT
      );
    `)
    old
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("legacy-1", "t-1", "user", "hello", "2026-04-26T00:00:00.000Z")
    old.close()

    // 用 SqliteStore 重新打开 → 幂等 ALTER 应补齐
    const store = new SqliteStore(path)
    const cols = store.db.prepare("PRAGMA table_info(messages)").all() as ColInfo[]
    assert.ok(
      cols.find((c) => c.name === "retry_count"),
      "ALTER 未补齐 retry_count",
    )
    assert.ok(
      cols.find((c) => c.name === "retry_reasons"),
      "ALTER 未补齐 retry_reasons",
    )

    const row = store.db
      .prepare("SELECT id, retry_count, retry_reasons FROM messages WHERE id = ?")
      .get("legacy-1") as { id: string; retry_count: number; retry_reasons: string }
    assert.equal(row.retry_count, 0, "ALTER DEFAULT 0 应回填到老数据")
    assert.equal(row.retry_reasons, "[]", "ALTER DEFAULT '[]' 应回填到老数据")
    store.db.close()
  })
})
