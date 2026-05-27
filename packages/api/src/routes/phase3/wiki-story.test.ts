/**
 * F027 v3 G6 · WikiStoryService 单测
 *
 * 覆盖:
 *   - getStory() 返 5 类 wikiMemories 桶 + 1 类 conversation (messages) 桶
 *   - bucket totalCount / canonicalCount / draftCount 准确
 *   - topEntities 按 updatedAt desc + 含 supersedes JSON 解析
 *   - recent7d 7 天每日 entity+decision 新增 count
 *   - 表不存在 / schema mismatch → fail-soft 返 0 (不抛)
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

interface InsertMemoryOpts {
  type: string
  name: string
  state?: "draft" | "canonical" | "deprecated"
  supersedes?: string[]
  createdAt?: string
  updatedAt?: string
}

function insertMemory(
  db: ReturnType<typeof createDrizzleDb>["db"],
  opts: InsertMemoryOpts,
): void {
  const client = (db as unknown as { $client: { prepare: (sql: string) => {
    run: (...args: unknown[]) => unknown
  } } }).$client
  const now = new Date().toISOString()
  client
    .prepare(
      `INSERT INTO wiki_memories (
        type, name, canonical_owner_path, contributed_by, body, state,
        supersedes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.type,
      opts.name,
      `wiki/${opts.type}/${opts.name}.md`,
      JSON.stringify(["黄仁勋"]),
      "test body",
      opts.state ?? "canonical",
      opts.supersedes ? JSON.stringify(opts.supersedes) : null,
      opts.createdAt ?? now,
      opts.updatedAt ?? now,
    )
}

function insertDecision(
  db: ReturnType<typeof createDrizzleDb>["db"],
  decidedAt: string,
): void {
  const client = (db as unknown as { $client: { prepare: (sql: string) => {
    run: (...args: unknown[]) => unknown
  } } }).$client
  client
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

test("G6 · getStory: 5 桶 + conversation 桶 全部返回", () => {
  const tmp = safeTempDir("F027-G6-empty-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const svc = new WikiStoryService({ db })
    const story = svc.getStory()
    assert.equal(story.buckets.length, 6, "5 wikiMemories types + 1 conversation")
    const types = story.buckets.map((b) => b.type).sort()
    assert.deepEqual(types, [
      "conversation",
      "feedback",
      "project",
      "room",
      "user",
      "work",
    ])
    assert.equal(story.totalEntities, 0)
    assert.equal(story.totalDecisions, 0)
    assert.equal(story.recent7d.length, 7)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("G6 · getStory: bucket totalCount / canonicalCount / draftCount 准确", () => {
  const tmp = safeTempDir("F027-G6-bucket-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertMemory(db, { type: "work", name: "w1", state: "canonical" })
    insertMemory(db, { type: "work", name: "w2", state: "canonical" })
    insertMemory(db, { type: "work", name: "w3", state: "draft" })
    insertMemory(db, { type: "work", name: "w4", state: "deprecated" }) // 应排除
    insertMemory(db, { type: "project", name: "p1", state: "canonical" })

    const svc = new WikiStoryService({ db })
    const story = svc.getStory()
    const workBucket = story.buckets.find((b) => b.type === "work")!
    assert.equal(workBucket.totalCount, 3, "deprecated 不算 total")
    assert.equal(workBucket.canonicalCount, 2)
    assert.equal(workBucket.draftCount, 1)
    const projectBucket = story.buckets.find((b) => b.type === "project")!
    assert.equal(projectBucket.totalCount, 1)
    // totalEntities = work 3 + project 1 = 4 (5 wikiMemories 类型加总，不算 conversation)
    assert.equal(story.totalEntities, 4)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("G6 · getStory: topEntities 按 updatedAt desc + supersedes JSON 解析", () => {
  const tmp = safeTempDir("F027-G6-top-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertMemory(db, {
      type: "user",
      name: "u-old",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    insertMemory(db, {
      type: "user",
      name: "u-new",
      updatedAt: "2026-05-28T00:00:00.000Z",
      supersedes: ["wiki/user/u-old.md", "wiki/user/u-vold.md"],
    })
    const svc = new WikiStoryService({ db })
    const userBucket = svc.getStory().buckets.find((b) => b.type === "user")!
    assert.equal(userBucket.topEntities.length, 2)
    assert.equal(userBucket.topEntities[0].name, "u-new", "updatedAt desc 排序")
    assert.deepEqual(userBucket.topEntities[0].supersedes, [
      "wiki/user/u-old.md",
      "wiki/user/u-vold.md",
    ])
    assert.deepEqual(userBucket.topEntities[1].supersedes, [])
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("G6 · getStory: recent7d 当日新增 entity+decision count", () => {
  const tmp = safeTempDir("F027-G6-growth-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10)
    insertMemory(db, {
      type: "feedback",
      name: "fb1",
      createdAt: `${today}T08:00:00.000Z`,
    })
    insertMemory(db, {
      type: "feedback",
      name: "fb2",
      createdAt: `${today}T12:00:00.000Z`,
    })
    insertDecision(db, `${yesterday}T05:00:00.000Z`)
    insertDecision(db, `${yesterday}T15:00:00.000Z`)
    insertDecision(db, `${today}T10:00:00.000Z`)

    const svc = new WikiStoryService({ db })
    const story = svc.getStory()
    const todayPoint = story.recent7d.find((p) => p.day === today)!
    const yesterdayPoint = story.recent7d.find((p) => p.day === yesterday)!
    assert.equal(todayPoint.entityNew, 2)
    assert.equal(todayPoint.decisionNew, 1)
    assert.equal(yesterdayPoint.entityNew, 0)
    assert.equal(yesterdayPoint.decisionNew, 2)
    assert.equal(story.totalDecisions, 3)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("G6 r2 · safeCount: schema mismatch (no such table) 抛错而非伪装 0 (codex P2 修)", () => {
  // 直接 fake adapter prepare 抛 "no such table" → safeCount 应 rethrow
  // 模拟 production 未跑迁移 / 表名错 → 上层 fastify route 应返 500 而非空 stats
  const fakeDb = {
    $client: {
      prepare: (_sql: string) => ({
        get: () => {
          throw new Error("SQLITE_ERROR: no such table: wiki_memories")
        },
        all: () => {
          throw new Error("SQLITE_ERROR: no such table: wiki_memories")
        },
        run: () => {
          throw new Error("SQLITE_ERROR: no such table: wiki_memories")
        },
      }),
    },
  } as unknown as ReturnType<typeof createDrizzleDb>["db"]
  const svc = new WikiStoryService({ db: fakeDb })
  // getStory 内部第一个 queryBucket → safeCount 抛 → endpoint 应错
  assert.throws(() => svc.getStory(), /no such table/i)
})

// Note: 不测 "其他 SQL syntax 错 fail-soft 0" — queryBucket / queryRecent7d 内的
// prepare/get 不走 safeCount，直接 throw bubble up；只有 conversation count 和
// recent7d 内单 query 走 safeCount。设计如此 (queryBucket 是核心 query 必抛)，
// 此测试 lock 与 codex P2 修一致的"safeCount 路径 schema 错抛错"行为。

test("G6 · conversation 桶 走 messages 表 (not wikiMemories)", () => {
  const tmp = safeTempDir("F027-G6-conv-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const client = (db as unknown as { $client: { prepare: (sql: string) => {
      run: (...args: unknown[]) => unknown
    } } }).$client
    // 插一个 thread / session_group 再 insert message
    const now = new Date().toISOString()
    client
      .prepare(
        "INSERT INTO session_groups (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("sg-1", "Test SG", now, now)
    client
      .prepare(
        "INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("th-1", "sg-1", "claude", "user", now)
    for (let i = 0; i < 3; i += 1) {
      client
        .prepare(
          "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(`m-${i}`, "th-1", i % 2 === 0 ? "user" : "assistant", `body ${i}`, now)
    }
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
