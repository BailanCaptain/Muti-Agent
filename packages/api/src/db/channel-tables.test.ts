import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { SqliteStore } from "./sqlite"

/**
 * F040 T2：三张渠道表的 DDL + UNIQUE 约束（D8/D10/D11 的地基）。
 * 约束在生产 bootstrap（SqliteStore.migrate）里长出来，测试直连同一 bootstrap —— 单测 schema 忠实生产。
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f040-channel-tables-"))
const store = new SqliteStore(path.join(tmpDir, "test.sqlite"))

after(() => {
  store.db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const NOW = "2026-07-03T12:00:00.000Z"

describe("channel_bindings（D3/D8）", () => {
  it("可写读，UNIQUE(connector_id, external_chat_id) 生效", () => {
    store.db
      .prepare(
        `INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("b1", "feishu", "oc_chat_1", "p2p", "sg-1", "claude", NOW)
    const row = store.db.prepare("SELECT * FROM channel_bindings WHERE id = ?").get("b1") as Record<
      string,
      unknown
    >
    assert.equal(row.connector_id, "feishu")
    assert.equal(row.chat_kind, "p2p")

    assert.throws(
      () =>
        store.db
          .prepare(
            `INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("b2", "feishu", "oc_chat_1", "p2p", "sg-2", "claude", NOW),
      /UNIQUE/,
    )
  })

  it("不同 connector 同 external_chat_id 不冲突", () => {
    store.db
      .prepare(
        `INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("b3", "wecom", "oc_chat_1", "p2p", "sg-1", "claude", NOW)
  })
})

describe("channel_inbound_ledger（D10 幂等 + D12 FIFO）", () => {
  const insert = store.db.prepare(
    `INSERT INTO channel_inbound_ledger
       (id, connector_id, external_chat_id, external_message_id, binding_id, sender_open_id, content, seq, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  it("UNIQUE 三元组：同 (connector, chat, message_id) 重投抛 UNIQUE", () => {
    insert.run(
      "i1",
      "feishu",
      "oc_chat_1",
      "om_msg_1",
      "b1",
      "ou_sun",
      "你好",
      1,
      "queued",
      NOW,
      NOW,
    )
    assert.throws(
      () =>
        insert.run(
          "i2",
          "feishu",
          "oc_chat_1",
          "om_msg_1",
          "b1",
          "ou_sun",
          "你好",
          2,
          "queued",
          NOW,
          NOW,
        ),
      /UNIQUE/,
    )
  })

  it("不同 chat 同 message_id 不冲突（三元组语义）", () => {
    insert.run(
      "i3",
      "feishu",
      "oc_chat_2",
      "om_msg_1",
      "b1",
      "ou_sun",
      "你好",
      3,
      "queued",
      NOW,
      NOW,
    )
  })

  it("按 seq 升序可查 queued 队列（FIFO 读法）", () => {
    insert.run(
      "i4",
      "feishu",
      "oc_chat_1",
      "om_msg_2",
      "b1",
      "ou_sun",
      "第二条",
      4,
      "queued",
      NOW,
      NOW,
    )
    const rows = store.db
      .prepare(
        "SELECT external_message_id FROM channel_inbound_ledger WHERE binding_id = ? AND state = 'queued' ORDER BY seq ASC",
      )
      .all("b1") as Array<{ external_message_id: string }>
    assert.deepEqual(
      rows.map((r) => r.external_message_id),
      ["om_msg_1", "om_msg_1", "om_msg_2"],
    )
  })
})

describe("channel_outbound_ledger（D11 状态机）", () => {
  const insert = store.db.prepare(
    `INSERT INTO channel_outbound_ledger
       (id, binding_id, internal_message_id, state, attempts, possible_duplicate, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  it("UNIQUE(binding_id, internal_message_id)：同 final 重登记抛 UNIQUE", () => {
    insert.run("o1", "b1", "msg_internal_1", "pending", 0, 0, NOW, NOW)
    assert.throws(
      () => insert.run("o2", "b1", "msg_internal_1", "pending", 0, 0, NOW, NOW),
      /UNIQUE/,
    )
  })

  it("不同 binding 同 internal_message_id 不冲突（多绑定各投各的）", () => {
    insert.run("o3", "b2x", "msg_internal_1", "pending", 0, 0, NOW, NOW)
  })

  it("状态机字段可更新（pending → attempted → sent + possible_duplicate 标记）", () => {
    store.db
      .prepare(
        "UPDATE channel_outbound_ledger SET state = ?, attempts = attempts + 1, possible_duplicate = ?, updated_at = ? WHERE id = ?",
      )
      .run("sent", 1, NOW, "o1")
    const row = store.db
      .prepare(
        "SELECT state, attempts, possible_duplicate FROM channel_outbound_ledger WHERE id = ?",
      )
      .get("o1") as Record<string, unknown>
    assert.equal(row.state, "sent")
    assert.equal(row.attempts, 1)
    assert.equal(row.possible_duplicate, 1)
  })
})

describe("channel_inbound_ledger 占位卡两列（F040 P3 AC15）", () => {
  it("新库 CREATE 路径：placeholder_state CHECK 闭集（bogus 拒，四态收）", () => {
    const ins = store.db.prepare(
      `INSERT INTO channel_inbound_ledger
         (id, connector_id, external_chat_id, external_message_id, binding_id, sender_open_id,
          content, seq, state, placeholder_message_id, placeholder_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    ins.run(
      "ph1",
      "feishu",
      "oc_ph",
      "om_ph_1",
      "b1",
      "ou_sun",
      "x",
      100,
      "injected",
      "msg_ph_1",
      "sent",
      NOW,
      NOW,
    )
    assert.throws(
      () =>
        ins.run(
          "ph2",
          "feishu",
          "oc_ph",
          "om_ph_2",
          "b1",
          "ou_sun",
          "x",
          101,
          "injected",
          "msg_ph_2",
          "bogus",
          NOW,
          NOW,
        ),
      /CHECK/,
    )
    for (const [i, s] of ["replaced", "failed", "expired"].entries()) {
      ins.run(
        `ph_ok_${i}`,
        "feishu",
        "oc_ph",
        `om_ph_ok_${i}`,
        "b1",
        "ou_sun",
        "x",
        110 + i,
        "injected",
        "m",
        s,
        NOW,
        NOW,
      )
    }
  })

  it("存量库（2.6 版无占位卡列）→ ALTER 迁移补两列，旧行 NULL", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const legacyPath = path.join(tmpDir, "legacy-inbound.sqlite")
    const raw = new DatabaseSync(legacyPath)
    raw.exec(`CREATE TABLE channel_inbound_ledger (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      sender_open_id TEXT NOT NULL,
      content TEXT NOT NULL,
      seq INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','injected','rejected')),
      root_message_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    raw
      .prepare(
        "INSERT INTO channel_inbound_ledger (id, connector_id, external_chat_id, external_message_id, binding_id, sender_open_id, content, seq, state, created_at, updated_at) VALUES ('old1','feishu','oc','om','b','ou','x',1,'injected',?,?)",
      )
      .run(NOW, NOW)
    raw.close()
    const migrated = new SqliteStore(legacyPath)
    try {
      const cols = (
        migrated.db.prepare("PRAGMA table_info(channel_inbound_ledger)").all() as Array<{
          name: string
        }>
      ).map((c) => c.name)
      assert.ok(cols.includes("placeholder_message_id"), "迁移应补 placeholder_message_id")
      assert.ok(cols.includes("placeholder_state"), "迁移应补 placeholder_state")
      const old = migrated.db
        .prepare(
          "SELECT placeholder_message_id, placeholder_state FROM channel_inbound_ledger WHERE id='old1'",
        )
        .get() as { placeholder_message_id: string | null; placeholder_state: string | null }
      assert.equal(old.placeholder_message_id, null)
      assert.equal(old.placeholder_state, null)
      // F3 回归（guardian P3）：ALTER 出的 placeholder_state 也带 CHECK 闭集——
      // 迁移库与新建库同一防线，野值进不了账本
      assert.throws(
        () =>
          migrated.db
            .prepare(
              "UPDATE channel_inbound_ledger SET placeholder_state = 'bogus' WHERE id='old1'",
            )
            .run(),
        /CHECK/,
      )
      migrated.db
        .prepare("UPDATE channel_inbound_ledger SET placeholder_state = 'sent' WHERE id='old1'")
        .run()
    } finally {
      migrated.db.close()
    }
  })
})
