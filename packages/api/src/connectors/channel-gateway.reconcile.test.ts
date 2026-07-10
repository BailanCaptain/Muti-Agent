import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { ChannelGateway } from "./channel-gateway"
import type { ChannelSender } from "./channel-types"

/** F040 T11：启动 reconcile 出站补投（AC8）—— pending 续投 / attempted 补投带标记 / 超限转 terminal / 先出站后入站。 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-reconcile-"))
let dbSeq = 0
const openStores: SqliteStore[] = []

after(() => {
  for (const s of openStores) {
    try {
      s.db.close()
    } catch {}
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

function build(finals: Record<string, string>) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  const order: string[] = []
  const sent: Array<{ chatId: string; text: string }> = []
  let busy = false
  const injector = {
    setBusy: (v: boolean) => {
      busy = v
    },
    handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void) {
      order.push("inject")
      busy = true
      emit({
        type: "message.created",
        payload: {
          threadId: (event as { payload: { threadId: string } }).payload.threadId,
          sessionGroupId: "sg-mobile",
          // biome-ignore lint/suspicious/noExplicitAny: fake
          message: { id: "um_boot", role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => (busy ? "运行中" : null),
  }
  const sender: ChannelSender = {
    async sendText(chatId, text) {
      order.push("send")
      sent.push({ chatId, text })
      return { ok: true }
    },
  }
  let idc = 0
  let tick = 0
  const gw = new ChannelGateway({
    db: store,
    injector,
    sender,
    readFinalMessage: (id) =>
      finals[id] === undefined ? null : { content: finals[id], senderAlias: null, createdAt: "2026-07-04T00:00:00.000Z", orderSeq: null },
    resolveThread: () => "thread-claude-1",
    config: {
      connectorId: "feishu",
      allowedOpenIds: ["ou_sun"],
      bindSessionGroup: "sg-mobile",
      defaultProvider: "claude",
      allowedGroupChats: [],
      groupMembers: {},
      groupBindings: {},
    },
    genId: () => `id-${++idc}`,
    now: () => `2026-07-03T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  })
  return { gw, store, sent, order, injector }
}

/** 直接造一个 binding + 一条特定 state 的出站行 */
function seedOutbound(
  store: SqliteStore,
  opts: { internalMessageId: string; state: string; attempts: number },
) {
  store.db
    .prepare(
      `INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at)
       VALUES ('b-seed', 'feishu', 'oc_sun', 'p2p', 'sg-mobile', 'claude', '2026-07-03T00:00:00.000Z')`,
    )
    .run()
  store.db
    .prepare(
      `INSERT INTO channel_outbound_ledger (id, binding_id, internal_message_id, state, attempts, possible_duplicate, created_at, updated_at)
       VALUES (?, 'b-seed', ?, ?, ?, 0, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z')`,
    )
    .run(`o-${opts.internalMessageId}`, opts.internalMessageId, opts.state, opts.attempts)
}

describe("T11 reconcile 出站补投（AC8）", () => {
  it("pending 行 → 启动补投至 sent", async () => {
    const { gw, store, sent } = build({ am_p: "待投的回复" })
    seedOutbound(store, { internalMessageId: "am_p", state: "pending", attempts: 0 })
    await gw.reconcileOnBoot()
    assert.deepEqual(sent, [{ chatId: "oc_sun", text: "待投的回复" }])
    const row = store.db
      .prepare("SELECT state FROM channel_outbound_ledger WHERE internal_message_id = 'am_p'")
      .get() as { state: string }
    assert.equal(row.state, "sent")
  })

  it("attempted（结果未知）→ 补投一次 + possible_duplicate=1", async () => {
    const { gw, store, sent } = build({ am_a: "可能重复的回复" })
    seedOutbound(store, { internalMessageId: "am_a", state: "attempted", attempts: 1 })
    await gw.reconcileOnBoot()
    assert.equal(sent.length, 1)
    const row = store.db
      .prepare(
        "SELECT state, possible_duplicate FROM channel_outbound_ledger WHERE internal_message_id = 'am_a'",
      )
      .get() as { state: string; possible_duplicate: number }
    assert.equal(row.state, "sent")
    assert.equal(row.possible_duplicate, 1)
  })

  it("attempted 且 attempts>=3 → failed_terminal，不再投", async () => {
    const { gw, store, sent } = build({ am_x: "投了 3 次没成的回复" })
    seedOutbound(store, { internalMessageId: "am_x", state: "attempted", attempts: 3 })
    await gw.reconcileOnBoot()
    assert.equal(sent.length, 0)
    const row = store.db
      .prepare("SELECT state FROM channel_outbound_ledger WHERE internal_message_id = 'am_x'")
      .get() as { state: string }
    assert.equal(row.state, "failed_terminal")
  })

  it("sent 行不重投（终态不动）", async () => {
    const { gw, store, sent } = build({ am_s: "已发过" })
    seedOutbound(store, { internalMessageId: "am_s", state: "sent", attempts: 1 })
    await gw.reconcileOnBoot()
    assert.equal(sent.length, 0)
  })

  it("先出站补投再入站 drain（旧 final 不排新回复后）", async () => {
    const { gw, store, order, injector } = build({ am_p: "旧回复" })
    // 出站 pending
    seedOutbound(store, { internalMessageId: "am_p", state: "pending", attempts: 0 })
    // 入站 queued（同 binding b-seed）
    store.db
      .prepare(
        `INSERT INTO channel_inbound_ledger
           (id, connector_id, external_chat_id, external_message_id, binding_id, sender_open_id, content, seq, state, created_at, updated_at)
         VALUES ('i-q', 'feishu', 'oc_sun', 'om_q', 'b-seed', 'ou_sun', '新消息', 1, 'queued', '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z')`,
      )
      .run()
    injector.setBusy(false)
    await gw.reconcileOnBoot()
    // 顺序：send（出站）先于 inject（入站）
    assert.deepEqual(order, ["send", "inject"])
  })
})
