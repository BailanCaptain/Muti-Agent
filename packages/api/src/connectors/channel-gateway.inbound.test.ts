import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, beforeEach, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { ChannelGateway } from "./channel-gateway"
import type { InboundChannelMessage } from "./channel-types"

/**
 * F040 T5-T8：ChannelGateway 入站链 —— 门（AC4）/ 幂等（AC5）/ FIFO drain（AC7）/ 注入（AC2）。
 * 真 SQLite（tmp）+ fake injector；每 it 独立 gateway/DB。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-gateway-"))
let dbSeq = 0
const openStores: SqliteStore[] = []

after(() => {
  // Windows：WAL 句柄未关会让 rmSync EBUSY → 先 close 全部 store
  for (const s of openStores) {
    try {
      s.db.close()
    } catch {}
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

/**
 * fake injector（忠实版，德彪 r1 P1-1 后）：getBusyStatus 恒 null —— direct turn 不占
 * dispatch slot，生产里 getBusyStatus 也是 null。排队完全靠 gateway 的 inflight 追踪 +
 * onInvocationFinished 清 inflight，不再用 fake 自设 busy 掩盖生产语义。
 */
function makeFakeInjector() {
  const injected: RealtimeClientEvent[] = []
  let counter = 0
  return {
    injected,
    handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void) {
      injected.push(event)
      counter += 1
      const umId = `um_${counter}`
      emit({
        type: "message.created",
        payload: {
          threadId: (event as { payload: { threadId: string } }).payload.threadId,
          sessionGroupId: "sg-mobile",
          // biome-ignore lint/suspicious/noExplicitAny: fake timeline message
          message: { id: umId, role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus(): string | null {
      return null // direct turn 不占 slot
    },
  }
}

function gatewayWith(
  injector: ReturnType<typeof makeFakeInjector>,
  opts: { resolveAttachmentPath?: (url: string) => string | null } = {},
) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  let idc = 0
  let tick = 0
  const gw = new ChannelGateway({
    db: store,
    injector,
    sender: {
      async sendText() {
        return { ok: true }
      },
    },
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
    resolveAttachmentPath: opts.resolveAttachmentPath,
    genId: () => `id-${++idc}`,
    now: () => `2026-07-03T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  })
  return { gw, store }
}

function msg(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "oc_sun",
    externalMessageId: "om_1",
    senderOpenId: "ou_sun",
    chatKind: "p2p",
    text: "在吗",
    mentionsBot: true,
    senderName: null,
    ...overrides,
  }
}

describe("T5 入站门（AC4 fail-closed）", () => {
  let injector: ReturnType<typeof makeFakeInjector>
  beforeEach(() => {
    injector = makeFakeInjector()
  })

  it("白名单 p2p → queued（过门）", async () => {
    const { gw } = gatewayWith(injector)
    assert.equal(await gw.handleInbound(msg()), "queued")
  })

  it("group 事件 → rejected_chatkind，不注入（白名单用户在群里发言也拒）", async () => {
    const { gw } = gatewayWith(injector)
    assert.equal(await gw.handleInbound(msg({ chatKind: "group" })), "rejected_chatkind")
    assert.equal(injector.injected.length, 0)
  })

  it("非白名单 open_id → rejected_allowlist，不注入", async () => {
    const { gw } = gatewayWith(injector)
    assert.equal(await gw.handleInbound(msg({ senderOpenId: "ou_stranger" })), "rejected_allowlist")
    assert.equal(injector.injected.length, 0)
  })
})

describe("T6 幂等（AC5）", () => {
  it("同 external_message_id 二投 → 第一次 queued 第二次 duplicate，注入仅一次", async () => {
    const injector = makeFakeInjector()
    const { gw } = gatewayWith(injector)
    assert.equal(await gw.handleInbound(msg()), "queued")
    assert.equal(await gw.handleInbound(msg()), "duplicate")
    assert.equal(injector.injected.length, 1)
  })

  it("重启重放（新 gateway 同 DB）仍 duplicate", async () => {
    const injector = makeFakeInjector()
    const { gw, store } = gatewayWith(injector)
    await gw.handleInbound(msg())
    // 新实例复用同一 DB 文件
    const injector2 = makeFakeInjector()
    const gw2 = new ChannelGateway({
      db: store,
      injector: injector2,
      sender: {
        async sendText() {
          return { ok: true }
        },
      },
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
      genId: () => "id-x",
      now: () => "2026-07-03T00:01:00.000Z",
    })
    assert.equal(await gw2.handleInbound(msg()), "duplicate")
  })

  it("不同 chat 同 message_id 不冲突", async () => {
    const injector = makeFakeInjector()
    const { gw } = gatewayWith(injector)
    await gw.handleInbound(msg())
    assert.equal(await gw.handleInbound(msg({ externalChatId: "oc_other" })), "queued")
  })
})

describe("T7 FIFO drain（AC7）", () => {
  it("turn 进行中连发 3 条 → 按序注入，零丢失", async () => {
    const injector = makeFakeInjector()
    const { gw } = gatewayWith(injector)
    await gw.handleInbound(msg({ externalMessageId: "om_1", text: "一" }))
    await gw.handleInbound(msg({ externalMessageId: "om_2", text: "二" }))
    await gw.handleInbound(msg({ externalMessageId: "om_3", text: "三" }))
    // 第一条已注入并 in-flight，2/3 排队
    assert.equal(injector.injected.length, 1)

    // turn 结束（invocation.finished）清 inflight → drain 下一条
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(injector.injected.length, 2)

    await gw.onInvocationFinished({ assistantMessageId: "am_2", rootMessageId: "um_2" })
    assert.equal(injector.injected.length, 3)

    const texts = injector.injected.map(
      (e) => (e as { payload: { content: string } }).payload.content,
    )
    assert.deepEqual(texts, ["一", "二", "三"])
  })

  it("in-flight 时 onBindingIdle 不注入（turn 未结束）", async () => {
    const injector = makeFakeInjector()
    const { gw } = gatewayWith(injector)
    await gw.handleInbound(msg({ externalMessageId: "om_1" }))
    await gw.handleInbound(msg({ externalMessageId: "om_2" }))
    // om_1 in-flight（未 onInvocationFinished）；onBindingIdle 不清 inflight → 不注入 om_2
    await gw.onBindingIdle("oc_sun")
    assert.equal(injector.injected.length, 1)
  })

  it("重启后 reconcileOnBoot 续 drain 剩余 queued", async () => {
    const injector = makeFakeInjector()
    const { gw, store } = gatewayWith(injector)
    await gw.handleInbound(msg({ externalMessageId: "om_1" }))
    await gw.handleInbound(msg({ externalMessageId: "om_2" }))
    assert.equal(injector.injected.length, 1) // om_2 还在 queued

    // 新实例（inflight 空 = 重启后）reconcile → drain queued
    const injector2 = makeFakeInjector()
    const gw2 = new ChannelGateway({
      db: store,
      injector: injector2,
      sender: {
        async sendText() {
          return { ok: true }
        },
      },
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
      genId: () => "id-y",
      now: () => "2026-07-03T00:02:00.000Z",
    })
    await gw2.reconcileOnBoot()
    // om_2 被新实例 drain 注入
    assert.equal(injector2.injected.length, 1)
    const content = (injector2.injected[0] as { payload: { content: string } }).payload.content
    assert.equal(content, "在吗")
  })
})

describe("T8 注入（AC2）", () => {
  it("注入 payload = send_message + alias 村长 + content 原样", async () => {
    const injector = makeFakeInjector()
    const { gw } = gatewayWith(injector)
    await gw.handleInbound(msg({ text: "帮我 review PR" }))
    const ev = injector.injected[0] as {
      type: string
      payload: { threadId: string; provider: string; content: string; alias: string }
    }
    assert.equal(ev.type, "send_message")
    assert.equal(ev.payload.provider, "claude")
    assert.equal(ev.payload.alias, "村长")
    assert.equal(ev.payload.content, "帮我 review PR")
    assert.equal(ev.payload.threadId, "thread-claude-1")
  })

  it("注入后 root_message_id 回填 = emit 的 user message id，state=injected", async () => {
    const injector = makeFakeInjector()
    const { gw, store } = gatewayWith(injector)
    await gw.handleInbound(msg())
    const row = store.db
      .prepare(
        "SELECT state, root_message_id FROM channel_inbound_ledger WHERE external_message_id = ?",
      )
      .get("om_1") as { state: string; root_message_id: string | null }
    assert.equal(row.state, "injected")
    assert.equal(row.root_message_id, "um_1")
  })

  it("首条白名单 p2p → lazy 创建 binding（D3：env 播种 sessionGroup/provider）", async () => {
    const injector = makeFakeInjector()
    const { gw, store } = gatewayWith(injector)
    await gw.handleInbound(msg())
    const b = store.db
      .prepare("SELECT * FROM channel_bindings WHERE external_chat_id = ?")
      .get("oc_sun") as Record<string, unknown>
    assert.equal(b.session_group_id, "sg-mobile")
    assert.equal(b.default_provider, "claude")
    assert.equal(b.chat_kind, "p2p")
  })
})

describe("P3 AC16 入站附件 → 账本持久化 → send_message.contentBlocks", () => {
  it("attachments 落账本列（JSON）+ 注入带 contentBlocks（image→alt/meta，file→name）", async () => {
    const injector = makeFakeInjector()
    const { gw, store } = gatewayWith(injector)
    await gw.handleInbound(
      msg({
        text: "[图片]",
        attachments: [
          { kind: "image", url: "/uploads/feishu-a.png", name: "照片.png" },
          { kind: "file", url: "/uploads/feishu-b.pdf", name: "周报.pdf" },
        ],
      }),
    )
    const row = store.db
      .prepare("SELECT attachments, state FROM channel_inbound_ledger LIMIT 1")
      .get() as { attachments: string | null; state: string }
    assert.equal(row.state, "injected")
    assert.deepEqual(JSON.parse(row.attachments ?? "[]"), [
      { kind: "image", url: "/uploads/feishu-a.png", name: "照片.png" },
      { kind: "file", url: "/uploads/feishu-b.pdf", name: "周报.pdf" },
    ])
    assert.equal(injector.injected.length, 1)
    const payload = (injector.injected[0] as { payload: Record<string, unknown> }).payload
    assert.deepEqual(payload.contentBlocks, [
      {
        type: "image",
        url: "/uploads/feishu-a.png",
        alt: "照片.png",
        meta: { source: "feishu_inbound" },
      },
      { type: "file", url: "/uploads/feishu-b.pdf", name: "周报.pdf" },
    ])
  })

  it("T7 真机修：配 resolveAttachmentPath → 注入正文附落盘绝对路径（agent 靠它真能看附件）；账本仍存原文", async () => {
    const injector = makeFakeInjector()
    const { gw, store } = gatewayWith(injector, {
      resolveAttachmentPath: (url) =>
        /^\/uploads\/[^/\\]+$/.test(url) ? `C:\\up\\${url.slice("/uploads/".length)}` : null,
    })
    await gw.handleInbound(
      msg({
        text: "[图片]",
        attachments: [
          { kind: "image", url: "/uploads/feishu-a.png", name: "照片.png" },
          { kind: "file", url: "https://evil.example/x.pdf", name: "闸外不附" },
        ],
      }),
    )
    const payload = (injector.injected[0] as { payload: Record<string, unknown> }).payload
    assert.equal(
      payload.content,
      "[图片]\n（图片「照片.png」已存到本地：C:\\up\\feishu-a.png ——可直接读取查看）",
      "闸内附件附路径行；resolver 返 null 的不附",
    )
    // 账本原文纪律：路径是注入时的事，账本存标签原文
    const row = store.db.prepare("SELECT content FROM channel_inbound_ledger LIMIT 1").get() as {
      content: string
    }
    assert.equal(row.content, "[图片]")
  })

  it("无 attachments → contentBlocks 不出现在 payload（纯文本零回归）", async () => {
    const injector = makeFakeInjector()
    const { gw } = gatewayWith(injector)
    await gw.handleInbound(msg())
    const payload = (injector.injected[0] as { payload: Record<string, unknown> }).payload
    assert.ok(!("contentBlocks" in payload))
  })

  it("账本 attachments JSON 破损 → 降级纯文本注入不击穿", async () => {
    const injector = makeFakeInjector()
    const { gw, store } = gatewayWith(injector)
    // 第一条正常注入（建 binding + 占 inflight）
    await gw.handleInbound(msg())
    const bindingId = (
      store.db.prepare("SELECT binding_id FROM channel_inbound_ledger LIMIT 1").get() as {
        binding_id: string
      }
    ).binding_id
    // 手插破损附件 queued 行（drain 下一轮拉它）
    store.db
      .prepare(
        `INSERT INTO channel_inbound_ledger
           (id, connector_id, external_chat_id, external_message_id, binding_id, sender_open_id, content, seq, state, attachments, created_at, updated_at)
         VALUES ('bad1','feishu','oc_sun','om_bad',?,'ou_sun','[图片]',999,'queued','{broken','2026-07-05T02:00:00.000Z','2026-07-05T02:00:00.000Z')`,
      )
      .run(bindingId)
    // turn 结束 → 清 inflight → 续 drain → 拉破损行 → parse 失败降级注入
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    const row = store.db
      .prepare("SELECT state FROM channel_inbound_ledger WHERE id = 'bad1'")
      .get() as { state: string }
    assert.equal(row.state, "injected")
    const last = injector.injected.at(-1) as { payload: Record<string, unknown> }
    assert.equal(last.payload.content, "[图片]")
    assert.ok(!("contentBlocks" in last.payload))
  })
})

describe("P3 AC16 出站媒体（sendMediaSafe：文本 sent 后逐个上传回投）", () => {
  function buildOutbound(opts: { withMedia?: boolean; readFail?: boolean } = {}) {
    dbSeq += 1
    const store = new SqliteStore(path.join(tmpRoot, `db-out-${dbSeq}.sqlite`))
    openStores.push(store)
    const injector = makeFakeInjector()
    const sentTexts: string[] = []
    const sentMedia: Array<{ kind: string; name: string; bytes: number }> = []
    const audits: string[] = []
    const finals = new Map<string, import("./channel-types").FinalMessage>()
    let idc = 0
    let tick = 0
    const gw = new ChannelGateway({
      db: store,
      injector,
      sender: {
        async sendText(_c, text) {
          sentTexts.push(text)
          return { ok: true }
        },
        ...(opts.withMedia !== false
          ? {
              async sendMedia(_c: string, m: { kind: string; name: string; data: Uint8Array }) {
                sentMedia.push({ kind: m.kind, name: m.name, bytes: m.data.byteLength })
                return { ok: true as const }
              },
            }
          : {}),
      },
      readFinalMessage: (id) => finals.get(id) ?? null,
      resolveThread: () => "thread-claude-1",
      readUploadFile: opts.readFail ? () => null : (url) => new Uint8Array([url.length, 1, 2]),
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
      now: () => `2026-07-05T03:00:${String(tick++ % 60).padStart(2, "0")}.000Z`,
      audit: (kind: string) => {
        audits.push(kind)
      },
    })
    return { gw, finals, sentTexts, sentMedia, audits }
  }

  const MEDIA_FINAL = {
    content: "截图在这",
    senderAlias: "黄仁勋",
    createdAt: "2026-07-05T03:00:10.000Z",
    orderSeq: 1,
    model: null,
    mediaBlocks: [
      { kind: "image" as const, url: "/uploads/shot.png", name: "截图.png" },
      { kind: "file" as const, url: "/uploads/report.pdf", name: "报告.pdf" },
    ],
  }

  it("终稿带 mediaBlocks → 文本 sent 后逐个 sendMedia（bytes 来自 readUploadFile）", async () => {
    const { gw, finals, sentTexts, sentMedia } = buildOutbound()
    await gw.handleInbound(msg())
    finals.set("am_1", MEDIA_FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.deepEqual(sentTexts, ["截图在这"])
    assert.deepEqual(sentMedia, [
      { kind: "image", name: "截图.png", bytes: 3 },
      { kind: "file", name: "报告.pdf", bytes: 3 },
    ])
  })

  it("readUploadFile 返回 null（文件被清）→ audit + 跳过，不影响文本 sent", async () => {
    const { gw, finals, sentTexts, sentMedia, audits } = buildOutbound({ readFail: true })
    await gw.handleInbound(msg())
    finals.set("am_1", MEDIA_FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sentTexts.length, 1)
    assert.equal(sentMedia.length, 0)
    assert.ok(audits.filter((a) => a === "outbound-media-read-failed").length === 2)
  })

  it("渠道不支持 sendMedia（最小 fake）→ 零行为不炸", async () => {
    const { gw, finals, sentTexts, sentMedia } = buildOutbound({ withMedia: false })
    await gw.handleInbound(msg())
    finals.set("am_1", MEDIA_FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sentTexts.length, 1)
    assert.equal(sentMedia.length, 0)
  })

  it("终稿无 mediaBlocks → 零媒体调用（纯文本零回归）", async () => {
    const { gw, finals, sentMedia } = buildOutbound()
    await gw.handleInbound(msg())
    finals.set("am_1", { ...MEDIA_FINAL, mediaBlocks: undefined })
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sentMedia.length, 0)
  })
})
