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
 * F040 Phase 2 T3：群入站门（AC10 · D14 双白名单 + @bot）。
 * 门序：群模式关→rejected_chatkind（Phase 1 等效）；未 @bot→静默忽略（不审计不回执
 * 不入账本）；群∉白名单→拒+审计含 chatId（自举）不回执（防探测）；成员∉白名单且非
 * owner→拒+审计+群内回执；种子缺失且无既有 binding→拒+回执；全过门→FIFO 复用。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-group-gate-"))
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
          sessionGroupId: "sg-group-room",
          // biome-ignore lint/suspicious/noExplicitAny: fake
          message: { id: `um_${counter}`, role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => null,
  }
}

function build(
  overrides: { allowedGroupChats?: string[]; groupBindings?: Record<string, string> } = {},
) {
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
  const audits: Array<{ event: string; meta: Record<string, unknown> }> = []
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
      allowedGroupChats: overrides.allowedGroupChats ?? ["oc_g1"],
      groupMembers: { ou_li: { name: "小李", role: "participant" } },
      groupBindings: overrides.groupBindings ?? { oc_g1: "sg-group-room" },
    },
    genId: () => `id-${++idc}`,
    now: () => `2026-07-04T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    audit: (event, meta) => audits.push({ event, meta }),
  })
  return { gw, store, injector, sent, audits }
}

function groupMsg(o: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "oc_g1",
    externalMessageId: "om_g1",
    senderOpenId: "ou_li",
    chatKind: "group",
    text: "@_user_1 帮我看看",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

describe("T3 群门（AC10）", () => {
  it("群模式关（群白名单空）→ rejected_chatkind（Phase 1 等效零回归）", async () => {
    const { gw, audits, sent } = build({ allowedGroupChats: [] })
    const r = await gw.handleInbound(groupMsg())
    assert.equal(r, "rejected_chatkind")
    assert.ok(audits.some((a) => a.event === "inbound-reject"))
    assert.equal(sent.length, 0)
  })

  it("未 @bot → ignored_no_mention：静默忽略，不审计不回执不入账本", async () => {
    const { gw, store, audits, sent, injector } = build()
    const r = await gw.handleInbound(groupMsg({ mentionsBot: false }))
    assert.equal(r, "ignored_no_mention")
    assert.equal(audits.length, 0, "群内正常聊天不审计（不是对 bot 说话）")
    assert.equal(sent.length, 0)
    assert.equal(injector.injected.length, 0)
    const n = (
      store.db.prepare("SELECT COUNT(*) AS n FROM channel_inbound_ledger").get() as { n: number }
    ).n
    assert.equal(n, 0)
  })

  it("T7修5：owner 群裸媒体（attachments 形态，下载后真门）→ 过门入队", async () => {
    const { gw } = build()
    const r = await gw.handleInbound(
      groupMsg({
        mentionsBot: false,
        senderOpenId: "ou_sun",
        text: "[图片]",
        attachments: [{ kind: "image", url: "/uploads/feishu-a.png", name: "图片" }],
      }),
    )
    assert.equal(r, "queued")
  })

  it("T7修5：非 owner（含成员白名单）群裸媒体 → 照旧静默忽略（只识别 owner 发的）", async () => {
    const { gw, store, audits, sent } = build()
    const r = await gw.handleInbound(
      groupMsg({
        mentionsBot: false,
        text: "[图片]",
        attachments: [{ kind: "image", url: "/uploads/feishu-b.png", name: "图片" }],
      }),
    )
    assert.equal(r, "ignored_no_mention")
    assert.equal(audits.length, 0)
    assert.equal(sent.length, 0)
    const n = (
      store.db.prepare("SELECT COUNT(*) AS n FROM channel_inbound_ledger").get() as { n: number }
    ).n
    assert.equal(n, 0)
  })

  it("T7修5：owner 群裸文本（无媒体）→ 仍需 @（媒体旁路不放大到全量应答）", async () => {
    const { gw } = build()
    const r = await gw.handleInbound(groupMsg({ mentionsBot: false, senderOpenId: "ou_sun" }))
    assert.equal(r, "ignored_no_mention")
  })

  it("T7修5：owner 裸媒体但群∉白名单 → rejected_group（媒体旁路不塌陷群白名单门）", async () => {
    const { gw } = build()
    const r = await gw.handleInbound(
      groupMsg({
        mentionsBot: false,
        senderOpenId: "ou_sun",
        externalChatId: "oc_unknown",
        text: "[图片]",
        attachments: [{ kind: "image", url: "/uploads/feishu-c.png", name: "图片" }],
      }),
    )
    assert.equal(r, "rejected_group")
  })

  it("@bot 但群∉白名单 → rejected_group：审计含 chatId（自举），不回执（防探测）", async () => {
    const { gw, audits, sent } = build()
    const r = await gw.handleInbound(groupMsg({ externalChatId: "oc_unknown" }))
    assert.equal(r, "rejected_group")
    const a = audits.find((x) => x.event === "inbound-reject")
    assert.ok(a, "必须审计")
    assert.equal(a?.meta.chatId, "oc_unknown", "审计带 chatId 供小孙自举配置")
    assert.equal(sent.length, 0, "未知群不回话")
  })

  it("@bot + 群∈白名单 + 成员∉白名单 → rejected_member：审计 + 群内回执", async () => {
    const { gw, audits, sent, injector } = build()
    const r = await gw.handleInbound(groupMsg({ senderOpenId: "ou_stranger" }))
    assert.equal(r, "rejected_member")
    assert.ok(audits.some((x) => x.event === "inbound-reject"))
    assert.equal(sent.length, 1, "白名单群内要回执")
    assert.equal(sent[0].chatId, "oc_g1")
    assert.equal(injector.injected.length, 0)
  })

  it("成员小李过门 → queued：群 binding（chat_kind=group + 种子房间）+ 账本原文", async () => {
    const { gw, store, injector } = build()
    const r = await gw.handleInbound(groupMsg())
    assert.equal(r, "queued")
    assert.equal(injector.injected.length, 1)
    const b = store.db
      .prepare(
        "SELECT chat_kind, session_group_id FROM channel_bindings WHERE external_chat_id = 'oc_g1'",
      )
      .get() as { chat_kind: string; session_group_id: string }
    assert.equal(b.chat_kind, "group")
    assert.equal(b.session_group_id, "sg-group-room")
    const row = store.db
      .prepare(
        "SELECT content, state FROM channel_inbound_ledger WHERE external_message_id = 'om_g1'",
      )
      .get() as { content: string; state: string }
    assert.equal(row.content, "@_user_1 帮我看看", "账本存原文（归因前缀是注入时的事）")
    assert.equal(row.state, "injected")
  })

  it("owner（∈ ALLOWED_OPEN_IDS）未列成员表 → 照样过门（D14 owner 全权）", async () => {
    const { gw, injector } = build()
    const r = await gw.handleInbound(groupMsg({ senderOpenId: "ou_sun" }))
    assert.equal(r, "queued")
    assert.equal(injector.injected.length, 1)
  })

  it("群∈白名单但种子缺失且库内无既有 binding → rejected_unbound + 群内回执", async () => {
    const { gw, sent } = build({
      allowedGroupChats: ["oc_g1", "oc_g2"],
      groupBindings: { oc_g1: "sg-group-room" }, // oc_g2 没种子
    })
    const r = await gw.handleInbound(groupMsg({ externalChatId: "oc_g2" }))
    assert.equal(r, "rejected_unbound")
    assert.equal(sent.length, 1)
    assert.equal(sent[0].chatId, "oc_g2")
    // AC-N6（D20）：回执双路——命令面自助为主 + 管理页兜底
    assert.match(sent[0].text, /\/newroom/)
    assert.match(sent[0].text, /渠道/)
  })

  it("幂等复用：同 externalMessageId 二发 → duplicate（Phase 1 UNIQUE 门原样生效）", async () => {
    const { gw } = build()
    assert.equal(await gw.handleInbound(groupMsg()), "queued")
    assert.equal(await gw.handleInbound(groupMsg()), "duplicate")
  })

  it("p2p 路径零回归：白名单 p2p 照常 queued", async () => {
    const { gw } = build()
    const r = await gw.handleInbound({
      connectorId: "feishu",
      externalChatId: "oc_sun",
      externalMessageId: "om_p2p",
      senderOpenId: "ou_sun",
      chatKind: "p2p",
      text: "在吗",
      mentionsBot: true,
      senderName: null,
    })
    assert.equal(r, "queued")
  })
})

/**
 * guardian F1 + 德彪 P3-r2 P2：precheckInbound 契约=忠实预测 handleInbound 会不会收
 * （connector 凭它决定要不要下载媒体落盘）。任何 handleInbound 的拒绝路径——含
 * rejected_unbound（过门但没选房间）——预检都必须返回 false，且全程零副作用。
 */
describe("precheckInbound（门前只读预检）", () => {
  const p2pMsg = (openId: string): InboundChannelMessage => ({
    connectorId: "feishu",
    externalChatId: `p2p_${openId}`,
    externalMessageId: "om_pre",
    senderOpenId: openId,
    chatKind: "p2p",
    text: "[图片]",
    mentionsBot: true,
    senderName: null,
  })

  it("门拒的全谱系 → false：未@ / 陌生成员 / 非白名单群 / 群模式关 / p2p 陌生人", () => {
    const { gw } = build()
    assert.equal(gw.precheckInbound(groupMsg({ mentionsBot: false })), false)
    assert.equal(gw.precheckInbound(groupMsg({ senderOpenId: "ou_stranger" })), false)
    assert.equal(gw.precheckInbound(groupMsg({ externalChatId: "oc_unknown" })), false)
    assert.equal(gw.precheckInbound(p2pMsg("ou_stranger")), false)
    const { gw: gwOff } = build({ allowedGroupChats: [] })
    assert.equal(gwOff.precheckInbound(groupMsg()), false)
  })

  it("P3-r2 P2 回归：群过门但未选房间（无种子无既有 binding）→ false（rejected_unbound 也是拒绝路径）", () => {
    const { gw, store, audits } = build({
      allowedGroupChats: ["oc_g1", "oc_g2"],
      groupBindings: { oc_g1: "sg-group-room" }, // oc_g2 已授权但没绑房
    })
    assert.equal(gw.precheckInbound(groupMsg({ externalChatId: "oc_g2" })), false)
    // 零副作用面：不审计不回执不写库
    assert.equal(audits.length, 0)
    const n = (
      store.db.prepare("SELECT COUNT(*) AS n FROM channel_inbound_ledger").get() as { n: number }
    ).n
    assert.equal(n, 0)
  })

  it("T7修5：群裸媒体预检（media 描述符形态，下载前）→ owner true / 非 owner false（下载零字节）", () => {
    const { gw } = build()
    const media = { kind: "image" as const, key: "img_k", name: "图片" }
    assert.equal(
      gw.precheckInbound(groupMsg({ mentionsBot: false, senderOpenId: "ou_sun", media })),
      true,
    )
    assert.equal(gw.precheckInbound(groupMsg({ mentionsBot: false, media })), false)
  })

  it("会被接收的全谱系 → true：群有种子 / 群无种子但库有既有 binding / p2p 白名单（恒有种子）", () => {
    const { gw } = build()
    assert.equal(gw.precheckInbound(groupMsg()), true)
    assert.equal(gw.precheckInbound(p2pMsg("ou_sun")), true)
    // 种子缺失但既有 binding 行在（运行时真相源，如管理页绑过后种子被清）→
    // handleInbound 走 getBindingByChat 命中会收，预检必须同判 true
    const noSeed = build({
      allowedGroupChats: ["oc_g2"],
      groupBindings: {},
    })
    noSeed.store.db
      .prepare(
        `INSERT INTO channel_bindings (id, connector_id, external_chat_id, chat_kind, session_group_id, default_provider, created_at)
         VALUES ('b_pre', 'feishu', 'oc_g2', 'group', 'sg-group-room', 'claude', '2026-07-05T00:00:00.000Z')`,
      )
      .run()
    assert.equal(noSeed.gw.precheckInbound(groupMsg({ externalChatId: "oc_g2" })), true)
  })
})
