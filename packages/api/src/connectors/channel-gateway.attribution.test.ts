import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { ChannelGateway } from "./channel-gateway"
import type { InboundChannelMessage } from "./channel-types"

/**
 * F040 Phase 2 T6：归因前缀注入（AC11 MVP 级 · 设计合同 #8）。
 * 群消息注入 content = `[飞书·<昵称>]\n<原文>`：前缀独立成行（classifyMention 行首
 * walk-left 判 gray，同行前缀会杀死正文 @派发）；昵称剥 `@`/`[Call:`（循环到不动点，
 * 防 `[C@all:` 单次剥重拼）；owner 未列成员表回落「村长」；p2p 零前缀零回归。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-attribution-"))
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

function build(groupMembers: Record<string, { name: string; role: "owner" | "participant" }>) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  const contents: string[] = []
  const senderNames: Array<string | undefined> = []
  let counter = 0
  const injector = {
    handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void) {
      const payload = (
        event as { payload: { content: string; senderDisplayName?: string } }
      ).payload
      contents.push(payload.content)
      senderNames.push(payload.senderDisplayName)
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
  let idc = 0
  let tick = 0
  const gw = new ChannelGateway({
    db: store,
    injector,
    sender: {
      async sendText() {
        return { ok: true } as const
      },
    },
    readFinalMessage: () => null,
    resolveThread: () => "thread-claude-1",
    config: {
      connectorId: "feishu",
      allowedOpenIds: ["ou_sun"],
      bindSessionGroup: "sg-mobile",
      defaultProvider: "claude",
      allowedGroupChats: ["oc_g1"],
      groupMembers,
      groupBindings: { oc_g1: "sg-group-room" },
    },
    genId: () => `id-${++idc}`,
    now: () => `2026-07-04T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  })
  return { gw, contents, senderNames }
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

describe("T6 归因前缀注入（AC11 MVP）", () => {
  it("群成员消息 → `[飞书·小李]\\n<原文>`（前缀独立成行，原文原样）+ senderDisplayName 持久化字段（T11）", async () => {
    const { gw, contents, senderNames } = build({ ou_li: { name: "小李", role: "participant" } })
    await gw.handleInbound(groupMsg({ text: "帮我看看 F040" }))
    assert.equal(contents.length, 1)
    assert.equal(contents[0], "[飞书·小李]\n帮我看看 F040")
    assert.equal(senderNames[0], "小李", "T11：真名走 senderDisplayName 进持久化链")
  })

  it("正文行首 @范德彪 保持独立行首（派发不被前缀杀死，AC11 回归样例）", async () => {
    const { gw, contents } = build({ ou_li: { name: "小李", role: "participant" } })
    await gw.handleInbound(groupMsg({ text: "@范德彪 在吗" }))
    const lines = contents[0].split("\n")
    assert.equal(lines[0], "[飞书·小李]")
    assert.equal(lines[1], "@范德彪 在吗", "@ 必须仍在行首（classifyMention walk-left）")
  })

  it("昵称剥 @ / [Call:（循环到不动点：`[C@all:` 不得重拼出 [Call:）", async () => {
    const { gw, contents } = build({
      ou_li: { name: "@小李", role: "participant" },
      ou_wang: { name: "[C@all:老王", role: "participant" },
    })
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_li" }))
    // 结束首 turn（inflight 排队语义正确；um_1 = 首条注入的 root）→ drain 第二条
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_wang" }))
    assert.equal(contents[0].split("\n")[0], "[飞书·小李]")
    const wangPrefix = contents[1].split("\n")[0]
    assert.ok(!wangPrefix.includes("[Call:"), `不得含 [Call: 字面量：${wangPrefix}`)
    assert.ok(!wangPrefix.includes("@"), `不得含 @：${wangPrefix}`)
  })

  it("昵称剥完为空 → 回落「成员」", async () => {
    const { gw, contents } = build({ ou_li: { name: "@@@", role: "participant" } })
    await gw.handleInbound(groupMsg())
    assert.equal(contents[0].split("\n")[0], "[飞书·成员]")
  })

  it("owner 群内发言未列成员表 → `[飞书·村长]`", async () => {
    const { gw, contents } = build({})
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_sun" }))
    assert.equal(contents[0].split("\n")[0], "[飞书·村长]")
  })

  it("p2p 消息零前缀 + 不带 senderDisplayName（Phase 1 零回归）", async () => {
    const { gw, contents, senderNames } = build({})
    await gw.handleInbound({
      connectorId: "feishu",
      externalChatId: "oc_sun",
      externalMessageId: "om_p2p",
      senderOpenId: "ou_sun",
      chatKind: "p2p",
      text: "在吗",
      mentionsBot: true,
      senderName: null,
    })
    assert.equal(contents[0], "在吗")
    assert.equal(senderNames[0], undefined, "p2p 不注真名 → timeline 照旧村长")
  })
})
