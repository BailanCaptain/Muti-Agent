/**
 * F027 P19.5 · StartupReconciler 测试 — AC-P2-5
 *
 * 覆盖：
 *   - wiki_events state='pending' → 'aborted'（计数正确）
 *   - wiki_events state='committed' / 'aborted' 不动（终态保持）
 *   - room_checkpoints committed_at IS NULL → DELETE（计数正确）
 *   - room_checkpoints committed_at != NULL 不动（已提交保留）
 *   - 空 DB → {0, 0}（无副作用）
 *   - 复合 fixture（pending + uncommitted 同时存在）→ 全清
 *   - 重复 reconcile() → 第二次 {0, 0}（幂等）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { sql } from "drizzle-orm"
import { StartupReconciler } from "./startup-reconciler"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}
function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

async function build() {
  const { createDrizzleDb } = await import("../../db/drizzle-instance")
  const tempDir = safeTempDir("startup-reconciler-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const reconciler = new StartupReconciler({ db })
  return {
    db,
    reconciler,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

function insertWikiEvent(
  db: Awaited<ReturnType<typeof build>>["db"],
  state: "pending" | "committed" | "aborted",
  pathStr: string,
) {
  // 启动期 compiler_leader 行不存在 → reject_stale_leader 触发器跳过 (WHEN EXISTS)
  db.run(
    sql`INSERT INTO wiki_events (
        ts, alias, action, path, attempted_hash, fencing_token, leader_term, result, state
      ) VALUES (
        '2026-05-15T00:00:00.000Z', 'A', 'write', ${pathStr}, 'sha256:x', '1', '0', 'ok', ${state}
      )`,
  )
}

function insertCheckpoint(
  db: Awaited<ReturnType<typeof build>>["db"],
  roomId: string,
  committedAt: string | null,
) {
  db.run(sql`INSERT INTO room_checkpoints (
      room_id, cursor_commit_seq, cursor_message_id, sealed_cursor_seq,
      viewfinder_hash, decisions_hash, log_hash, compiled_at, committed_at,
      fencing_token, leader_term
    ) VALUES (
      ${roomId}, 0, 'msg-1', 0, 'vh', 'dh', 'lh',
      '2026-05-15T00:00:00.000Z', ${committedAt}, '1', '1'
    )`)
}

function getWikiEvent(db: Awaited<ReturnType<typeof build>>["db"], pathStr: string) {
  return db.get<{ state: string }>(
    sql`SELECT state FROM wiki_events WHERE path = ${pathStr} LIMIT 1`,
  )
}

function getCheckpoint(db: Awaited<ReturnType<typeof build>>["db"], roomId: string) {
  return db.get<{ committed_at: string | null }>(
    sql`SELECT committed_at FROM room_checkpoints WHERE room_id = ${roomId}`,
  )
}

test("StartupReconciler · empty DB → {0, 0} no side effect", async () => {
  const { reconciler, cleanup } = await build()
  try {
    const result = reconciler.reconcile()
    assert.deepEqual(result, { wikiEventsAborted: 0, checkpointsDropped: 0 })
  } finally {
    cleanup()
  }
})

test("StartupReconciler · wiki_events state='pending' → 'aborted'", async () => {
  const { db, reconciler, cleanup } = await build()
  try {
    insertWikiEvent(db, "pending", "wiki/a.md")
    insertWikiEvent(db, "pending", "wiki/b.md")
    const result = reconciler.reconcile()
    assert.equal(result.wikiEventsAborted, 2)
    assert.equal(getWikiEvent(db, "wiki/a.md")?.state, "aborted")
    assert.equal(getWikiEvent(db, "wiki/b.md")?.state, "aborted")
  } finally {
    cleanup()
  }
})

test("StartupReconciler · wiki_events 终态行不动（committed/aborted）", async () => {
  const { db, reconciler, cleanup } = await build()
  try {
    insertWikiEvent(db, "committed", "wiki/done.md")
    insertWikiEvent(db, "aborted", "wiki/skipped.md")
    insertWikiEvent(db, "pending", "wiki/in-flight.md")
    const result = reconciler.reconcile()
    assert.equal(result.wikiEventsAborted, 1, "只清 pending 一行")
    assert.equal(getWikiEvent(db, "wiki/done.md")?.state, "committed", "committed 终态保留")
    assert.equal(getWikiEvent(db, "wiki/skipped.md")?.state, "aborted", "已 aborted 不重写")
    assert.equal(getWikiEvent(db, "wiki/in-flight.md")?.state, "aborted", "pending → aborted")
  } finally {
    cleanup()
  }
})

test("StartupReconciler · room_checkpoints committed_at IS NULL → DELETE", async () => {
  const { db, reconciler, cleanup } = await build()
  try {
    insertCheckpoint(db, "R-uncommitted-1", null)
    insertCheckpoint(db, "R-uncommitted-2", null)
    const result = reconciler.reconcile()
    assert.equal(result.checkpointsDropped, 2)
    assert.equal(getCheckpoint(db, "R-uncommitted-1"), undefined, "row 应被删")
    assert.equal(getCheckpoint(db, "R-uncommitted-2"), undefined)
  } finally {
    cleanup()
  }
})

test("StartupReconciler · room_checkpoints committed_at != NULL 保留", async () => {
  const { db, reconciler, cleanup } = await build()
  try {
    insertCheckpoint(db, "R-committed", "2026-05-15T00:00:01.000Z")
    insertCheckpoint(db, "R-uncommitted", null)
    const result = reconciler.reconcile()
    assert.equal(result.checkpointsDropped, 1)
    assert.ok(getCheckpoint(db, "R-committed"), "committed 行应保留")
    assert.equal(getCheckpoint(db, "R-uncommitted"), undefined, "uncommitted 行应被删")
  } finally {
    cleanup()
  }
})

test("StartupReconciler · AC-P2-5 复合 crash injection（pending events + uncommitted checkpoints）", async () => {
  const { db, reconciler, cleanup } = await build()
  try {
    // 模拟旧 leader crash 留下的状态
    insertWikiEvent(db, "pending", "wiki/x.md")
    insertWikiEvent(db, "pending", "wiki/y.md")
    insertWikiEvent(db, "pending", "wiki/z.md")
    insertWikiEvent(db, "committed", "wiki/already-done.md") // 终态，应保留
    insertCheckpoint(db, "R-001", null)
    insertCheckpoint(db, "R-002", null)
    insertCheckpoint(db, "R-003", "2026-05-15T00:00:01.000Z") // 已提交，应保留

    const result = reconciler.reconcile()
    assert.deepEqual(result, { wikiEventsAborted: 3, checkpointsDropped: 2 })

    // 终态行未受影响
    assert.equal(getWikiEvent(db, "wiki/already-done.md")?.state, "committed")
    assert.ok(getCheckpoint(db, "R-003"))
  } finally {
    cleanup()
  }
})

test("StartupReconciler · 重复 reconcile() 幂等 → 第二次 {0, 0}", async () => {
  const { db, reconciler, cleanup } = await build()
  try {
    insertWikiEvent(db, "pending", "wiki/once.md")
    insertCheckpoint(db, "R-once", null)
    const r1 = reconciler.reconcile()
    assert.deepEqual(r1, { wikiEventsAborted: 1, checkpointsDropped: 1 })
    const r2 = reconciler.reconcile()
    assert.deepEqual(r2, { wikiEventsAborted: 0, checkpointsDropped: 0 }, "幂等")
  } finally {
    cleanup()
  }
})
