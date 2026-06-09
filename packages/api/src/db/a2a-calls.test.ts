import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { SqliteStore } from "./sqlite"

function tmpDb(): { store: SqliteStore; close: () => void; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-a2a-calls-"))
  const filePath = path.join(dir, "db.sqlite")
  const store = new SqliteStore(filePath)
  return {
    store,
    dir,
    close: () => {
      try {
        store.db.close()
      } catch {}
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

test("F026 I4 / ADR-002: schema exports a2aCalls table", async () => {
  const schema = await import("./schema")
  assert.ok((schema as Record<string, unknown>).a2aCalls, "schema should export 'a2aCalls'")
})

test("F026 I4 / ADR-002: migrate creates a2a_calls table with Call Tree fields", () => {
  const h = tmpDb()
  try {
    const row = h.store.db
      .prepare(
        `SELECT name FROM pragma_table_info('a2a_calls') WHERE name IN (
          'call_id','parent_call_id','root_call_id','issuer_id','convener_id',
          'on_behalf_of','reply_to','deadline_at','join_set_id','status',
          'envelope_version','session_group_id','created_at','updated_at'
        ) ORDER BY name`,
      )
      .all() as Array<{ name: string }>
    const got = row.map((r) => r.name).sort()
    const want = [
      "call_id",
      "convener_id",
      "created_at",
      "deadline_at",
      "envelope_version",
      "issuer_id",
      "join_set_id",
      "on_behalf_of",
      "parent_call_id",
      "reply_to",
      "root_call_id",
      "session_group_id",
      "status",
      "updated_at",
    ]
    assert.deepEqual(got, want)
  } finally {
    h.close()
  }
})

test("F026 I7: a2a_calls roundtrip insert+select with Call Tree fields", () => {
  const h = tmpDb()
  try {
    h.store.db
      .prepare(
        `INSERT INTO a2a_calls (
          call_id, parent_call_id, root_call_id,
          issuer_id, convener_id, on_behalf_of,
          reply_to, deadline_at, join_set_id,
          status, envelope_version, session_group_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "call-1",
        null,
        "call-1",
        "黄仁勋",
        "小孙",
        null,
        "agent:黄仁勋",
        "2026-04-23T14:00:00.000Z",
        null,
        "pending",
        "v1",
        "group-A",
        "2026-04-23T13:00:00.000Z",
        "2026-04-23T13:00:00.000Z",
      )

    const row = h.store.db
      .prepare("SELECT * FROM a2a_calls WHERE call_id = ?")
      .get("call-1") as Record<string, unknown>

    assert.equal(row.call_id, "call-1")
    assert.equal(row.parent_call_id, null)
    assert.equal(row.root_call_id, "call-1")
    assert.equal(row.issuer_id, "黄仁勋")
    assert.equal(row.convener_id, "小孙")
    assert.equal(row.on_behalf_of, null)
    assert.equal(row.reply_to, "agent:黄仁勋")
    assert.equal(row.deadline_at, "2026-04-23T14:00:00.000Z")
    assert.equal(row.status, "pending")
    assert.equal(row.envelope_version, "v1")
    assert.equal(row.session_group_id, "group-A")
  } finally {
    h.close()
  }
})

test("F026 I4: CAS pattern — UPDATE ... WHERE status='pending' only succeeds once", () => {
  const h = tmpDb()
  try {
    h.store.db
      .prepare(
        `INSERT INTO a2a_calls (
          call_id, root_call_id, issuer_id, convener_id, reply_to,
          deadline_at, status, envelope_version, session_group_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "call-2",
        "call-2",
        "黄仁勋",
        "小孙",
        "agent:黄仁勋",
        "2026-04-23T14:00:00.000Z",
        "pending",
        "v1",
        "group-A",
        "2026-04-23T13:00:00.000Z",
        "2026-04-23T13:00:00.000Z",
      )

    const first = h.store.db
      .prepare(
        "UPDATE a2a_calls SET status='working', updated_at=? WHERE call_id=? AND status='pending'",
      )
      .run("2026-04-23T13:05:00.000Z", "call-2")
    assert.equal(first.changes, 1, "first CAS should succeed")

    const second = h.store.db
      .prepare(
        "UPDATE a2a_calls SET status='working', updated_at=? WHERE call_id=? AND status='pending'",
      )
      .run("2026-04-23T13:05:01.000Z", "call-2")
    assert.equal(second.changes, 0, "second CAS must fail — status no longer pending")
  } finally {
    h.close()
  }
})

test("F026 I4: idx_a2a_calls_parent covers pendingOf(parent) query", () => {
  const h = tmpDb()
  try {
    const indexes = h.store.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='a2a_calls' ORDER BY name`,
      )
      .all() as Array<{ name: string }>
    const names = indexes.map((i) => i.name)
    assert.ok(
      names.includes("idx_a2a_calls_parent"),
      `expected idx_a2a_calls_parent in ${JSON.stringify(names)}`,
    )
    assert.ok(
      names.includes("idx_a2a_calls_root"),
      `expected idx_a2a_calls_root in ${JSON.stringify(names)}`,
    )
    assert.ok(
      names.includes("idx_a2a_calls_status_deadline"),
      `expected idx_a2a_calls_status_deadline in ${JSON.stringify(names)}`,
    )
  } finally {
    h.close()
  }
})

// ─── F027 v3 G12 · a2a_calls 查询 perf ≤ 50ms 断言 ────────────────────

test("F027 v3 G12: a2a_calls 高频查询 (parent / root / status+deadline) 1k 行 ≤ 50ms (V16.5 chap 11 a2a_calls index perf AC)", () => {
  const h = tmpDb()
  try {
    // seed 1000 rows 覆盖三类查询 hot path:
    // - parent (Tree pendingOf)
    // - root (callTree)
    // - status+deadline (sweep timeout)
    const now = new Date()
    const insertStmt = h.store.db.prepare(
      `INSERT INTO a2a_calls (
        call_id, parent_call_id, root_call_id, issuer_id, convener_id,
        on_behalf_of, reply_to, deadline_at, join_set_id, status,
        envelope_version, session_group_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // 直接 loop insert (h.store.db 不是 raw better-sqlite3, 无 transaction() API)
    for (let i = 0; i < 1000; i += 1) {
      const id = `call-${i.toString().padStart(4, "0")}`
      const parent =
        i > 0 && i % 5 === 0 ? `call-${(i - 5).toString().padStart(4, "0")}` : null
      const root = i < 100 ? id : `call-${(i % 100).toString().padStart(4, "0")}`
      const status =
        i % 4 === 0 ? "pending" : i % 4 === 1 ? "working" : i % 4 === 2 ? "done" : "failed"
      const deadline = new Date(now.getTime() + i * 60_000).toISOString()
      insertStmt.run(
        id,
        parent,
        root,
        "issuer-1",
        "convener-1",
        null,
        "reply-1",
        deadline,
        null,
        status,
        "v1",
        "sg-1",
        now.toISOString(),
        now.toISOString(),
      )
    }
    // 三个 hot path 查询，每个 ≤ 50ms
    const queries: Array<{ name: string; sql: string; params: ReadonlyArray<string | number> }> = [
      {
        name: "pendingOf(parent)",
        sql: "SELECT call_id FROM a2a_calls WHERE parent_call_id = ? AND status IN ('pending','working')",
        params: ["call-0050"],
      },
      {
        name: "callTree(root)",
        sql: "SELECT call_id, parent_call_id FROM a2a_calls WHERE root_call_id = ?",
        params: ["call-0010"],
      },
      {
        name: "sweep timeout (status+deadline)",
        sql: "SELECT call_id FROM a2a_calls WHERE status IN ('pending','working') AND datetime(deadline_at) < datetime(?)",
        params: [new Date(now.getTime() + 30 * 60_000).toISOString()],
      },
    ]
    for (const q of queries) {
      const stmt = h.store.db.prepare(q.sql)
      const t0 = performance.now()
      stmt.all(...q.params)
      const elapsedMs = performance.now() - t0
      assert.ok(
        elapsedMs <= 50,
        `${q.name} should be ≤ 50ms over 1k rows; got ${elapsedMs.toFixed(2)}ms`,
      )
    }
  } finally {
    h.close()
  }
})
