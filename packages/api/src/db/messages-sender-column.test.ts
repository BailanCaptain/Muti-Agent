import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { SqliteStore } from "./sqlite"

/**
 * F040 Phase 2 T10（AC11 正式级前置）：messages.sender_display_name 列。
 * 群桥接归因真名的持久化落点——注入时回填，timeline 读取替换 :689 村长硬编码（T11）。
 * 新库走 CREATE TABLE，老库走 runAlterMigrations（幂等）。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-sender-col-"))
const store = new SqliteStore(path.join(tmpRoot, "db.sqlite"))
after(() => {
  store.db.close()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

describe("T10 messages.sender_display_name", () => {
  it("列存在（新库 CREATE TABLE 路径）", () => {
    const cols = (
      store.db.prepare("SELECT name FROM pragma_table_info('messages')").all() as Array<{
        name: string
      }>
    ).map((c) => c.name)
    assert.ok(cols.includes("sender_display_name"), `缺列：${cols.join(",")}`)
  })

  it("可写读；未填默认 NULL（历史消息兼容）", () => {
    store.db
      .prepare(
        "INSERT INTO threads (id, session_group_id, provider, alias, updated_at) VALUES ('t-1','sg-1','claude','黄仁勋','2026-07-04T00:00:00.000Z')",
      )
      .run()
    store.db
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, created_at, sender_display_name) VALUES ('m-named','t-1','user','群消息','2026-07-04T00:00:01.000Z','小李')",
      )
      .run()
    store.db
      .prepare(
        "INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('m-legacy','t-1','user','老消息','2026-07-04T00:00:02.000Z')",
      )
      .run()
    const named = store.db
      .prepare("SELECT sender_display_name FROM messages WHERE id='m-named'")
      .get() as { sender_display_name: string | null }
    const legacy = store.db
      .prepare("SELECT sender_display_name FROM messages WHERE id='m-legacy'")
      .get() as { sender_display_name: string | null }
    assert.equal(named.sender_display_name, "小李")
    assert.equal(legacy.sender_display_name, null)
  })

  it("老库升级路径：先建无列版 messages → migrate 后列存在（ALTER 幂等）", () => {
    const legacyPath = path.join(tmpRoot, "legacy.sqlite")
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const raw = new DatabaseSync(legacyPath)
    raw.exec(
      "CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)",
    )
    raw.close()
    const upgraded = new SqliteStore(legacyPath)
    try {
      const cols = (
        upgraded.db.prepare("SELECT name FROM pragma_table_info('messages')").all() as Array<{
          name: string
        }>
      ).map((c) => c.name)
      assert.ok(cols.includes("sender_display_name"), `老库升级后缺列：${cols.join(",")}`)
    } finally {
      upgraded.db.close()
    }
  })

  it("德彪 P2 审 P2-1：老库只经 createDrizzleDb 打开 → MIGRATIONS 同样补列（双迁移系统镜像）", () => {
    const legacyPath = path.join(tmpRoot, "legacy-drizzle.sqlite")
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const raw = new DatabaseSync(legacyPath)
    raw.exec(
      "CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)",
    )
    raw.close()
    // 只走 drizzle 路径（不经 SqliteStore）——P2-1 失败场景：漏迁移则 insert/select 炸列缺失
    const { createDrizzleDb } = require("./drizzle-instance") as typeof import("./drizzle-instance")
    const { close } = createDrizzleDb(legacyPath)
    close()
    const check = new DatabaseSync(legacyPath, { readOnly: true })
    try {
      const cols = (
        check.prepare("SELECT name FROM pragma_table_info('messages')").all() as Array<{
          name: string
        }>
      ).map((c) => c.name)
      assert.ok(cols.includes("sender_display_name"), `drizzle 老库升级后缺列：${cols.join(",")}`)
    } finally {
      check.close()
    }
  })

  it("德彪 P2 审 P2-2 迁移边：中间态库（已有 held_order 无 message_order_seq）→ ALTER 补列", () => {
    // 复刻真实中间态：预览库已过 held_order 表重建、但在 tie-breaker 列引入之前
    const midPath = path.join(tmpRoot, "mid-state.sqlite")
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")
    const raw = new DatabaseSync(midPath)
    raw.exec(`CREATE TABLE channel_outbound_ledger (
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, internal_message_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','attempted','sent','failed_terminal','held_order')),
      attempts INTEGER NOT NULL DEFAULT 0, possible_duplicate INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      root_message_id TEXT, message_created_at TEXT, hold_since TEXT
    )`)
    raw.close()
    const upgraded = new SqliteStore(midPath)
    try {
      const cols = (
        upgraded.db
          .prepare("SELECT name FROM pragma_table_info('channel_outbound_ledger')")
          .all() as Array<{ name: string }>
      ).map((c) => c.name)
      assert.ok(cols.includes("message_order_seq"), `中间态库升级后缺列：${cols.join(",")}`)
    } finally {
      upgraded.db.close()
    }
  })
})
