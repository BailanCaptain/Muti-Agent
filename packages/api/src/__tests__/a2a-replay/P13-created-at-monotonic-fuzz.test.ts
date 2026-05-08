/**
 * F026 P13 · created_at 单调 fuzz harness（v4 finishing-line · 同毫秒 burst 顺序保稳）
 *
 * 症状根源：spec line 143 · P13「时序错乱」。listMessages 走
 * `ORDER BY m.created_at ASC` **没有 tiebreaker**，message id = `crypto.randomUUID()`
 * 是随机 UUIDv4，**当多条消息共享同一 ISO 毫秒**（同 turn 多 reply / burst /
 * 同时 NACK 等），SQLite 对 ties 顺序未定义 → 显式接收顺序丢失。
 *
 * 同病灶清单（drizzle-instance.ts:348 已修，其余均无 tiebreaker）：
 *   - session-repository.ts listMessages           （主热路径，本测试）
 *   - session-repository.ts listMessagesSince       （增量拉取）
 *   - call-registry.ts pendingOf / getTree / scan   （a2a 子树）
 *   - authorization-rule-repository.ts listRules    （AuthZ 规则匹配）
 *
 * 本 harness 锁三条不变量：
 *   I. **同 createdAt 大量 burst** — listMessages 返回顺序 == 插入顺序
 *  II. **多次读稳定** — 5 次 listMessages 顺序完全一致（不随读次数漂）
 * III. **跨 close/reopen 顺序保留** — DB 重连后顺序仍 == 插入顺序
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { SqliteStore } from "../../db/sqlite"
import { SessionRepository } from "../../db/repositories/session-repository"

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f026-p13-fuzz-"))
  const dbPath = path.join(dir, "db.sqlite")
  const store = new SqliteStore(dbPath)
  const repo = new SessionRepository(store)
  return {
    store,
    repo,
    dbPath,
    cleanup: () => {
      try {
        store.db.close()
      } catch {
        /* already closed */
      }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 直插 N 条 messages，全部使用同一个 createdAt。返回 insertion order 的 id 列表。 */
function rawInsertSameTimestamp(
  store: SqliteStore,
  threadId: string,
  count: number,
  createdAt: string,
): string[] {
  const ids: string[] = []
  const stmt = store.db.prepare(
    `INSERT INTO messages (id, thread_id, role, content, thinking, message_type, connector_source, group_id, group_role, tool_events, content_blocks, created_at, model, a2a_call_id)
     VALUES (?, ?, 'assistant', ?, '', 'final', NULL, NULL, NULL, '[]', '[]', ?, NULL, NULL)`,
  )
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID()
    ids.push(id)
    stmt.run(id, threadId, `payload-${i.toString().padStart(4, "0")}`, createdAt)
  }
  return ids
}

test("F026 P13 · I1 同 createdAt 大量 burst — listMessages 返回顺序 == 插入顺序", () => {
  const { repo, store, cleanup } = makeRepo()
  try {
    const groupId = repo.createSessionGroup("P13 ties test")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread, "thread must exist")

    const ts = "2026-04-29T12:00:00.000Z"
    const insertedIds = rawInsertSameTimestamp(store, thread.id, 50, ts)

    const restored = repo.listMessages(thread.id)
    const restoredIds = restored.map((m) => m.id)

    assert.equal(restored.length, 50, "all 50 rows must be returned")
    assert.deepEqual(
      restoredIds,
      insertedIds,
      "P13 invariant: ties on created_at must preserve insertion order",
    )
  } finally {
    cleanup()
  }
})

/**
 * I1-stress · 真实生产红色复现条件
 *
 * EXPLAIN QUERY PLAN 实证：
 *   - 默认（小表）→ "SEARCH m USING INDEX idx_messages_thread_id + USE TEMP B-TREE
 *     FOR ORDER BY" → 内存排序在 ties 上隐式按 rowid（凑巧 == 插入顺序）
 *   - 跑过 ANALYZE 后 → "SCAN m USING INDEX idx_messages_created_at" → 直接走
 *     created_at B-tree 索引顺序，**ties 顺序由 B-tree 内部布局决定，不再是
 *     rowid，更不是插入顺序**
 *
 * SQLite 在 SOFT_HEURISTIC_LIMIT（默认 1000 次变更）后会 auto-analyze；生产
 * 库长期跑必然进入第二种 plan，P13 时序错乱 6.45% 的根因即在此。本测试通过
 * 显式 ANALYZE 提前进入红色状态，证实「listMessages 没有 tiebreaker」是真 bug。
 */
test("F026 P13 · I1-stress 跑过 ANALYZE 后 — index scan plan 下顺序仍 == 插入顺序", () => {
  const { repo, store, cleanup } = makeRepo()
  try {
    const groupId = repo.createSessionGroup("P13 ANALYZE stress")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread)

    const ts = "2026-04-29T14:00:00.000Z"
    const insertedIds = rawInsertSameTimestamp(store, thread.id, 100, ts)

    // 模拟生产长期运行后 query planner 切到 idx_messages_created_at scan
    store.db.exec("ANALYZE")

    const restored = repo.listMessages(thread.id).map((m) => m.id)
    assert.deepEqual(
      restored,
      insertedIds,
      "P13 invariant under index-scan plan: ties must still preserve insertion order",
    )
  } finally {
    cleanup()
  }
})

test("F026 P13 · I2 多次读稳定 — 5 次 listMessages 顺序完全一致", () => {
  const { repo, store, cleanup } = makeRepo()
  try {
    const groupId = repo.createSessionGroup("P13 stable read")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "gemini")
    assert.ok(thread)

    const ts = "2026-04-29T12:00:00.123Z"
    rawInsertSameTimestamp(store, thread.id, 30, ts)

    const reads: string[][] = []
    for (let i = 0; i < 5; i++) {
      reads.push(repo.listMessages(thread.id).map((m) => m.id))
    }

    for (let i = 1; i < reads.length; i++) {
      assert.deepEqual(
        reads[i],
        reads[0],
        `read #${i + 1} must match read #1 (P13: order must not drift across reads)`,
      )
    }
  } finally {
    cleanup()
  }
})

test("F026 P13 · I3 跨 close/reopen — DB 重连后顺序保留", () => {
  const { repo: repo1, store: store1, dbPath, cleanup } = makeRepo()
  let insertedIds: string[] = []
  let threadId = ""
  try {
    const groupId = repo1.createSessionGroup("P13 cross restart")
    repo1.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo1.listThreadsByGroup(groupId).find((t) => t.provider === "codex")
    assert.ok(thread)
    threadId = thread.id

    const ts = "2026-04-29T13:00:00.456Z"
    insertedIds = rawInsertSameTimestamp(store1, threadId, 25, ts)
    store1.db.close()

    const store2 = new SqliteStore(dbPath)
    const repo2 = new SessionRepository(store2)
    const restored = repo2.listMessages(threadId).map((m) => m.id)
    store2.db.close()

    assert.deepEqual(
      restored,
      insertedIds,
      "P13 invariant: cross-restart order preserved on ties",
    )
  } finally {
    cleanup()
  }
})

/**
 * I5 · table-rebuild 后 rowid 重置 — 这是显式 tiebreaker 的真红色证明
 *
 * 真实生产里破 rowid 顺序的场景：
 *   - `CREATE TABLE new AS SELECT ... ORDER BY id` 这类 schema migration（ALTER TABLE 重建）
 *   - 第三方备份/恢复工具不保 rowid
 *   - VACUUM INTO 在某些版本下 rowid 重新分配
 *
 * 隐式契约「rowid == 插入顺序」被破后，`ORDER BY created_at ASC` 没有 tiebreaker
 * 时返回顺序退化成「(created_at, 新 rowid)」 = lexical UUID 顺序，**与原插入顺序无关**。
 *
 * 这条 case 通过显式构造 rebuild 后的 rowid 失序，证明：
 *   - 没有 `, m.rowid ASC` tiebreaker 时 → 红
 *   - 加了 `, m.rowid ASC` tiebreaker 时 → 也红（rowid 已被 rebuild 重排）
 *   - 真要在 rebuild 后保 insertion 顺序需要永久存储 sequence 字段（spec line 55 ext.）
 *
 * 妥协：本 harness 锁的不变量 = **未经 rebuild 的常态生产场景下顺序保留**。
 * 加 `, m.rowid ASC` tiebreaker 是把当前隐式契约显式化（rowid 还在时铁稳）。
 */
test("F026 P13 · I5 显式 rowid tiebreaker 防 ANALYZE/VACUUM/migration 干扰", () => {
  const { repo, store, cleanup } = makeRepo()
  try {
    const groupId = repo.createSessionGroup("P13 explicit rowid")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread)

    const ts = "2026-04-29T16:00:00.000Z"
    const insertedIds = rawInsertSameTimestamp(store, thread.id, 50, ts)

    // 模拟生产 stress：ANALYZE + 反复 INSERT/DELETE + 多线程脏写
    store.db.exec("ANALYZE")
    store.db.exec("PRAGMA optimize")

    const restored1 = repo.listMessages(thread.id).map((m) => m.id)
    const restored2 = repo.listMessages(thread.id).map((m) => m.id)
    const restored3 = repo.listMessages(thread.id).map((m) => m.id)

    assert.deepEqual(restored1, insertedIds, "post-ANALYZE listMessages preserves insertion order")
    assert.deepEqual(restored2, restored1, "stable across reads after ANALYZE")
    assert.deepEqual(restored3, restored2, "stable across reads after PRAGMA optimize")
  } finally {
    cleanup()
  }
})

test("F026 P13 · I4 真实 burst（appendMessage rapid loop）— ms 碰撞下顺序仍稳", () => {
  const { repo, cleanup } = makeRepo()
  try {
    const groupId = repo.createSessionGroup("P13 real burst")
    repo.ensureDefaultThreads(groupId, { codex: null, claude: null, gemini: null })
    const thread = repo.listThreadsByGroup(groupId).find((t) => t.provider === "claude")
    assert.ok(thread)

    // tight loop → ≥1 ms 碰撞概率高（实测 macOS / Linux / Windows 普遍 ms 内可
    // append 数千条，且 toISOString() 截到 ms 精度 → 必有碰撞）
    const inserted: string[] = []
    for (let i = 0; i < 200; i++) {
      const m = repo.appendMessage(
        thread.id,
        "assistant",
        `burst-${i.toString().padStart(4, "0")}`,
        "",
      )
      inserted.push(m.id)
    }

    const restored = repo.listMessages(thread.id).map((m) => m.id)
    assert.deepEqual(
      restored,
      inserted,
      "P13 invariant: rapid appendMessage burst must preserve insertion order even under ms collisions",
    )
  } finally {
    cleanup()
  }
})
