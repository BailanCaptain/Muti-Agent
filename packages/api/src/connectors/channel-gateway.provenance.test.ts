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
 * F040 Phase 2 T9：出站溯源正反例（AC13 · D15）。
 * 同一 room 挂双绑定（p2p + 群）是最危险形态：若按 sessionGroup 过滤，私聊/群互串。
 * 正解 = rootMessageId → 入站行 → binding 溯源：p2p 触发只回 p2p、群触发只回群、
 * 群 A 不投群 B、web/后台发起（无入站行）零投递。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-provenance-"))
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
  let counter = 0
  const injector = {
    handleClientEvent(_e: RealtimeClientEvent, emit: (x: RealtimeServerEvent) => void) {
      counter += 1
      emit({
        type: "message.created",
        payload: {
          threadId: "thread-claude-1",
          sessionGroupId: "sg-shared",
          // biome-ignore lint/suspicious/noExplicitAny: fake
          message: { id: `um_${counter}`, role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => null,
  }
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
    injector,
    sender,
    readFinalMessage: (id) =>
      finals[id] === undefined ? null : { content: finals[id], senderAlias: null, createdAt: "2026-07-04T00:00:00.000Z", orderSeq: null },
    resolveThread: () => "thread-claude-1",
    config: {
      connectorId: "feishu",
      allowedOpenIds: ["ou_sun"],
      // 双绑定共享同一 room（sg-shared）——D15 的高危形态
      bindSessionGroup: "sg-shared",
      defaultProvider: "claude",
      allowedGroupChats: ["oc_g1", "oc_g2"],
      groupMembers: { ou_li: { name: "小李", role: "participant" } },
      groupBindings: { oc_g1: "sg-shared", oc_g2: "sg-shared" },
    },
    genId: () => `id-${++idc}`,
    now: () => `2026-07-04T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  })
  return { gw, sent }
}

function inbound(o: Partial<InboundChannelMessage>): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "oc_sun",
    externalMessageId: `om_${Math.random().toString(36).slice(2)}`,
    senderOpenId: "ou_sun",
    chatKind: "p2p",
    text: "test",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

describe("T9 出站溯源（AC13 · D15）", () => {
  it("同 room 双绑定：p2p 触发只回 p2p、群触发只回群（互不串）", async () => {
    const { gw, sent } = build({ am_1: "回私聊的", am_2: "回群的" })
    // p2p 注入 → root um_1
    await gw.handleInbound(inbound({}))
    // 群注入（不同 binding，不受 p2p inflight 影响）→ root um_2
    await gw.handleInbound(
      inbound({ externalChatId: "oc_g1", senderOpenId: "ou_li", chatKind: "group" }),
    )
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    await gw.onInvocationFinished({ assistantMessageId: "am_2", rootMessageId: "um_2" })
    assert.deepEqual(
      sent.map((s) => ({ chatId: s.chatId, text: s.text })),
      [
        { chatId: "oc_sun", text: "回私聊的" },
        { chatId: "oc_g1", text: "回群的" },
      ],
    )
  })

  it("群 A 触发不投群 B（两群同 room）", async () => {
    const { gw, sent } = build({ am_1: "给 A 群的" })
    await gw.handleInbound(
      inbound({ externalChatId: "oc_g1", senderOpenId: "ou_li", chatKind: "group" }),
    )
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].chatId, "oc_g1", "只投来源群，oc_g2 一无所获")
  })

  it("web/后台发起（root 无入站行）→ 零投递（D15 负例）", async () => {
    const { gw, sent } = build({ am_web: "web 的回复", am_bg: "后台产物" })
    await gw.handleInbound(inbound({})) // 建立 binding，证明「有 binding 也不乱投」
    await gw.onInvocationFinished({ assistantMessageId: "am_web", rootMessageId: "um_web" })
    await gw.onInvocationFinished({ assistantMessageId: "am_bg", rootMessageId: null })
    assert.equal(sent.length, 0)
  })
})
