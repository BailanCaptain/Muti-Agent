import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { ChannelGateway } from "./channel-gateway"
import type {
  ChannelCommandContext,
  ChannelSender,
  InboundChannelMessage,
} from "./channel-types"

/**
 * F040 P2.6 T5（AC-N1）：命令面基建——gateway 门后旁路。
 * 门序：白名单门（陌生人摸不到命令面）→ `/` 前缀截流（在 binding/账本之前，
 * 未绑群也能 /newroom）→ 幂等（channel_command_audit UNIQUE 三元组，WS 补推真机实测）
 * → owner 门（非 owner 一律「仅群主可用」，不泄词表）→ executor（异常不击穿主链）。
 * 命令消息不进 inbound ledger、不注入房间、回执只回飞书。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-commands-"))
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

function makeFakeInjector() {
  const injected: RealtimeClientEvent[] = []
  let counter = 0
  return {
    injected,
    handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void) {
      injected.push(event)
      counter += 1
      emit({
        type: "message.created",
        payload: {
          threadId: (event as { payload: { threadId: string } }).payload.threadId,
          sessionGroupId: "sg-mobile",
          // biome-ignore lint/suspicious/noExplicitAny: fake
          message: { id: `um_${counter}`, role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => null,
  }
}

function build(opts: { withCommands?: boolean; throwOnExecute?: boolean } = {}) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  const injector = makeFakeInjector()
  const sent: Array<{ chatId: string; text: string }> = []
  const sender: ChannelSender = {
    async sendText(chatId, text) {
      sent.push({ chatId, text })
      return { ok: true }
    },
  }
  const commandCalls: ChannelCommandContext[] = []
  const commands =
    opts.withCommands === false
      ? undefined
      : {
          async execute(ctx: ChannelCommandContext) {
            commandCalls.push(ctx)
            if (opts.throwOnExecute) throw new Error("executor boom")
            return `收到命令：${ctx.text}`
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
    config: () => ({
      connectorId: "feishu",
      allowedOpenIds: ["ou_sun"],
      bindSessionGroup: "sg-mobile",
      defaultProvider: "claude",
      allowedGroupChats: ["oc_g1", "oc_unbound"],
      groupMembers: { ou_li: { name: "小李", role: "participant" as const } },
      groupBindings: { oc_g1: "sg-group-room" },
    }),
    commands,
    genId: () => `id-${++idc}`,
    now: () => `2026-07-05T00:00:${String(tick++ % 60).padStart(2, "0")}.000Z`,
    audit: () => {},
  })
  return { gw, store, injector, sent, commandCalls }
}

function p2pMsg(o: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "p2p_sun",
    externalMessageId: `om_${Math.floor(Math.random() * 1e9)}`,
    senderOpenId: "ou_sun",
    chatKind: "p2p",
    text: "/rooms",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

function groupMsg(o: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "oc_g1",
    externalMessageId: `om_${Math.floor(Math.random() * 1e9)}`,
    senderOpenId: "ou_li",
    chatKind: "group",
    text: "/rooms",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

function auditRow(store: SqliteStore, externalMessageId: string) {
  const row = store.db
    .prepare(
      "SELECT open_id, chat_kind, raw_text, result FROM channel_command_audit WHERE external_message_id = ?",
    )
    .get(externalMessageId) as
    | { open_id: string; chat_kind: string; raw_text: string; result: string }
    | undefined
  return row ? { ...row } : undefined
}

describe("T5 命令面基建（AC-N1）", () => {
  it("owner p2p 命令 → executor 收到 ctx + 回执 = 返回文本 + 审计 done；不进账本不注入", async () => {
    const { gw, store, injector, sent, commandCalls } = build()
    const r = await gw.handleInbound(p2pMsg({ externalMessageId: "om_cmd_1" }))
    assert.equal(r, "command_handled")
    assert.equal(commandCalls.length, 1)
    assert.equal(commandCalls[0].chatId, "p2p_sun")
    assert.equal(commandCalls[0].chatKind, "p2p")
    assert.equal(commandCalls[0].senderOpenId, "ou_sun")
    assert.equal(commandCalls[0].text, "/rooms")
    assert.equal(commandCalls[0].binding, null, "从没发过普通消息 → binding 未建")
    assert.deepEqual(commandCalls[0].channelDefaults, {
      bindSessionGroup: "sg-mobile",
      defaultProvider: "claude",
    })
    assert.deepEqual(sent, [{ chatId: "p2p_sun", text: "收到命令：/rooms" }])
    assert.equal(auditRow(store, "om_cmd_1")?.result, "done")
    assert.equal(injector.injected.length, 0, "命令不注入房间")
    const ledger = store.db
      .prepare("SELECT COUNT(*) AS n FROM channel_inbound_ledger")
      .get() as { n: number }
    assert.equal(ledger.n, 0, "命令不进入站账本")
  })

  it("已有 binding 的 chat → ctx.binding 带现值（命令面读运行时真相源）", async () => {
    const { gw, commandCalls } = build()
    // 先发一条普通消息把 binding lazy 建出来
    await gw.handleInbound(p2pMsg({ externalMessageId: "om_normal", text: "在吗" }))
    await gw.handleInbound(p2pMsg({ externalMessageId: "om_cmd_2" }))
    assert.deepEqual(commandCalls[0].binding, {
      sessionGroupId: "sg-mobile",
      defaultProvider: "claude",
    })
  })

  it("非 owner（白名单群成员）发任何 / 文本 → 仅群主可用回执 + 审计 denied，executor 不被调", async () => {
    const { gw, store, sent, commandCalls } = build()
    const r = await gw.handleInbound(groupMsg({ externalMessageId: "om_deny_1" }))
    assert.equal(r, "command_denied")
    assert.equal(commandCalls.length, 0)
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /仅群主可用/)
    const row = auditRow(store, "om_deny_1")
    assert.equal(row?.result, "denied")
    assert.equal(row?.open_id, "ou_li")
    // 未知命令词也一样（不向 participant 泄词表）
    const r2 = await gw.handleInbound(groupMsg({ externalMessageId: "om_deny_2", text: "/xyz" }))
    assert.equal(r2, "command_denied")
    assert.equal(commandCalls.length, 0)
  })

  it("owner 群命令（群双白名单 + @bot 过门后）→ executor 执行", async () => {
    const { gw, commandCalls } = build()
    const r = await gw.handleInbound(
      groupMsg({ senderOpenId: "ou_sun", externalMessageId: "om_owner_group" }),
    )
    assert.equal(r, "command_handled")
    assert.equal(commandCalls.length, 1)
    assert.equal(commandCalls[0].chatKind, "group")
  })

  it("幂等：同 externalMessageId 重放 → duplicate 静默（executor 只跑一次，无第二次回执）", async () => {
    const { gw, sent, commandCalls } = build()
    const first = await gw.handleInbound(p2pMsg({ externalMessageId: "om_dup" }))
    const second = await gw.handleInbound(p2pMsg({ externalMessageId: "om_dup" }))
    assert.equal(first, "command_handled")
    assert.equal(second, "command_duplicate")
    assert.equal(commandCalls.length, 1)
    assert.equal(sent.length, 1)
  })

  it("executor 抛异常 → 失败回执 + 审计 error:*，主链活着（后续普通消息照常注入）", async () => {
    const { gw, store, injector, sent } = build({ throwOnExecute: true })
    const r = await gw.handleInbound(p2pMsg({ externalMessageId: "om_boom" }))
    assert.equal(r, "command_handled", "异常也收口在命令面，不掉进注入链")
    assert.match(sent[0].text, /失败/)
    assert.match(auditRow(store, "om_boom")?.result ?? "", /^error:/)
    // 主链未击穿：普通消息照常
    const r2 = await gw.handleInbound(p2pMsg({ externalMessageId: "om_after", text: "在吗" }))
    assert.equal(r2, "queued")
    assert.equal(injector.injected.length, 1)
  })

  it("未绑群 + owner 命令 → executor 可达（binding null），不触发 unbound 拒绝回执", async () => {
    const { gw, sent, commandCalls } = build()
    const r = await gw.handleInbound(
      groupMsg({
        externalChatId: "oc_unbound",
        senderOpenId: "ou_sun",
        externalMessageId: "om_unbound_cmd",
        text: "/newroom 新房",
      }),
    )
    assert.equal(r, "command_handled")
    assert.equal(commandCalls.length, 1)
    assert.equal(commandCalls[0].binding, null)
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /收到命令/, "回执来自 executor，不是 unbound 引导文案")
  })

  it("门在命令面之前：陌生 p2p 的 / 文本 → allowlist 拒；群未 @bot 的 / 文本 → 静默忽略", async () => {
    const { gw, commandCalls } = build()
    const stranger = await gw.handleInbound(
      p2pMsg({ senderOpenId: "ou_stranger", externalMessageId: "om_stranger" }),
    )
    assert.equal(stranger, "rejected_allowlist")
    const noMention = await gw.handleInbound(
      groupMsg({ senderOpenId: "ou_sun", mentionsBot: false, externalMessageId: "om_nomention" }),
    )
    assert.equal(noMention, "ignored_no_mention")
    assert.equal(commandCalls.length, 0)
  })

  it("向后兼容：无 commands dep → / 文本走普通注入链（Phase 1/2 语义原样）", async () => {
    const { gw, injector } = build({ withCommands: false })
    const r = await gw.handleInbound(p2pMsg({ externalMessageId: "om_legacy" }))
    assert.equal(r, "queued")
    assert.equal(injector.injected.length, 1)
    assert.equal(
      (injector.injected[0] as { payload: { content: string } }).payload.content,
      "/rooms",
    )
  })

  it("前导空白容忍：'  /rooms ' 仍进命令面（trim 后判 / 前缀）", async () => {
    const { gw, commandCalls } = build()
    const r = await gw.handleInbound(
      p2pMsg({ externalMessageId: "om_ws", text: "  /rooms " }),
    )
    assert.equal(r, "command_handled")
    assert.equal(commandCalls[0].text, "/rooms")
  })
})
