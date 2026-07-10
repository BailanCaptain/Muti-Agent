import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { ChannelGateway, type ChannelGatewayConfig } from "./channel-gateway"
import type { ChannelSender, InboundChannelMessage } from "./channel-types"

/**
 * F040 Phase 2.5 M-T4（AC-M2 网关侧）：热配置 —— deps.config 收窄为 getter，
 * 每次门判定现读快照；管理面写库失效缓存后，**同一 gateway 实例**下一条消息即按
 * 新配置判定（不重启）。四个拒绝点挂 recordReject（待放行审计持久化，AC-M3）；
 * recordReject 抛异常不击穿门主链（回执/审计降级，B025 家族纪律）。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-hot-config-"))
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

function build(opts: { recordReject?: (r: Record<string, unknown>) => void } = {}) {
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
  // 可变配置：测试直接改字段模拟「管理面写库 → 快照失效重组」后的新快照
  const live: ChannelGatewayConfig = {
    connectorId: "feishu",
    allowedOpenIds: ["ou_sun"],
    bindSessionGroup: "sg-mobile",
    defaultProvider: "claude",
    allowedGroupChats: ["oc_g1"],
    groupMembers: { ou_li: { name: "小李", role: "participant" } },
    groupBindings: { oc_g1: "sg-group-room" },
  }
  let idc = 0
  let tick = 0
  const gw = new ChannelGateway({
    db: store,
    injector,
    sender,
    readFinalMessage: () => null,
    resolveThread: () => "thread-claude-1",
    config: () => live, // ← M-T4 核心：getter 形态
    recordReject: opts.recordReject,
    genId: () => `id-${++idc}`,
    now: () => `2026-07-04T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    audit: (event, meta) => audits.push({ event, meta }),
  })
  return { gw, store, injector, sent, audits, live }
}

function groupMsg(o: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "oc_g1",
    externalMessageId: `om_${Math.floor(Math.random() * 1e9)}`,
    senderOpenId: "ou_li",
    chatKind: "group",
    text: "@_user_1 帮我看看",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

describe("M-T4 热配置（AC-M2 网关侧）", () => {
  it("热放行成员：拒 → 配置更新 → 同实例下一条即过（不重启）", async () => {
    const { gw, live, injector } = build()
    const r1 = await gw.handleInbound(groupMsg({ senderOpenId: "ou_new", externalMessageId: "om_a" }))
    assert.equal(r1, "rejected_member")
    live.groupMembers = { ...live.groupMembers, ou_new: { name: "新人", role: "participant" } }
    const r2 = await gw.handleInbound(groupMsg({ senderOpenId: "ou_new", externalMessageId: "om_b" }))
    assert.equal(r2, "queued")
    assert.equal(injector.injected.length, 1)
    // 归因也吃新配置：注入正文带「新人」署名前缀
    const payload = injector.injected[0] as { payload: { content: string } }
    assert.match(payload.payload.content, /新人/)
  })

  it("热移除成员：先过 → 移除 → 同 sender 下一条被拒", async () => {
    const { gw, live } = build()
    assert.equal(await gw.handleInbound(groupMsg({ externalMessageId: "om_1" })), "queued")
    const { ou_li: _, ...rest } = live.groupMembers
    live.groupMembers = rest
    assert.equal(await gw.handleInbound(groupMsg({ externalMessageId: "om_2" })), "rejected_member")
  })

  it("热关群：白名单摘除 → 已知群变陌生群（静默拒不回执）", async () => {
    const { gw, live, sent } = build()
    assert.equal(await gw.handleInbound(groupMsg({ externalMessageId: "om_1" })), "queued")
    live.allowedGroupChats = []
    // 群模式没关（其他群仍可在），本群被摘 → rejected_chatkind 分支不该走
    live.allowedGroupChats = ["oc_other"]
    const r = await gw.handleInbound(groupMsg({ externalMessageId: "om_2" }))
    assert.equal(r, "rejected_group")
    assert.equal(sent.length, 0, "陌生群语义：不回执防探测")
  })

  it("热加群：陌生群拒 → 白名单+绑定种子加入 → 即通且 binding 用新种子", async () => {
    const { gw, live, store } = build()
    const r1 = await gw.handleInbound(groupMsg({ externalChatId: "oc_g2", externalMessageId: "om_1" }))
    assert.equal(r1, "rejected_group")
    live.allowedGroupChats = [...live.allowedGroupChats, "oc_g2"]
    live.groupBindings = { ...live.groupBindings, oc_g2: "sg-second" }
    const r2 = await gw.handleInbound(groupMsg({ externalChatId: "oc_g2", externalMessageId: "om_2" }))
    assert.equal(r2, "queued")
    const b = store.db
      .prepare("SELECT session_group_id FROM channel_bindings WHERE external_chat_id = 'oc_g2'")
      .get() as { session_group_id: string }
    assert.equal(b.session_group_id, "sg-second")
  })

  it("p2p 热放行：白名单外拒 → 加入 → 即通", async () => {
    const { gw, live } = build()
    const p2p = (id: string, om: string): InboundChannelMessage => ({
      connectorId: "feishu",
      externalChatId: "oc_p2p_x",
      externalMessageId: om,
      senderOpenId: id,
      chatKind: "p2p",
      text: "在吗",
      mentionsBot: true,
      senderName: null,
    })
    assert.equal(await gw.handleInbound(p2p("ou_second", "om_1")), "rejected_allowlist")
    live.allowedOpenIds = [...live.allowedOpenIds, "ou_second"]
    assert.equal(await gw.handleInbound(p2p("ou_second", "om_2")), "queued")
  })
})

describe("M-T4 recordReject 四点挂钩（AC-M3 审计持久化入口）", () => {
  it("p2p allowlist / 群白名单 / 成员 / unbound 四拒各上报正确载荷", async () => {
    const got: Array<Record<string, unknown>> = []
    const { gw, live } = build({ recordReject: (r) => got.push(r) })
    live.allowedGroupChats = ["oc_g1", "oc_nb"] // oc_nb 无绑定种子 → unbound

    await gw.handleInbound({
      connectorId: "feishu",
      externalChatId: "oc_p2p_s",
      externalMessageId: "om_p1",
      senderOpenId: "ou_stranger",
      chatKind: "p2p",
      text: "hi",
      mentionsBot: true,
      senderName: null,
    })
    await gw.handleInbound(groupMsg({ externalChatId: "oc_unknown", externalMessageId: "om_g1" }))
    await gw.handleInbound(groupMsg({ senderOpenId: "ou_stranger", externalMessageId: "om_g2" }))
    await gw.handleInbound(groupMsg({ externalChatId: "oc_nb", externalMessageId: "om_g3" }))

    assert.deepEqual(got, [
      { chatId: "oc_p2p_s", chatKind: "p2p", openId: "ou_stranger", reason: "allowlist" },
      { chatId: "oc_unknown", chatKind: "group", openId: "ou_li", reason: "group-not-allowed" },
      { chatId: "oc_g1", chatKind: "group", openId: "ou_stranger", reason: "member-not-allowed" },
      { chatId: "oc_nb", chatKind: "group", openId: "ou_li", reason: "unbound" },
    ])
  })

  it("未 @bot 静默忽略不上报（设计即无痕，不进待放行）", async () => {
    const got: Array<Record<string, unknown>> = []
    const { gw } = build({ recordReject: (r) => got.push(r) })
    await gw.handleInbound(groupMsg({ mentionsBot: false }))
    assert.equal(got.length, 0)
  })

  it("recordReject 抛异常 → 拒绝结果照常返回 + 审计降级，不击穿主链", async () => {
    const { gw, audits } = build({
      recordReject: () => {
        throw new Error("db locked")
      },
    })
    const r = await gw.handleInbound(groupMsg({ senderOpenId: "ou_stranger" }))
    assert.equal(r, "rejected_member")
    assert.ok(
      audits.some((a) => a.event === "reject-persist-error"),
      "持久化失败要有降级审计",
    )
  })
})

describe("M-T4 静态 config 向后兼容", () => {
  it("直接传对象（旧形态）仍工作", async () => {
    dbSeq += 1
    const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
    openStores.push(store)
    const injector = makeFakeInjector()
    const gw = new ChannelGateway({
      db: store,
      injector,
      sender: { sendText: async () => ({ ok: true }) },
      readFinalMessage: () => null,
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
      genId: () => "id-static",
      now: () => "2026-07-04T00:00:00.000Z",
    })
    const r = await gw.handleInbound({
      connectorId: "feishu",
      externalChatId: "oc_sun",
      externalMessageId: "om_s1",
      senderOpenId: "ou_sun",
      chatKind: "p2p",
      text: "在吗",
      mentionsBot: true,
      senderName: null,
    })
    assert.equal(r, "queued")
  })
})

describe("P2.6 T1 成员禁用（AC-N3 网关门面：真 store 供配）", () => {
  it("禁用成员群消息按 member-not-allowed 拒 + 进待放行；禁用 owner p2p 按 allowlist 拒；re-enable 即通", async () => {
    dbSeq += 1
    const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
    openStores.push(store)
    const { ChannelAdminStore } = await import("./channel-admin-store")
    let aid = 0
    const admin = new ChannelAdminStore({
      db: store,
      channel: "feishu",
      genId: () => `aid-${++aid}`,
      now: () => new Date(1751600000000 + aid * 1000).toISOString(),
    })
    admin.seedFromEnv({
      allowedOpenIds: ["ou_sun"],
      groupMembers: {
        ou_sun: { name: "村长", role: "owner" },
        ou_li: { name: "小李", role: "participant" },
      },
      allowedGroupChats: ["oc_g1"],
      groupBindings: { oc_g1: "sg-group-room" },
    })
    const injector = makeFakeInjector()
    const sender: ChannelSender = { sendText: async () => ({ ok: true }) }
    let idc = 0
    const gw = new ChannelGateway({
      db: store,
      injector,
      sender,
      readFinalMessage: () => null,
      resolveThread: () => "thread-claude-1",
      config: () => ({
        connectorId: "feishu",
        bindSessionGroup: "sg-mobile",
        defaultProvider: "claude",
        ...admin.getAuthView(),
      }),
      recordReject: (r) => admin.recordReject(r),
      genId: () => `id-${++idc}`,
      now: () => new Date(1751600000000 + idc * 1000).toISOString(),
      audit: () => {},
    })

    // 基线：小李（participant）群消息过门
    assert.equal(await gw.handleInbound(groupMsg({ externalMessageId: "om_base" })), "queued")

    // 管理页禁用小李 → 同实例下一条按非白名单拒 + 待放行有据
    admin.setMemberEnabled("ou_li", false)
    assert.equal(
      await gw.handleInbound(groupMsg({ externalMessageId: "om_disabled" })),
      "rejected_member",
    )
    const pending = admin.listAudit("pending").find((a) => a.openId === "ou_li")
    assert.ok(pending, "禁用成员被拒应进待放行（reason=member-not-allowed）")
    assert.equal(pending.reason, "member-not-allowed")

    // 禁用 owner → p2p 按 allowlist 拒（enabled=0 = 非白名单语义，AC-N3）
    admin.setMemberEnabled("ou_sun", false)
    assert.equal(
      await gw.handleInbound({
        connectorId: "feishu",
        externalChatId: "p2p_sun",
        externalMessageId: "om_p2p_disabled",
        senderOpenId: "ou_sun",
        chatKind: "p2p",
        text: "在吗",
        mentionsBot: true,
        senderName: null,
      }),
      "rejected_allowlist",
    )

    // re-enable 双双恢复（热生效，不重启）
    admin.setMemberEnabled("ou_li", true)
    admin.setMemberEnabled("ou_sun", true)
    assert.equal(await gw.handleInbound(groupMsg({ externalMessageId: "om_back" })), "queued")
    assert.equal(
      await gw.handleInbound({
        connectorId: "feishu",
        externalChatId: "p2p_sun",
        externalMessageId: "om_p2p_back",
        senderOpenId: "ou_sun",
        chatKind: "p2p",
        text: "在吗",
        mentionsBot: true,
        senderName: null,
      }),
      "queued",
    )
    // 注入数 = 2：基线群消息 + p2p 恢复条。恢复后的群消息过门入账本但不注入——
    // 群 binding 首条 turn 还在飞（本测试无 invocation.finished），AC7 单 turn 语义正确。
    assert.equal(injector.injected.length, 2)
    const queuedBack = store.db
      .prepare("SELECT state FROM channel_inbound_ledger WHERE external_message_id = 'om_back'")
      .get() as { state: string } | undefined
    assert.equal(queuedBack?.state, "queued", "恢复后的群消息过门排队（非拒绝）")
  })
})
