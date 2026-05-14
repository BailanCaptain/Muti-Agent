/**
 * F027 P13.3 · Level 3 backend adapter 单元测试
 * 端到端：建临时 sqlite + messages_fts → seed messages → query → 验证 RecallHit shape
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { MessagesFtsRepository } from "../wiki-search/messages-fts-repository"
import { MessagesFtsLevel3Backend } from "./level3-messages-backend"

function setupDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "p13-l3-"))
  const dbPath = path.join(dir, "test.sqlite")
  const { db: drizzleDb, raw, close } = createDrizzleDb(dbPath)
  return { drizzleDb, raw, close, cleanup: () => { close(); rmSync(dir, { recursive: true, force: true }) } }
}

function seedRoom(raw: ReturnType<typeof setupDb>["raw"]) {
  raw.prepare(
    "INSERT INTO session_groups (id, title, created_at, updated_at, room_id) VALUES (?, ?, ?, ?, ?)",
  ).run("sg-1", "R-201 测试", "2026-05-13T00:00:00Z", "2026-05-13T00:00:00Z", "R-201")
  raw.prepare(
    "INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("t-1", "sg-1", "anthropic", "黄仁勋", "2026-05-13T00:00:00Z")
}

function insertMsg(
  raw: ReturnType<typeof setupDb>["raw"],
  id: string,
  content: string,
  role: "user" | "assistant" = "user",
) {
  raw.prepare(
    "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "t-1", role, content, "2026-05-13T01:00:00Z")
}

describe("F027 P13.3 · MessagesFtsLevel3Backend", () => {
  it("queryMessages 转 RecallHit：path=messages/<room>/<msgId>, score [0,1], excerpt 截 200", async () => {
    const { raw, drizzleDb, cleanup } = setupDb()
    try {
      seedRoom(raw)
      insertMsg(raw, "m-1", "drizzle 优化 schema 已经合 dev 了")
      insertMsg(raw, "m-2", "F011 backend hardening 拍 spec 通过", "assistant")
      insertMsg(raw, "m-3", "随便聊聊天气")

      const repo = new MessagesFtsRepository(drizzleDb)
      const backend = new MessagesFtsLevel3Backend(repo)

      const hits = await backend.queryMessages("drizzle", { roomId: "R-201", topK: 5 })

      assert.ok(hits.length >= 1, `应至少命中 1 条 drizzle, 实际 ${hits.length}`)
      const top = hits[0]
      assert.match(top.path, /^messages\/R-201\/m-\d$/, "path 必须是 messages/<room>/<msgId>")
      assert.ok(top.score >= 0 && top.score <= 1, `score 应在 [0,1], 实际 ${top.score}`)
      assert.ok(top.excerpt.length <= 200, "excerpt 应截至 200")
      // 应能命中"drizzle"相关的消息
      assert.match(top.excerpt, /drizzle/)
    } finally {
      cleanup()
    }
  })

  it("无命中 → 返 []（fail-soft）", async () => {
    const { raw, drizzleDb, cleanup } = setupDb()
    try {
      seedRoom(raw)
      insertMsg(raw, "m-1", "聊聊别的话题")
      const repo = new MessagesFtsRepository(drizzleDb)
      const backend = new MessagesFtsLevel3Backend(repo)

      const hits = await backend.queryMessages("完全不存在的关键词xyz", {
        roomId: "R-201",
        topK: 5,
      })
      assert.equal(hits.length, 0)
    } finally {
      cleanup()
    }
  })

  it("roomId 过滤：不同 room 的 messages 不互串", async () => {
    const { raw, drizzleDb, cleanup } = setupDb()
    try {
      seedRoom(raw)
      // 第二个 room
      raw.prepare(
        "INSERT INTO session_groups (id, title, created_at, updated_at, room_id) VALUES (?, ?, ?, ?, ?)",
      ).run("sg-2", "R-202", "2026-05-13T00:00:00Z", "2026-05-13T00:00:00Z", "R-202")
      raw.prepare(
        "INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("t-2", "sg-2", "anthropic", "黄仁勋", "2026-05-13T00:00:00Z")
      raw.prepare(
        "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("m-r202", "t-2", "user", "drizzle 在 R-202 也讨论过", "2026-05-13T01:00:00Z")

      insertMsg(raw, "m-r201", "drizzle 在 R-201 讨论")

      const repo = new MessagesFtsRepository(drizzleDb)
      const backend = new MessagesFtsLevel3Backend(repo)
      const hits = await backend.queryMessages("drizzle", { roomId: "R-201", topK: 10 })

      // 只应命中 R-201 的消息
      const r202Hit = hits.find((h) => h.path.includes("m-r202"))
      assert.equal(r202Hit, undefined, "R-201 query 不应跨房间命中 R-202 消息")
      const r201Hit = hits.find((h) => h.path.includes("m-r201"))
      assert.ok(r201Hit, "应命中 R-201 自己的消息")
    } finally {
      cleanup()
    }
  })
})
