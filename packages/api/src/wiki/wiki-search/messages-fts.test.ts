/**
 * F027 P14.b · messages_fts + MessagesFtsRepository 端到端测试
 *
 * 五层覆盖：
 *   1. 触发器同步：INSERT / UPDATE / DELETE on messages → messages_fts 一致
 *   2. MessagesFtsRepository.query: 基本 query / topK / sanitize 兜底
 *   3. roomId / threadId / role 过滤维度
 *   4. 中文 query 命中（trigram tokenizer）
 *   5. backfill：fts 表为空 + messages 非空 → rebuild
 *   6. fail-soft：syntax error / 空 query
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"
import { createDrizzleDb } from "../../db/drizzle-instance"
import * as schema from "../../db/schema"
import { MessagesFtsRepository } from "./messages-fts-repository"

type Adapter = { prepare(sql: string): unknown; exec(sql: string): unknown; close(): void }

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "messages-fts-"))
  const dbPath = path.join(dir, "test.sqlite")
  const { raw, close } = createDrizzleDb(dbPath)
  const drizzleDb = drizzleBetter(raw as never, { schema })
  return {
    drizzle: drizzleDb,
    raw: raw as Adapter,
    cleanup: () => {
      close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 直接走 raw INSERT 建测试数据（session_groups → threads → messages） */
function seedRoom(raw: Adapter, roomId: string, threadIds: string[]) {
  const sgId = `sg-${roomId}`
  const now = "2026-05-13T00:00:00.000Z"
  const ins = raw.prepare(`INSERT INTO session_groups
      (id, room_id, title, created_at, updated_at, title_backfill_attempts)
      VALUES (?, ?, ?, ?, ?, 0)`) as { run(...args: unknown[]): unknown }
  ins.run(sgId, roomId, `room ${roomId}`, now, now)
  for (const tid of threadIds) {
    const insT = raw.prepare(`INSERT INTO threads
      (id, session_group_id, provider, alias, updated_at, session_chain_index)
      VALUES (?, ?, 'claude', '黄仁勋', ?, 1)`) as { run(...args: unknown[]): unknown }
    insT.run(tid, sgId, now)
  }
}

function insertMessage(
  raw: Adapter,
  id: string,
  threadId: string,
  role: string,
  content: string,
  createdAt = "2026-05-13T00:00:00.000Z",
) {
  const ins = raw.prepare(`INSERT INTO messages (id, thread_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)`) as { run(...args: unknown[]): unknown }
  ins.run(id, threadId, role, content, createdAt)
}

function countFtsRows(raw: Adapter): number {
  // SQLite FTS5 external content 表 COUNT(*) 在 SELECT 优化下会回退到 base 表 messages
  // 行数（fts 索引为空时 vacuous true），无法用来检测"索引已填"。这里用 fts5vocab
  // 间接通过 messages_fts_data 内部表行数（fts 索引数据真相源）来读真实索引大小。
  // 真相源：SQLite FTS5 文档 §"External content tables" + sqlite_master.tbl_name LIKE 'messages_fts_%'
  // messages_fts_docsize 表 (一行一 document) 是 external content 模式下的 ground truth。
  try {
    const stmt = raw.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize") as {
      get(): { n: number }
    }
    return stmt.get().n
  } catch {
    return 0
  }
}

function ftsMatchCount(raw: Adapter, query: string): number {
  // 验证"索引可命中"用的是 MATCH 查询，不依赖 COUNT(*)
  const stmt = raw.prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?") as {
    get(arg: string): { n: number }
  }
  return stmt.get(query).n
}

// ─────────────────────────────────────────────────────────────────────
// 1. 触发器同步
// ─────────────────────────────────────────────────────────────────────

describe("messages_fts 触发器同步", () => {
  it("AFTER INSERT messages → messages_fts 行数 +1", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      assert.equal(countFtsRows(raw), 0)
      insertMessage(raw, "m1", "t1", "user", "F011 drizzle backend")
      assert.equal(countFtsRows(raw), 1)
      insertMessage(raw, "m2", "t1", "assistant", "another message")
      assert.equal(countFtsRows(raw), 2)
    } finally {
      cleanup()
    }
  })

  it("AFTER DELETE messages → messages_fts 行数 -1", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "hello world")
      insertMessage(raw, "m2", "t1", "user", "another row")
      assert.equal(countFtsRows(raw), 2)
      const del = raw.prepare("DELETE FROM messages WHERE id = ?") as {
        run(...args: unknown[]): unknown
      }
      del.run("m1")
      assert.equal(countFtsRows(raw), 1)
    } finally {
      cleanup()
    }
  })

  it("AFTER UPDATE messages → messages_fts 内容刷新（旧 query 不命中、新 query 命中）", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "原本内容片段一")
      assert.equal(countFtsRows(raw), 1)
      // sanity：旧串能命中（trigram 需 ≥3 字符）
      assert.equal(ftsMatchCount(raw, '"原本内容"'), 1)

      const upd = raw.prepare("UPDATE messages SET content = ? WHERE id = ?") as {
        run(...args: unknown[]): unknown
      }
      upd.run("更新后的全新内容段落", "m1")
      assert.equal(countFtsRows(raw), 1)
      // 旧串不再命中
      assert.equal(ftsMatchCount(raw, '"原本内容"'), 0)
      // 新串命中
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      const hits = repo.query("全新内容")
      assert.equal(hits.length, 1)
      assert.equal(hits[0].content, "更新后的全新内容段落")
    } finally {
      cleanup()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. MessagesFtsRepository.query 基本
// ─────────────────────────────────────────────────────────────────────

describe("MessagesFtsRepository.query 基本", () => {
  it("英文 query 命中 + score 归一化", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "讨论 F011 backend drizzle 优化")
      insertMessage(raw, "m2", "t1", "user", "F011 drizzle 单独提一次")
      insertMessage(raw, "m3", "t1", "user", "完全无关的消息")
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      const hits = repo.query("F011 drizzle")
      assert.equal(hits.length, 2)
      assert.ok(hits[0].score >= hits[1].score)
      assert.equal(hits[0].score, 1) // 最强 hit 归一化到 1
    } finally {
      cleanup()
    }
  })

  it("中文 query 命中（trigram tokenizer，≥3 字 query）", () => {
    // trigram 物理限制：query 至少需要 3 个字符才能形成一个完整 trigram；
    // 2 字 query 如 '窗口' 命中不到任何文档（trigram 切不出 3-gram）。
    // memory-preflight P11.a generateRecallQueries 已硬下限 ≥2 token，
    // 中文场景 caller 应组合 ≥3 字短语（如 '上下文窗口' / '窗口策略'）。
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "上下文窗口快炸了需要 seal")
      insertMessage(raw, "m2", "t1", "user", "讨论上下文窗口策略")
      insertMessage(raw, "m3", "t1", "user", "unrelated message")
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      const hits = repo.query("上下文窗口")
      assert.equal(hits.length, 2)
      assert.ok(hits.some((h) => h.messageId === "m1"))
      assert.ok(hits.some((h) => h.messageId === "m2"))
    } finally {
      cleanup()
    }
  })

  it("topK 限制", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      for (let i = 0; i < 5; i++) {
        insertMessage(raw, `m${i}`, "t1", "user", `hello world ${i}`)
      }
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      const hits = repo.query("hello", { topK: 3 })
      assert.equal(hits.length, 3)
    } finally {
      cleanup()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. 过滤维度
// ─────────────────────────────────────────────────────────────────────

describe("MessagesFtsRepository.query 过滤", () => {
  it("roomId 过滤聚合该 room 所有 thread", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1", "t2"])
      seedRoom(raw, "R-002", ["t3"])
      insertMessage(raw, "m1", "t1", "user", "F011 in room 1 thread 1")
      insertMessage(raw, "m2", "t2", "user", "F011 in room 1 thread 2")
      insertMessage(raw, "m3", "t3", "user", "F011 in room 2 thread 3")
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      const hits = repo.query("F011", { roomId: "R-001" })
      assert.equal(hits.length, 2)
      assert.ok(hits.every((h) => h.messageId !== "m3"))
    } finally {
      cleanup()
    }
  })

  it("threadId 过滤限单 thread", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1", "t2"])
      insertMessage(raw, "m1", "t1", "user", "F011 in thread 1")
      insertMessage(raw, "m2", "t2", "user", "F011 in thread 2")
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      const hits = repo.query("F011", { threadId: "t1" })
      assert.equal(hits.length, 1)
      assert.equal(hits[0].messageId, "m1")
    } finally {
      cleanup()
    }
  })

  it("role 过滤限消息角色", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "F011 user said")
      insertMessage(raw, "m2", "t1", "assistant", "F011 assistant said")
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      const hits = repo.query("F011", { role: "assistant" })
      assert.equal(hits.length, 1)
      assert.equal(hits[0].messageId, "m2")
    } finally {
      cleanup()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. fail-soft
// ─────────────────────────────────────────────────────────────────────

describe("MessagesFtsRepository.query fail-soft", () => {
  it("空 query → 返 []", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "anything")
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      assert.deepEqual(repo.query(""), [])
      assert.deepEqual(repo.query("   "), [])
      assert.deepEqual(repo.query("!@#$%"), [])
    } finally {
      cleanup()
    }
  })

  it("FTS5 保留字 query 走 phrase quote 不报语法错", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "我们 AND OR NEAR 应该当 token 不当操作符")
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      // 这条 query 在 sanitize 之前会被 FTS5 当成保留字解析报错；sanitize 后 OK
      const hits = repo.query("AND OR")
      assert.ok(hits.length >= 0) // 不抛即 OK（具体是否命中取决于 trigram 内部）
    } finally {
      cleanup()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. backfill：fts 为空 + messages 非空 → rebuild
// ─────────────────────────────────────────────────────────────────────

describe("backfillMessagesFtsIfEmpty", () => {
  it("first-time 建表后 fts 应已通过触发器同步", () => {
    // 新库走 INIT_SQL 路径，messages_fts 在 messages 插入前就建好了
    // 触发器立即同步，backfillMessagesFtsIfEmpty 不会触发（fts 不空）
    // 本测试只验证正常路径不触发 rebuild（即不破坏现有同步）
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "hello world")
      assert.equal(countFtsRows(raw), 1)
    } finally {
      cleanup()
    }
  })

  it("模拟老库场景：DROP messages_fts → 重新 CREATE → backfill 重建", () => {
    const { raw, cleanup } = makeDb()
    try {
      seedRoom(raw, "R-001", ["t1"])
      insertMessage(raw, "m1", "t1", "user", "F011 历史消息一段")
      insertMessage(raw, "m2", "t1", "user", "F011 历史消息二段")
      assert.equal(countFtsRows(raw), 2)
      assert.equal(ftsMatchCount(raw, '"F011"'), 2)

      // 模拟老库：DROP 触发器 + DROP fts 虚拟表（base messages 表不动）
      raw.exec("DROP TRIGGER IF EXISTS messages_fts_ai;")
      raw.exec("DROP TRIGGER IF EXISTS messages_fts_ad;")
      raw.exec("DROP TRIGGER IF EXISTS messages_fts_au;")
      raw.exec("DROP TABLE IF EXISTS messages_fts;")

      // 重建 fts（此时索引为空，但 external content 模式下 COUNT(*) 退回到
      // base 表行数 2 — 不能用 countFtsRows 验证；改用 fts5vocab docsize 真相源）
      raw.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content,
          content='messages',
          content_rowid='rowid',
          tokenize='trigram case_sensitive 0'
        );
      `)
      // rebuild 前索引应为空（messages_fts_docsize 行 = 0）
      assert.equal(countFtsRows(raw), 0)
      // rebuild 前 MATCH 也无命中
      assert.equal(ftsMatchCount(raw, '"F011"'), 0)

      // 发 rebuild 命令（drizzle-instance.ts backfillMessagesFtsIfEmpty 同款）
      raw.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');")
      assert.equal(countFtsRows(raw), 2)
      assert.equal(ftsMatchCount(raw, '"F011"'), 2)

      // rebuild 后 query 应命中
      const drizzleDb = drizzleBetter(raw as never, { schema })
      const repo = new MessagesFtsRepository(drizzleDb)
      const hits = repo.query("F011")
      assert.equal(hits.length, 2)
    } finally {
      cleanup()
    }
  })
})
