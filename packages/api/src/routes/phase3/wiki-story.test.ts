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

function insertEntity(
  db: ReturnType<typeof createDrizzleDb>["db"],
  row: { path: string; bucket: string; name: string; body?: string; indexedAt?: string },
): void {
  rawClient(db)
    .prepare(
      `INSERT INTO wiki_entity_index (path, bucket, name, body, source_hash, mtime_ms, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.path,
      row.bucket,
      row.name,
      row.body ?? "body",
      `hash-${row.name}`,
      1,
      row.indexedAt ?? "2026-06-10T00:00:00.000Z",
    )
}

test("F027 续 · 5 结构化桶接 wiki_entity_index 文件真数据（bucket 目录映射 + draft 判定）", () => {
  const tmp = safeTempDir("F027-cont-buckets-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertEntity(db, { path: "wiki/rooms/R-1/session-summary.md", bucket: "rooms", name: "session-summary" })
    insertEntity(db, { path: "wiki/rooms/R-1/viewfinder.md", bucket: "rooms", name: "viewfinder" })
    insertEntity(db, {
      path: "wiki/concepts/draft/_auto/F011-x.md",
      bucket: "concepts",
      name: "F011-x",
      body: "---\ncanonical_owner_path: wiki/concepts/F011-x.md\nsupersedes:\n  - wiki/concepts/old-f011.md\n---\n# F011",
    })
    insertEntity(db, { path: "wiki/people/小孙.md", bucket: "people", name: "小孙" })
    insertEntity(db, { path: "wiki/feedback/lesson-1.md", bucket: "feedback", name: "lesson-1" })
    // rules 不映射 5 桶，但计入 totalEntities
    insertEntity(db, { path: "wiki/rules/iron-laws.md", bucket: "rules", name: "iron-laws" })

    const svc = new WikiStoryService({ db })
    const story = svc.getStory()
    const byType = new Map(story.buckets.map((b) => [b.type, b]))
    assert.equal(byType.get("room")?.totalCount, 2)
    assert.equal(byType.get("room")?.canonicalCount, 2)
    assert.equal(byType.get("project")?.totalCount, 1)
    assert.equal(byType.get("project")?.draftCount, 1, "draft/ 路径应判 draft")
    assert.equal(byType.get("user")?.totalCount, 1)
    assert.equal(byType.get("feedback")?.totalCount, 1)
    assert.equal(byType.get("work")?.totalCount, 0, "work 与 project 同 concepts/ 目录不可分，并入 project")
    assert.equal(story.totalEntities, 6, "rules 等非 5 桶 bucket 也计入总数")

    // topEntities frontmatter 解析
    const projTop = byType.get("project")?.topEntities[0]
    assert.equal(projTop?.state, "draft")
    assert.equal(projTop?.canonicalOwnerPath, "wiki/concepts/F011-x.md")
    assert.deepEqual(projTop?.supersedes, ["wiki/concepts/old-f011.md"])
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

function insertWikiEvent(
  db: ReturnType<typeof createDrizzleDb>["db"],
  row: { ts: string; action: string; state: string },
): void {
  rawClient(db)
    .prepare(
      `INSERT INTO wiki_events (ts, alias, action, path, attempted_hash, fencing_token, leader_term, result, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.ts, "test", row.action, "wiki/concepts/x.md", "h", "tok", "999", "ok", row.state)
}

test("F027 续 · recent7d: decisionNew 真数据 + entityNew 接 wiki_events committed write/ingest", () => {
  const tmp = safeTempDir("F027-G6-growth-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    insertDecision(db, `${yesterday}T05:00:00.000Z`)
    insertDecision(db, `${yesterday}T15:00:00.000Z`)
    insertDecision(db, `${today}T10:00:00.000Z`)
    // entityNew 源：committed write/ingest 计入；pending / 非 write 类不计
    insertWikiEvent(db, { ts: `${yesterday}T06:00:00.000Z`, action: "write", state: "committed" })
    insertWikiEvent(db, { ts: `${yesterday}T07:00:00.000Z`, action: "ingest", state: "committed" })
    insertWikiEvent(db, { ts: `${yesterday}T08:00:00.000Z`, action: "write", state: "pending" })
    insertWikiEvent(db, { ts: `${today}T09:00:00.000Z`, action: "promote", state: "committed" })
    insertWikiEvent(db, { ts: `${today}T11:00:00.000Z`, action: "write", state: "committed" })

    const svc = new WikiStoryService({ db })
    const story = svc.getStory()
    const todayPoint = story.recent7d.find((p) => p.day === today)!
    const yesterdayPoint = story.recent7d.find((p) => p.day === yesterday)!
    assert.equal(todayPoint.decisionNew, 1)
    assert.equal(yesterdayPoint.decisionNew, 2)
    assert.equal(yesterdayPoint.entityNew, 2, "committed write+ingest 计 2；pending 不计")
    assert.equal(todayPoint.entityNew, 1, "promote 不计 entityNew")
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
