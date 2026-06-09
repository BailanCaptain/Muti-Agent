/**
 * F027 #285 S2 · migrate-session-memories —— 存量 session_memories 一次性导出 wiki。
 *
 * 契约：
 *   - 每 group 只导**最新**一条摘要（滚动摘要语义，旧版本是历史不导）；
 *   - roomId 从 session_groups.room_id 解析（缺 → sessionGroupId 兜底，与 S1 writer 同口径）；
 *   - **Iron Law：表数据一行不动**（只读导出；物理 DROP 永远小孙手动）；
 *   - 落点 `<wikiRoot>/rooms/<roomId>/session-summary.md`（与 S1 双写同路径 —— 跑过脚本后
 *     新摘要覆盖同一文件，无双轨）。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createDrizzleDb } from "../src/db/drizzle-instance"
import { getSqliteClient } from "../src/routes/phase3/sqlite-helper"
import { migrateSessionMemories } from "./migrate-session-memories"

function makeFixtureDb(tmp: string) {
  const { db, close } = createDrizzleDb(path.join(tmp, "test.sqlite"))
  const client = getSqliteClient(db)
  const now = "2026-06-10T08:00:00.000Z"
  client
    .prepare(
      "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("group-1", "R-201", "g1", now, now)
  client
    .prepare(
      "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("group-2", null, "g2", now, now)
  const ins = client.prepare(
    "INSERT INTO session_memories (id, session_group_id, summary, keywords, created_at) VALUES (?, ?, ?, ?, ?)",
  )
  ins.run("m1", "group-1", "旧摘要 v1", "k1", "2026-06-01T00:00:00.000Z")
  ins.run("m2", "group-1", "最新摘要 v2", "k2", "2026-06-09T00:00:00.000Z")
  ins.run("m3", "group-2", "无房间组摘要", "k3", "2026-06-08T00:00:00.000Z")
  return { db, close, client }
}

test("S2 · 每 group 导最新一条 → rooms/<roomId>/session-summary.md;表一行不动", () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), ".runtime", "f285-migrate-"))
  const wikiRoot = path.join(tmp, "wiki")
  const { db, close, client } = makeFixtureDb(tmp)
  try {
    const result = migrateSessionMemories({ db, wikiRoot })
    assert.equal(result.groups, 2, "两个 group 各导一条")
    assert.equal(result.written, 2)

    const f1 = path.join(wikiRoot, "rooms", "R-201", "session-summary.md")
    assert.ok(fs.existsSync(f1), "group-1 按 room_id 落 R-201")
    const c1 = fs.readFileSync(f1, "utf8")
    assert.ok(c1.includes("最新摘要 v2"), "导最新一条")
    assert.ok(!c1.includes("旧摘要 v1"), "旧版本不导")

    const f2 = path.join(wikiRoot, "rooms", "group-2", "session-summary.md")
    assert.ok(fs.existsSync(f2), "room_id 缺 → sessionGroupId 兜底")

    const count = (
      client.prepare("SELECT COUNT(*) AS n FROM session_memories").get() as { n: number }
    ).n
    assert.equal(count, 3, "Iron Law：表数据一行不动")
  } finally {
    close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

test("S2 · 空表 → 0 written 不抛", () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), ".runtime", "f285-migrate-empty-"))
  const { db, close } = createDrizzleDb(path.join(tmp, "test.sqlite"))
  try {
    const result = migrateSessionMemories({ db, wikiRoot: path.join(tmp, "wiki") })
    assert.equal(result.groups, 0)
    assert.equal(result.written, 0)
  } finally {
    close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

// ─── #285 receive 德彪 r1 P1-2 + P2-4 ───

test("P1-2 · 写失败 → failed 计数（CLI 据此非零退出，不再假成功）", () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), ".runtime", "f285-migrate-fail-"))
  const { db, close } = makeFixtureDb(tmp)
  try {
    const blocked = path.join(tmp, "blocked")
    fs.writeFileSync(blocked, "x") // wikiRoot 是文件 → 全部写失败
    const result = migrateSessionMemories({ db, wikiRoot: blocked, warn: () => {} })
    assert.equal(result.groups, 2)
    assert.equal(result.written, 0)
    assert.equal(result.failed, 2, "失败必须显式计数")
  } finally {
    close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

test("P2-4 · 同 created_at 并列 → 取 rowid 更大（后插入）那条，确定性", () => {
  const tmp = fs.mkdtempSync(path.join(process.cwd(), ".runtime", "f285-migrate-tie-"))
  const wikiRoot = path.join(tmp, "wiki")
  const { db, close } = createDrizzleDb(path.join(tmp, "test.sqlite"))
  const client = getSqliteClient(db)
  try {
    const now = "2026-06-10T08:00:00.000Z"
    client
      .prepare(
        "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("group-tie", "R-300", "g", now, now)
    const ins = client.prepare(
      "INSERT INTO session_memories (id, session_group_id, summary, keywords, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    ins.run("t1", "group-tie", "先插入", "", "2026-06-09T00:00:00.000Z")
    ins.run("t2", "group-tie", "后插入", "", "2026-06-09T00:00:00.000Z") // 同 created_at
    const result = migrateSessionMemories({ db, wikiRoot })
    assert.equal(result.written, 1)
    const content = fs.readFileSync(
      path.join(wikiRoot, "rooms", "R-300", "session-summary.md"),
      "utf8",
    )
    assert.ok(content.includes("后插入"), "并列取 rowid 更大（后插入）那条")
    assert.ok(!content.includes("先插入"))
  } finally {
    close()
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

test("P1-2 · validateMigratePaths：sqlite 不存在 → 抛（不静默建空库假成功）", async () => {
  const { validateMigratePaths } = await import("./migrate-session-memories")
  const tmp = fs.mkdtempSync(path.join(process.cwd(), ".runtime", "f285-migrate-env-"))
  try {
    assert.throws(
      () => validateMigratePaths(path.join(tmp, "no-such.sqlite"), tmp),
      /SQLITE_PATH 不存在/,
    )
    assert.throws(
      () => validateMigratePaths((() => {
        const p = path.join(tmp, "real.sqlite")
        fs.writeFileSync(p, "")
        return p
      })(), path.join(tmp, "no-such-root")),
      /WIKI_ROOT 不存在/,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})
