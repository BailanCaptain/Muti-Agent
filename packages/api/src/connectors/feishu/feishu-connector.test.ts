import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../../db/sqlite"
import { ChannelAdminStore } from "../channel-admin-store"
import { loadFeishuChannelConfig } from "../channel-config"
import { ChannelGateway } from "../channel-gateway"
import type { ChannelSender } from "../channel-types"
import {
  type FeishuWsTransport,
  startFeishuConnector,
  wireFeishuConnector,
} from "./feishu-connector"

/** F040 T14：connector 生命周期 —— fake transport 事件 → gateway 全链 / disabled 不启动 / 错误不击穿 boot（AC1）。 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-connector-"))
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

/** fake transport：手动 emit 事件模拟飞书 WS */
function makeFakeTransport() {
  let handler: ((data: unknown) => Promise<void> | void) | null = null
  let started = false
  let stopped = false
  const transport: FeishuWsTransport = {
    async start(onEvent) {
      started = true
      handler = onEvent
    },
    async stop() {
      stopped = true
    },
  }
  return {
    transport,
    isStarted: () => started,
    isStopped: () => stopped,
    async emit(data: unknown) {
      await handler?.(data)
    },
  }
}

function makeGateway(opts?: {
  config?: Partial<{
    allowedGroupChats: string[]
    groupMembers: Record<string, { name: string; role: "owner" | "participant" }>
    groupBindings: Record<string, string>
  }>
  onReject?: (r: { chatId: string; chatKind: string; openId: string; reason: string }) => void
  sendText?: ChannelSender["sendText"]
}) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  const injected: RealtimeClientEvent[] = []
  let idc = 0
  let tick = 0
  const sender: ChannelSender = {
    sendText:
      opts?.sendText ??
      (async () => {
        return { ok: true }
      }),
  }
  const gw = new ChannelGateway({
    db: store,
    injector: {
      handleClientEvent(e: RealtimeClientEvent, emit: (x: RealtimeServerEvent) => void) {
        injected.push(e)
        emit({
          type: "message.created",
          payload: {
            threadId: "t1",
            sessionGroupId: "sg-mobile",
            // biome-ignore lint/suspicious/noExplicitAny: fake
            message: { id: "um_1", role: "user" } as any,
          },
        } as RealtimeServerEvent)
      },
      getBusyStatus: () => null,
    },
    sender,
    readFinalMessage: () => null,
    resolveThread: () => "t1",
    config: {
      connectorId: "feishu",
      allowedOpenIds: ["ou_sun"],
      bindSessionGroup: "sg-mobile",
      defaultProvider: "claude",
      allowedGroupChats: [],
      groupMembers: {},
      groupBindings: {},
      ...opts?.config,
    },
    recordReject: opts?.onReject,
    genId: () => `id-${++idc}`,
    now: () => `2026-07-03T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  })
  return { gw, injected }
}

function p2pEvent() {
  return {
    sender: { sender_id: { open_id: "ou_sun" }, sender_type: "user" },
    message: {
      message_id: "om_1",
      chat_id: "oc_sun",
      chat_type: "p2p",
      message_type: "text",
      create_time: "1720000000000",
      content: JSON.stringify({ text: "在吗" }),
    },
  }
}

describe("startFeishuConnector（T14 AC1）", () => {
  it("transport 事件 → parser → gateway 注入（全链）", async () => {
    const { gw, injected } = makeGateway()
    const t = makeFakeTransport()
    await startFeishuConnector({ transport: t.transport, gateway: gw })
    assert.ok(t.isStarted())
    await t.emit(p2pEvent())
    assert.equal(injected.length, 1)
    assert.equal((injected[0] as { payload: { content: string } }).payload.content, "在吗")
  })

  it("非白名单 open_id 事件 → 不注入（门在 gateway 生效）", async () => {
    const { gw, injected } = makeGateway()
    const t = makeFakeTransport()
    await startFeishuConnector({ transport: t.transport, gateway: gw })
    const ev = p2pEvent()
    ev.sender.sender_id.open_id = "ou_stranger"
    await t.emit(ev)
    assert.equal(injected.length, 0)
  })

  it("parser skip 的事件（image 缺 image_key = 破损媒体）→ 不注入不抛", async () => {
    const { gw, injected } = makeGateway()
    const t = makeFakeTransport()
    await startFeishuConnector({ transport: t.transport, gateway: gw })
    const ev = p2pEvent()
    ;(ev.message as Record<string, unknown>).message_type = "image"
    await t.emit(ev)
    assert.equal(injected.length, 0)
  })

  it("P3 AC16：image 事件 → downloadMedia → 注入带 contentBlocks（image_key 透传下载器）", async () => {
    const { gw, injected } = makeGateway()
    const t = makeFakeTransport()
    const dlCalls: Array<{ key: string; kind: string }> = []
    await startFeishuConnector({
      transport: t.transport,
      gateway: gw,
      downloadMedia: async (input) => {
        dlCalls.push({ key: input.key, kind: input.kind })
        return { ok: true, url: "/uploads/feishu-x.png" }
      },
    })
    const ev = p2pEvent()
    ;(ev.message as Record<string, unknown>).message_type = "image"
    ;(ev.message as Record<string, unknown>).content = JSON.stringify({ image_key: "img_k1" })
    await t.emit(ev)
    assert.deepEqual(dlCalls, [{ key: "img_k1", kind: "image" }])
    assert.equal(injected.length, 1)
    const payload = (injected[0] as { payload: Record<string, unknown> }).payload
    assert.equal(payload.content, "[图片]")
    assert.deepEqual(payload.contentBlocks, [
      {
        type: "image",
        url: "/uploads/feishu-x.png",
        alt: "图片",
        meta: { source: "feishu_inbound" },
      },
    ])
  })

  it("P3 AC16：下载失败 → 降级纯文本标签注入（附件是增强不击穿）+ onError 记录", async () => {
    const { gw, injected } = makeGateway()
    const t = makeFakeTransport()
    const errs: string[] = []
    await startFeishuConnector({
      transport: t.transport,
      gateway: gw,
      onError: (e) => errs.push(String(e)),
      downloadMedia: async () => ({ ok: false, error: "http 404" }),
    })
    const ev = p2pEvent()
    ;(ev.message as Record<string, unknown>).message_type = "file"
    ;(ev.message as Record<string, unknown>).content = JSON.stringify({
      file_key: "f_k1",
      file_name: "周报.pdf",
    })
    await t.emit(ev)
    assert.equal(injected.length, 1)
    const payload = (injected[0] as { payload: Record<string, unknown> }).payload
    assert.equal(payload.content, "[文件] 周报.pdf")
    assert.ok(!("contentBlocks" in payload))
    assert.ok(errs.some((e) => e.includes("media-download-failed")))
  })

  it("F1 回归：门会拒的媒体消息 → 零下载（预检在磁盘副作用前，拒绝路径不落孤儿文件）", async () => {
    const { gw, injected } = makeGateway()
    const t = makeFakeTransport()
    const dlCalls: string[] = []
    await startFeishuConnector({
      transport: t.transport,
      gateway: gw,
      downloadMedia: async (input) => {
        dlCalls.push(input.key)
        return { ok: true, url: "/uploads/feishu-x.png" }
      },
    })
    // p2p 陌生人发图：门必拒 → 下载器一次都不能被调（fill-disk 面）
    const evP2p = p2pEvent()
    evP2p.sender.sender_id.open_id = "ou_stranger"
    ;(evP2p.message as Record<string, unknown>).message_type = "image"
    ;(evP2p.message as Record<string, unknown>).content = JSON.stringify({ image_key: "img_evil" })
    await t.emit(evP2p)
    // 群媒体（群模式未开 allowedGroupChats=[]）：同样零下载
    const evGroup = p2pEvent()
    ;(evGroup.message as Record<string, unknown>).chat_type = "group"
    ;(evGroup.message as Record<string, unknown>).message_type = "image"
    ;(evGroup.message as Record<string, unknown>).content = JSON.stringify({ image_key: "img_g" })
    await t.emit(evGroup)
    assert.deepEqual(dlCalls, [], "拒绝/忽略路径禁到达下载器")
    assert.equal(injected.length, 0)
  })

  it("单个事件处理抛错不击穿 transport（handler 吞异常 + 审计）", async () => {
    const { gw } = makeGateway()
    const t = makeFakeTransport()
    const audits: string[] = []
    await startFeishuConnector({
      transport: t.transport,
      gateway: gw,
      onError: (e) => audits.push(String(e)),
    })
    // 传入畸形 data 触发 parser skip（不抛）；再传 null 也不该击穿
    await t.emit(null)
    await t.emit(undefined)
    assert.ok(t.isStarted())
  })

  it("stop 调用 transport.stop", async () => {
    const { gw } = makeGateway()
    const t = makeFakeTransport()
    const handle = await startFeishuConnector({ transport: t.transport, gateway: gw })
    await handle.stop()
    assert.ok(t.isStopped())
  })

  it("P2-1：transport.start 抛错不击穿（返回 handle + onError 记录）", async () => {
    const { gw } = makeGateway()
    const errs: unknown[] = []
    const failing: FeishuWsTransport = {
      async start() {
        throw new Error("WS handshake failed (bad secret)")
      },
      async stop() {},
    }
    // 不 rethrow —— 主服务 boot 不崩
    const handle = await startFeishuConnector({
      transport: failing,
      gateway: gw,
      onError: (e) => errs.push(e),
    })
    assert.ok(handle)
    assert.equal(errs.length, 1)
    assert.match(String(errs[0]), /handshake failed/)
  })
})

/**
 * F040 T7 修9（德彪 r7 P2）：预检拒绝后不许清 media 描述符——真门要按原始形态复判，
 * 否则退化成「无 @ 无媒体 → ignored_no_mention」，rejected_group 审计 / 未绑定回执全丢。
 * 清描述符仅限预检通过的消息（下载成败/未配下载器都已定型为 attachments / 降级标签）。
 */
describe("T7 修9：预检拒绝保留 media 描述符（审计码不退化）", () => {
  it("预检拒 → media 原样进真门 + 零下载（fake gateway 直证 mutation）", async () => {
    const seen: Array<{ media: unknown; attachments?: unknown[] }> = []
    const fakeGw = {
      precheckInbound: () => false,
      handleInbound: async (m: { media: unknown }) => {
        seen.push(m as never)
        return "rejected_group"
      },
    } as unknown as ChannelGateway
    const t = makeFakeTransport()
    const dl: string[] = []
    await startFeishuConnector({
      transport: t.transport,
      gateway: fakeGw,
      downloadMedia: async (i) => {
        dl.push(i.key)
        return { ok: true, url: "/uploads/x.png" }
      },
    })
    const ev = p2pEvent()
    ;(ev.message as Record<string, unknown>).chat_type = "group"
    ;(ev.message as Record<string, unknown>).message_type = "image"
    ;(ev.message as Record<string, unknown>).content = JSON.stringify({ image_key: "img_r7" })
    await t.emit(ev)
    assert.deepEqual(dl, [], "预检拒仍零下载（F1 防孤儿文件语义不回退）")
    assert.equal(seen.length, 1)
    assert.ok(seen[0].media, "media 描述符必须存活到真门（清掉 = 审计码退化 ignored）")
  })

  it("owner 裸图打非白名单群 → rejected_group 落审计（此前被静默 ignored 吞掉）", async () => {
    const rejects: Array<{ reason: string; chatId: string; openId: string }> = []
    const { gw, injected } = makeGateway({
      config: { allowedGroupChats: ["oc_white"], groupBindings: { oc_white: "sg-mobile" } },
      onReject: (r) => rejects.push({ reason: r.reason, chatId: r.chatId, openId: r.openId }),
    })
    const t = makeFakeTransport()
    const dl: string[] = []
    await startFeishuConnector({
      transport: t.transport,
      gateway: gw,
      downloadMedia: async (i) => {
        dl.push(i.key)
        return { ok: true, url: "/uploads/x.png" }
      },
    })
    const ev = p2pEvent()
    ;(ev.message as Record<string, unknown>).chat_type = "group"
    ;(ev.message as Record<string, unknown>).chat_id = "oc_dark"
    ;(ev.message as Record<string, unknown>).message_type = "image"
    ;(ev.message as Record<string, unknown>).content = JSON.stringify({ image_key: "img_d" })
    await t.emit(ev)
    assert.deepEqual(dl, [], "非白名单群零下载")
    assert.equal(injected.length, 0)
    assert.deepEqual(rejects, [
      { reason: "group-not-allowed", chatId: "oc_dark", openId: "ou_sun" },
    ])
  })

  it("owner 裸图打已授权未绑定群 → rejected_unbound 回执推配置（提示不再丢失）", async () => {
    const sent: string[] = []
    const rejects: string[] = []
    const { gw, injected } = makeGateway({
      config: { allowedGroupChats: ["oc_white"], groupBindings: {} },
      onReject: (r) => rejects.push(r.reason),
      sendText: async (_chatId, text) => {
        sent.push(text)
        return { ok: true }
      },
    })
    const t = makeFakeTransport()
    await startFeishuConnector({ transport: t.transport, gateway: gw })
    const ev = p2pEvent()
    ;(ev.message as Record<string, unknown>).chat_type = "group"
    ;(ev.message as Record<string, unknown>).chat_id = "oc_white"
    ;(ev.message as Record<string, unknown>).message_type = "image"
    ;(ev.message as Record<string, unknown>).content = JSON.stringify({ image_key: "img_u" })
    await t.emit(ev)
    assert.equal(injected.length, 0)
    assert.deepEqual(rejects, ["unbound"])
    assert.ok(
      sent.some((s) => s.includes("还没选房间")),
      `未绑定回执必须到达 owner，实收：${JSON.stringify(sent)}`,
    )
  })
})

describe("wireFeishuConnector（T14 boot gate AC1）", () => {
  function deps(config: ReturnType<typeof loadFeishuChannelConfig>, transportFactory?: unknown) {
    dbSeq += 1
    const store = new SqliteStore(path.join(tmpRoot, `wire-${dbSeq}.sqlite`))
    openStores.push(store)
    const registered: string[] = []
    return {
      registered,
      wire: {
        config,
        db: store,
        injector: {
          handleClientEvent() {},
          getBusyStatus: () => null,
        },
        findThread: () => ({ id: "t1" }),
        readFinalContent: () => null,
        eventBus: {
          on(type: "invocation.finished" | "invocation.failed") {
            registered.push(type)
          },
        },
        transportFactory: transportFactory as never,
        genId: () => "id-1",
        now: () => "2026-07-03T00:00:00.000Z",
      },
    }
  }

  it("disabled config → 返回 null，不订阅 eventBus、不建 transport（主服务零影响）", async () => {
    const t = makeFakeTransport()
    const d = deps(loadFeishuChannelConfig({}), () => t.transport)
    const handle = await wireFeishuConnector(d.wire)
    assert.equal(handle, null)
    assert.equal(d.registered.length, 0)
    assert.equal(t.isStarted(), false)
  })

  it("enabled config → 启动 transport + 订阅 finished/failed", async () => {
    const t = makeFakeTransport()
    const cfg = loadFeishuChannelConfig({
      FEISHU_APP_ID: "cli_a",
      FEISHU_APP_SECRET: "s",
      FEISHU_ALLOWED_OPEN_IDS: "ou_sun",
      FEISHU_BIND_SESSION_GROUP: "sg-mobile",
    })
    const d = deps(cfg, () => t.transport)
    const handle = await wireFeishuConnector(d.wire)
    assert.ok(handle)
    assert.ok(t.isStarted())
    assert.deepEqual(d.registered, ["invocation.finished", "invocation.failed"])
  })
})

/**
 * F040 Phase 2.5 M-T5（AC-M1/M2 boot 接线）：wire 带 adminStore →
 * env 种子导入 + 网关配置走 store 快照（管理面写 → 下一条消息即生效，不重启）
 * + 拒绝持久化进审计表。p2p 路径验证（群门语义在 hot-config 测试盖过；
 * wire 层群路径依赖 botOpenId 网络获取，单测环境恒 null）。
 */
describe("wireFeishuConnector + ChannelAdminStore（Phase 2.5 M-T5）", () => {
  it("seed 导入 + 热放行 + 拒绝落审计（全链不重启）", async () => {
    dbSeq += 1
    const store = new SqliteStore(path.join(tmpRoot, `wire-admin-${dbSeq}.sqlite`))
    openStores.push(store)
    const adminStore = new ChannelAdminStore({
      db: store,
      channel: "feishu",
      genId: (() => {
        let i = 0
        return () => `aid-${++i}`
      })(),
      now: () => "2026-07-04T00:00:00.000Z",
    })
    const injected: RealtimeClientEvent[] = []
    const t = makeFakeTransport()
    const cfg = loadFeishuChannelConfig({
      FEISHU_APP_ID: "cli_a",
      FEISHU_APP_SECRET: "s",
      FEISHU_ALLOWED_OPEN_IDS: "ou_sun",
      FEISHU_BIND_SESSION_GROUP: "sg-mobile",
      FEISHU_GROUP_MEMBERS: "ou_li:小李",
    })
    let idc = 0
    const handle = await wireFeishuConnector({
      config: cfg,
      db: store,
      adminStore,
      injector: {
        handleClientEvent(e: RealtimeClientEvent) {
          injected.push(e)
        },
        getBusyStatus: () => null,
      },
      findThread: () => ({ id: "t1" }),
      readFinalContent: () => null,
      eventBus: { on() {} },
      transportFactory: () => t.transport,
      genId: () => `id-${++idc}`,
      now: () => "2026-07-04T00:00:01.000Z",
    })
    assert.ok(handle)

    // ① env 种子导入：owner + participant 都进表（DB 真相源就位）
    assert.deepEqual(
      adminStore.listMembers().map((m) => ({ openId: m.openId, role: m.role })),
      [
        { openId: "ou_sun", role: "owner" },
        { openId: "ou_li", role: "participant" },
      ],
    )

    // ② 陌生 p2p → 拒 + 审计表落待放行行（reason=allowlist）
    await t.emit({
      sender: { sender_id: { open_id: "ou_second" }, sender_type: "user" },
      message: {
        message_id: "om_r1",
        chat_id: "oc_second",
        chat_type: "p2p",
        message_type: "text",
        create_time: "1720000000000",
        content: JSON.stringify({ text: "在吗" }),
      },
    })
    assert.equal(injected.length, 0)
    const pending = adminStore.listAudit("pending")
    assert.equal(pending.length, 1)
    assert.equal(pending[0].openId, "ou_second")
    assert.equal(pending[0].reason, "allowlist")

    // ③ 管理面放行（allowFromAudit = 一键放行语义）→ 同进程下一条即注入（AC-M2）
    adminStore.allowFromAudit(pending[0].id, { displayName: "二号", role: "owner" })
    await t.emit({
      sender: { sender_id: { open_id: "ou_second" }, sender_type: "user" },
      message: {
        message_id: "om_r2",
        chat_id: "oc_second",
        chat_type: "p2p",
        message_type: "text",
        create_time: "1720000001000",
        content: JSON.stringify({ text: "现在呢" }),
      },
    })
    assert.equal(injected.length, 1, "放行后同实例即通，无需重启")
  })

  it("seed 幂等：DB 已有配置时 wire 重启不覆盖手工改动（DB wins）", async () => {
    dbSeq += 1
    const store = new SqliteStore(path.join(tmpRoot, `wire-admin-${dbSeq}.sqlite`))
    openStores.push(store)
    const mkAdmin = () =>
      new ChannelAdminStore({
        db: store,
        channel: "feishu",
        genId: () => "aid-x",
        now: () => "2026-07-04T00:00:00.000Z",
      })
    const adminStore = mkAdmin()
    adminStore.upsertMember("ou_manual", "手工加的", "owner")
    const t = makeFakeTransport()
    const cfg = loadFeishuChannelConfig({
      FEISHU_APP_ID: "cli_a",
      FEISHU_APP_SECRET: "s",
      FEISHU_ALLOWED_OPEN_IDS: "ou_sun",
      FEISHU_BIND_SESSION_GROUP: "sg-mobile",
    })
    const handle = await wireFeishuConnector({
      config: cfg,
      db: store,
      adminStore,
      injector: { handleClientEvent() {}, getBusyStatus: () => null },
      findThread: () => ({ id: "t1" }),
      readFinalContent: () => null,
      eventBus: { on() {} },
      transportFactory: () => t.transport,
      genId: () => "id-1",
      now: () => "2026-07-04T00:00:01.000Z",
    })
    assert.ok(handle)
    // env 的 ou_sun 没被导入（members 表非空 → DB wins）
    assert.deepEqual(
      adminStore.listMembers().map((m) => m.openId),
      ["ou_manual"],
    )
  })
})

/** F040 Phase 2 T7：boot 取 bot 自身 open_id（群 @bot 判定要素）——任何失败 → null 不击穿。 */
import { fetchBotOpenId } from "./feishu-connector"

it("T7 fetchBotOpenId：code 0 → open_id；业务错/破损/抛异常 → null（fail-closed）", async () => {
  const ok = await fetchBotOpenId(
    {
      async request() {
        return {
          status: 200,
          text: JSON.stringify({ code: 0, bot: { open_id: "ou_bot_1" } }),
        }
      },
      async fetchText() {
        return ""
      },
    } as never,
    async () => "tok",
  )
  assert.equal(ok, "ou_bot_1")

  const bizErr = await fetchBotOpenId(
    {
      async request() {
        return { status: 200, text: JSON.stringify({ code: 99991672, msg: "no perm" }) }
      },
      async fetchText() {
        return ""
      },
    } as never,
    async () => "tok",
  )
  assert.equal(bizErr, null)

  const thrown = await fetchBotOpenId(
    {
      async request() {
        throw new Error("network down")
      },
      async fetchText() {
        return ""
      },
    } as never,
    async () => "tok",
  )
  assert.equal(thrown, null)
})

describe("wireFeishuConnector + 命令面（P2.6 T8 装配全链）", () => {
  it("owner p2p /newroom → 建房+换绑落库 + 回执带 R-号 + 零注入；非命令文本注入链原样", async () => {
    dbSeq += 1
    const store = new SqliteStore(path.join(tmpRoot, `wire-cmd-${dbSeq}.sqlite`))
    openStores.push(store)
    const adminStore = new ChannelAdminStore({
      db: store,
      channel: "feishu",
      genId: (() => {
        let i = 0
        return () => `aid-${++i}`
      })(),
      now: () => "2026-07-05T00:00:00.000Z",
    })
    const { ChannelCommandExecutor } = await import("../channel-commands")
    const roomList: Array<{ id: string; roomId: string | null; title: string }> = []
    let created = 0
    const commands = new ChannelCommandExecutor({
      adminStore,
      rooms: {
        list: () => [...roomList],
        create: (title: string) => {
          created += 1
          const room = { id: `sg-cmd-${created}`, roomId: `R-20${created}`, title }
          roomList.push(room)
          return room
        },
      },
      runtimeConfig: {
        getGlobal: () => ({}),
        getSession: () => ({}),
        setSession: () => {},
        getPending: () => ({}),
        setPending: () => {},
      },
      findThread: () => null,
      isBusy: () => false,
    })
    const injected: RealtimeClientEvent[] = []
    const sent: Array<{ chatId: string; text: string }> = []
    const t = makeFakeTransport()
    const cfg = loadFeishuChannelConfig({
      FEISHU_APP_ID: "cli_a",
      FEISHU_APP_SECRET: "s",
      FEISHU_ALLOWED_OPEN_IDS: "ou_sun",
      FEISHU_BIND_SESSION_GROUP: "sg-mobile",
    })
    let idc = 0
    const handle = await wireFeishuConnector({
      config: cfg,
      db: store,
      adminStore,
      injector: {
        handleClientEvent(e: RealtimeClientEvent, emit: (x: RealtimeServerEvent) => void) {
          injected.push(e)
          emit({
            type: "message.created",
            payload: {
              threadId: "t1",
              sessionGroupId: "sg-mobile",
              // biome-ignore lint/suspicious/noExplicitAny: fake
              message: { id: `um_${injected.length}`, role: "user" } as any,
            },
          } as RealtimeServerEvent)
        },
        getBusyStatus: () => null,
      },
      findThread: () => ({ id: "t1" }),
      readFinalContent: () => null,
      eventBus: { on() {} },
      transportFactory: () => t.transport,
      senderOverride: {
        async sendText(chatId, text) {
          sent.push({ chatId, text })
          return { ok: true }
        },
      },
      commands,
      genId: () => `id-${++idc}`,
      now: () => "2026-07-05T00:00:01.000Z",
    })
    assert.ok(handle)

    // owner 发 /newroom → 命令面：建房 + binding 落库 + 回执，不注入
    await t.emit({
      sender: { sender_id: { open_id: "ou_sun" }, sender_type: "user" },
      message: {
        message_id: "om_cmd_1",
        chat_id: "p2p_sun",
        chat_type: "p2p",
        message_type: "text",
        create_time: "1720000000000",
        content: JSON.stringify({ text: "/newroom 手机指挥房" }),
      },
    })
    assert.equal(injected.length, 0, "命令不注入房间")
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /R-201/)
    assert.match(sent[0].text, /手机指挥房/)
    const bindingRow = store.db
      .prepare(
        "SELECT session_group_id FROM channel_bindings WHERE connector_id = 'feishu' AND external_chat_id = 'p2p_sun'",
      )
      .get() as { session_group_id: string } | undefined
    assert.equal(bindingRow?.session_group_id, "sg-cmd-1")
    const cmdAudit = store.db
      .prepare("SELECT result FROM channel_command_audit WHERE external_message_id = 'om_cmd_1'")
      .get() as { result: string } | undefined
    assert.equal(cmdAudit?.result, "done")

    // 非命令文本 → 注入链原样，且进的是 /newroom 换绑后的新房 binding
    await t.emit({
      sender: { sender_id: { open_id: "ou_sun" }, sender_type: "user" },
      message: {
        message_id: "om_normal_1",
        chat_id: "p2p_sun",
        chat_type: "p2p",
        message_type: "text",
        create_time: "1720000000001",
        content: JSON.stringify({ text: "在吗" }),
      },
    })
    assert.equal(injected.length, 1, "普通消息照常注入")
    await handle.stop()
  })
})
