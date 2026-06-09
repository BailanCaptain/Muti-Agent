/**
 * F027 v3 G6 · WikiStoryService 单测
 *
 * ⚠️ F027 chunk B：wiki_memories 表已砍（冗余第二存储）。本测试随之改契约：
 *   - 5 个结构化记忆类型桶（room/project/user/feedback/work）**恒返 0**
 *     （无数据源；G11 compile pipeline 接入文件后才有真数据）。
 *   - conversation 桶（messages）+ totalDecisions/recent7d.decisionNew（room_decisions）
 *     仍是真数据。
 *   - safeCount 对 no-such-table（messages/room_decisions schema mismatch）仍抛错（不伪装 0）。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { WikiStoryService } from "./wiki-story"

function safeTempDir(prefix: string): string {
  const base = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, prefix))
}

function safeCleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

type RawClient = {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown }
}

function rawClient(db: ReturnType<typeof createDrizzleDb>["db"]): RawClient {
  return (db as unknown as { $client: RawClient }).$client
}

function insertDecision(
  db: ReturnType<typeof createDrizzleDb>["db"],
  decidedAt: string,
): void {
  rawClient(db)
    .prepare(
      `INSERT INTO room_decisions (
        room_id, decided_at, decided_by, decision_type, content,
        source_message_ids, source_quote, source_hash, fencing_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "R-G6-test",
      decidedAt,
      "黄仁勋",
      "commit",
      "test decision content",
      JSON.stringify(["msg-1"]),
      "test quote",
      "abc123",
      "tok-1",
    )
}

function insertMessages(db: ReturnType<typeof createDrizzleDb>["db"], count: number): void {
  const client = rawClient(db)
  const now = new Date().toISOString()
  client
    .prepare("INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("sg-1", "Test SG", now, now)
  client
    .prepare(
      "INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("th-1", "sg-1", "claude", "user", now)
  for (let i = 0; i < count; i += 1) {
    client
      .prepare("INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`m-${i}`, "th-1", i % 2 === 0 ? "user" : "assistant", `body ${i}`, now)
  }
}

test("G6 · getStory: 5 结构化桶 + conversation 桶 全部返回", () => {
  const tmp = safeTempDir("F027-G6-empty-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const svc = new WikiStoryService({ db })
    const story = svc.getStory()
    assert.equal(story.buckets.length, 6, "5 结构化类型 + 1 conversation")
    const types = story.buckets.map((b) => b.type).sort()
    assert.deepEqual(types, ["conversation", "feedback", "project", "room", "user", "work"])
    assert.equal(story.totalEntities, 0)
    assert.equal(story.totalDecisions, 0)
    assert.equal(story.recent7d.length, 7)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("F027 chunk B · 5 结构化记忆桶恒返 0（表已砍，无数据源）", () => {
  const tmp = safeTempDir("F027-chunkB-zero-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const svc = new WikiStoryService({ db })
    const story = svc.getStory()
    for (const type of ["room", "project", "user", "feedback", "work"]) {
      const b = story.buckets.find((x) => x.type === type)!
      assert.equal(b.totalCount, 0, `${type} totalCount=0`)
      assert.equal(b.canonicalCount, 0)
      assert.equal(b.draftCount, 0)
      assert.deepEqual(b.topEntities, [])
    }
    assert.equal(story.totalEntities, 0)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("G6 · conversation 桶 走 messages 表 (真数据)", () => {
  const tmp = safeTempDir("F027-G6-conv-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertMessages(db, 3)
    const svc = new WikiStoryService({ db })
    const conv = svc.getStory().buckets.find((b) => b.type === "conversation")!
    assert.equal(conv.totalCount, 3, "user+assistant 三条")
    assert.equal(conv.canonicalCount, 3)
    assert.equal(conv.draftCount, 0)
    assert.deepEqual(conv.topEntities, [], "conversation 桶不暴露 message-level entity")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("G6 · recent7d: decisionNew 真数据 + entityNew 恒 0（表已砍）", () => {
  const tmp = safeTempDir("F027-G6-growth-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    insertDecision(db, `${yesterday}T05:00:00.000Z`)
    insertDecision(db, `${yesterday}T15:00:00.000Z`)
    insertDecision(db, `${today}T10:00:00.000Z`)

    const svc = new WikiStoryService({ db })
    const story = svc.getStory()
    const todayPoint = story.recent7d.find((p) => p.day === today)!
    const yesterdayPoint = story.recent7d.find((p) => p.day === yesterday)!
    assert.equal(todayPoint.decisionNew, 1)
    assert.equal(yesterdayPoint.decisionNew, 2)
    // entityNew 恒 0（wiki_memories 表已砍）
    assert.equal(todayPoint.entityNew, 0)
    assert.equal(yesterdayPoint.entityNew, 0)
    assert.equal(story.totalDecisions, 3)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("G6 r2 · safeCount: schema mismatch (no such table) 抛错而非伪装 0 (codex P2 修)", () => {
  // messages / room_decisions schema mismatch → safeCount rethrow → endpoint 500（不伪装空 stats）。
  const fakeDb = {
    $client: {
      prepare: (_sql: string) => ({
        get: () => {
          throw new Error("SQLITE_ERROR: no such table: messages")
        },
        all: () => {
          throw new Error("SQLITE_ERROR: no such table: messages")
        },
        run: () => {
          throw new Error("SQLITE_ERROR: no such table: messages")
        },
      }),
    },
  } as unknown as ReturnType<typeof createDrizzleDb>["db"]
  const svc = new WikiStoryService({ db: fakeDb })
  assert.throws(() => svc.getStory(), /no such table/i)
})
