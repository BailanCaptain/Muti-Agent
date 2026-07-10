import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { SqliteStore } from "./sqlite"

/**
 * F040 Phase 2.5 M-T1（AC-M1 前置）：渠道管理三表 DDL。
 * 授权配置从 env 迁 DB 真相源（D17）——members（吃掉 ALLOWED_OPEN_IDS + GROUP_MEMBERS 两个
 * env 域）/ groups（白名单+开关+绑定种子）/ inbound_audit（拒绝聚合，待放行一键放行）。
 * 新表走 CREATE IF NOT EXISTS 自迁移，无 ALTER 面（四脸教训只对既有表加列成立）。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-admin-ddl-"))
const store = new SqliteStore(path.join(tmpRoot, "db.sqlite"))
after(() => {
  store.db.close()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

function cols(table: string): string[] {
  return (
    store.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{
      name: string
    }>
  ).map((c) => c.name)
}

describe("M-T1 渠道管理三表 DDL", () => {
  it("channel_admin_members：列全 + (channel,open_id) 主键 + role CHECK + enabled 默认 1", () => {
    assert.deepEqual(cols("channel_admin_members"), [
      "channel",
      "open_id",
      "display_name",
      "role",
      "enabled", // P2.6 AC-N3 禁用开关（0 = 按非白名单拒）
      "created_at",
      "updated_at",
    ])
    store.db
      .prepare(
        "INSERT INTO channel_admin_members (channel, open_id, display_name, role, created_at, updated_at) VALUES ('feishu','ou_1','村长','owner','t','t')",
      )
      .run()
    // enabled 缺省 = 1（存量行/新行默认可用）
    assert.equal(
      (
        store.db
          .prepare("SELECT enabled FROM channel_admin_members WHERE open_id='ou_1'")
          .get() as { enabled: number }
      ).enabled,
      1,
    )
    // 同 (channel, open_id) 重复 → 主键冲突
    assert.throws(() =>
      store.db
        .prepare(
          "INSERT INTO channel_admin_members (channel, open_id, display_name, role, created_at, updated_at) VALUES ('feishu','ou_1','别名','participant','t','t')",
        )
        .run(),
    )
    // 非法 role → CHECK 拒
    assert.throws(() =>
      store.db
        .prepare(
          "INSERT INTO channel_admin_members (channel, open_id, display_name, role, created_at, updated_at) VALUES ('feishu','ou_2','某','admin','t','t')",
        )
        .run(),
    )
  })

  it("channel_admin_groups：列全 + enabled 默认 1 + session_group_id 可空", () => {
    assert.deepEqual(cols("channel_admin_groups"), [
      "channel",
      "chat_id",
      "display_name",
      "session_group_id",
      "enabled",
      "created_at",
      "updated_at",
    ])
    store.db
      .prepare(
        "INSERT INTO channel_admin_groups (channel, chat_id, created_at, updated_at) VALUES ('feishu','oc_1','t','t')",
      )
      .run()
    const row = store.db
      .prepare(
        "SELECT display_name, session_group_id, enabled FROM channel_admin_groups WHERE chat_id='oc_1'",
      )
      .get() as { display_name: string; session_group_id: string | null; enabled: number }
    assert.equal(row.display_name, "")
    assert.equal(row.session_group_id, null)
    assert.equal(row.enabled, 1)
  })

  it("channel_command_audit：列全 + UNIQUE 三元组（命令幂等锚）+ result 默认 received", () => {
    assert.deepEqual(cols("channel_command_audit"), [
      "id",
      "channel",
      "external_chat_id",
      "external_message_id",
      "open_id",
      "chat_kind",
      "raw_text",
      "result",
      "created_at",
      "updated_at",
    ])
    store.db
      .prepare(
        "INSERT INTO channel_command_audit (id, channel, external_chat_id, external_message_id, open_id, chat_kind, raw_text, created_at, updated_at) VALUES ('c-1','feishu','p2p_1','om_1','ou_1','p2p','/rooms','t','t')",
      )
      .run()
    const row = store.db
      .prepare("SELECT result FROM channel_command_audit WHERE id='c-1'")
      .get() as { result: string }
    assert.equal(row.result, "received")
    // 同 (channel, chat, message) 重放 → UNIQUE 冲突（WS 补推去重的正确性基础）
    assert.throws(() =>
      store.db
        .prepare(
          "INSERT INTO channel_command_audit (id, channel, external_chat_id, external_message_id, open_id, chat_kind, raw_text, created_at, updated_at) VALUES ('c-2','feishu','p2p_1','om_1','ou_1','p2p','/rooms','t','t')",
        )
        .run(),
    )
    // 非法 chat_kind → CHECK 拒
    assert.throws(() =>
      store.db
        .prepare(
          "INSERT INTO channel_command_audit (id, channel, external_chat_id, external_message_id, open_id, chat_kind, raw_text, created_at, updated_at) VALUES ('c-3','feishu','p2p_1','om_2','ou_1','channel','/rooms','t','t')",
        )
        .run(),
    )
  })

  it("channel_inbound_audit：列全 + status 默认 pending + 聚合键 UNIQUE", () => {
    assert.deepEqual(cols("channel_inbound_audit"), [
      "id",
      "channel",
      "chat_id",
      "chat_kind",
      "open_id",
      "reason",
      "count",
      "first_at",
      "last_at",
      "status",
    ])
    store.db
      .prepare(
        "INSERT INTO channel_inbound_audit (id, channel, chat_id, chat_kind, open_id, reason, first_at, last_at) VALUES ('a-1','feishu','oc_1','group','ou_x','member-not-allowed','t1','t1')",
      )
      .run()
    const row = store.db
      .prepare("SELECT count, status FROM channel_inbound_audit WHERE id='a-1'")
      .get() as { count: number; status: string }
    assert.equal(row.count, 1)
    assert.equal(row.status, "pending")
    // 同 (channel, chat_kind, chat_id, open_id, reason) → UNIQUE 冲突（recordReject 聚合 upsert 的锚）
    assert.throws(() =>
      store.db
        .prepare(
          "INSERT INTO channel_inbound_audit (id, channel, chat_id, chat_kind, open_id, reason, first_at, last_at) VALUES ('a-2','feishu','oc_1','group','ou_x','member-not-allowed','t2','t2')",
        )
        .run(),
    )
    // 非法 status → CHECK 拒
    assert.throws(() =>
      store.db
        .prepare(
          "INSERT INTO channel_inbound_audit (id, channel, chat_id, chat_kind, open_id, reason, first_at, last_at, status) VALUES ('a-3','feishu','oc_2','group','ou_y','unbound','t','t','maybe')",
        )
        .run(),
    )
  })
})
