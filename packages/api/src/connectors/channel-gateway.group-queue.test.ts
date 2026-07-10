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
 * F040 Phase 2 T8：群排队回执（AC12）。
 * 群 binding 忙时入队 → 群内 ack「已排队（第 N 位）」带昵称（多人场景不知道谁的任务
 * 在排）；空闲立即注入不 ack；p2p 排队沿用 Phase 1 静默（单人自知，零回归）。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-group-queue-"))
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

function build() {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  const injectedContents: string[] = []
  const sent: Array<{ chatId: string; text: string }> = []
  let counter = 0
  const injector = {
    handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void) {
      injectedContents.push((event as { payload: { content: string } }).payload.content)
      counter += 1
      emit({
        type: "message.created",
        payload: {
          threadId: "thread-claude-1",
          sessionGroupId: "sg-group-room",
          // biome-ignore lint/suspicious/noExplicitAny: fake
          message: { id: `um_${counter}`, role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => null,
  }
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
    injector,
    sender,
    readFinalMessage: () => null,
    resolveThread: () => "thread-claude-1",
    config: {
      connectorId: "feishu",
      allowedOpenIds: ["ou_sun"],
      bindSessionGroup: "sg-mobile",
      defaultProvider: "claude",
      allowedGroupChats: ["oc_g1"],
      groupMembers: {
        ou_li: { name: "小李", role: "participant" },
        ou_wang: { name: "老王", role: "participant" },
      },
      groupBindings: { oc_g1: "sg-group-room" },
    },
    genId: () => `id-${++idc}`,
    now: () => `2026-07-04T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  })
  return { gw, store, injectedContents, sent }
}

function groupMsg(o: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "oc_g1",
    externalMessageId: `om_${Math.random().toString(36).slice(2)}`,
    senderOpenId: "ou_li",
    chatKind: "group",
    text: "帮我看看",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

describe("T8 群排队回执（AC12）", () => {
  it("空闲群消息 → 立即注入，不发排队 ack", async () => {
    const { gw, injectedContents, sent } = build()
    const r = await gw.handleInbound(groupMsg())
    assert.equal(r, "queued")
    assert.equal(injectedContents.length, 1, "空闲即注入")
    assert.equal(sent.length, 0, "立即注入无需 ack")
  })

  it("忙时两人连发 → 各收 ack 带自己昵称+队列位置", async () => {
    const { gw, injectedContents, sent } = build()
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_li", text: "任务一" }))
    assert.equal(injectedContents.length, 1)
    // binding 忙（inflight）→ 后两条排队
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_wang", text: "任务二" }))
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_li", text: "任务三" }))
    assert.equal(injectedContents.length, 1, "忙时不注入")
    assert.equal(sent.length, 2, "两条排队各一 ack")
    assert.equal(sent[0].chatId, "oc_g1")
    assert.match(sent[0].text, /老王/)
    assert.match(sent[0].text, /1/)
    assert.match(sent[1].text, /小李/)
    assert.match(sent[1].text, /2/)
  })

  it("turn 结束 → 按 FIFO 注入排队消息（归因前缀对应各自发送者）", async () => {
    const { gw, injectedContents } = build()
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_li", text: "任务一" }))
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_wang", text: "任务二" }))
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(injectedContents.length, 2)
    assert.equal(injectedContents[1], "[飞书·老王]\n任务二", "FIFO 次序 + 归因对人")
  })

  it("p2p 排队零回归：忙时不发 ack（Phase 1 静默语义）", async () => {
    const { gw, sent } = build()
    const p2p = (id: string): InboundChannelMessage => ({
      connectorId: "feishu",
      externalChatId: "oc_sun",
      externalMessageId: id,
      senderOpenId: "ou_sun",
      chatKind: "p2p",
      text: "在吗",
      mentionsBot: true,
      senderName: null,
    })
    await gw.handleInbound(p2p("om_1"))
    await gw.handleInbound(p2p("om_2")) // 排队
    assert.equal(sent.length, 0, "p2p 排队不 ack")
  })
})
