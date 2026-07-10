import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { ChannelGateway } from "./channel-gateway"
import type { ChannelSender, InboundChannelMessage } from "./channel-types"

/**
 * F040 德彪代码审 r1 的两个 P1 复现（忠实 fake，不掩盖生产语义）：
 * P1-1：direct turn 不占 dispatch slot，getBusyStatus 恒 null → gateway 不能靠它排队。
 * P1-2：group archived 时注入只 emit status 不 append user message → 不能无条件标 injected。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-r1-"))
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

function msg(o: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "oc_sun",
    externalMessageId: "om_1",
    senderOpenId: "ou_sun",
    chatKind: "p2p",
    text: "在吗",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

function build(injectorImpl: {
  handleClientEvent: (e: RealtimeClientEvent, emit: (x: RealtimeServerEvent) => void) => void
  getBusyStatus: () => string | null
}) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  const sent: Array<{ chatId: string; text: string }> = []
  const sender: ChannelSender = {
    async sendText(chatId, text) {
      sent.push({ chatId, text })
      return { ok: true }
    },
  }
  let idc = 0
  let tick = 0
  const gw = new ChannelGateway({
    db: store,
    injector: injectorImpl,
    sender,
    readFinalMessage: () => ({ content: "final", senderAlias: null, createdAt: "2026-07-04T00:00:00.000Z", orderSeq: null }),
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
  return { gw, store, sent }
}

describe("P1-1 direct turn busy（getBusyStatus 恒 null）", () => {
  it("turn 进行中连发第二条 → 排队不丢（不靠 getBusyStatus）", async () => {
    // 忠实 fake：getBusyStatus 恒 null（direct turn 不占 slot，德彪 P1-1 根因）；
    // 已有未结束 turn 时注入 = message-service :1476 "已经在运行中" return（不 emit user message）
    let activeTurn = false
    const injected: RealtimeClientEvent[] = []
    let counter = 0
    const { gw, store } = build({
      handleClientEvent(e, emit) {
        if (activeTurn) return // 模拟 :1476 拒绝：消息不进 room
        activeTurn = true
        counter += 1
        injected.push(e)
        emit({
          type: "message.created",
          payload: {
            threadId: "thread-claude-1",
            sessionGroupId: "sg-mobile",
            // biome-ignore lint/suspicious/noExplicitAny: fake
            message: { id: `um_${counter}`, role: "user" } as any,
          },
        } as RealtimeServerEvent)
      },
      getBusyStatus: () => null,
    })

    await gw.handleInbound(msg({ externalMessageId: "om_1", text: "一" }))
    await gw.handleInbound(msg({ externalMessageId: "om_2", text: "二" }))
    // om_1 注入，om_2 必须排队（不能因 getBusyStatus null 就注入撞丢）
    assert.equal(injected.length, 1)
    const queued = store.db
      .prepare("SELECT COUNT(*) AS n FROM channel_inbound_ledger WHERE state='queued'")
      .get() as { n: number }
    assert.equal(queued.n, 1, "om_2 应仍 queued")

    // om_1 turn 结束 → drain om_2
    activeTurn = false
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(injected.length, 2, "om_2 应在 om_1 结束后被注入")
  })
})

describe("P1-2 注入时 group 不可发送（archived）", () => {
  it("emit status（非 user message）→ 标 rejected + 回执飞书，不标 injected", async () => {
    const { gw, store, sent } = build({
      handleClientEvent(_e, emit) {
        // 模拟 message-service :1277 sendable 门：只 emit status，不 append user message
        emit({
          type: "status",
          payload: { sessionGroupId: "sg-mobile", message: "会话已归档，无法继续发送消息。" },
        } as RealtimeServerEvent)
      },
      getBusyStatus: () => null,
    })

    await gw.handleInbound(msg({ externalMessageId: "om_arch" }))
    const row = store.db
      .prepare(
        "SELECT state, root_message_id, error FROM channel_inbound_ledger WHERE external_message_id='om_arch'",
      )
      .get() as { state: string; root_message_id: string | null; error: string | null }
    assert.equal(row.state, "rejected", "不可发送时不能标 injected")
    assert.ok(row.error, "应记录拒绝原因")
    assert.ok(
      sent.some((s) => /归档/.test(s.text)),
      "应回执飞书用户（不静默）",
    )
  })
})
