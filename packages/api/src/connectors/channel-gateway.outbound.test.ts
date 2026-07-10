import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { ChannelGateway } from "./channel-gateway"
import type { ChannelSender, InboundChannelMessage } from "./channel-types"

/** F040 T10：出站 hook + D15 溯源 + D11 账本状态机（onInvocationFinished）。 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-outbound-"))
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
  let busy = false
  return {
    injected,
    setBusy(v: boolean) {
      busy = v
    },
    lastRoot: "",
    handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void) {
      injected.push(event)
      busy = true
      counter += 1
      this.lastRoot = `um_${counter}`
      emit({
        type: "message.created",
        payload: {
          threadId: (event as { payload: { threadId: string } }).payload.threadId,
          sessionGroupId: "sg-mobile",
          // biome-ignore lint/suspicious/noExplicitAny: fake timeline message
          message: { id: `um_${counter}`, role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => (busy ? "运行中" : null),
  }
}

function makeFakeSender() {
  const sent: Array<{
    chatId: string
    text: string
    senderAlias: string | null
    model: string | null
  }> = []
  let mode: "ok" | "retry" | "terminal" = "ok"
  const sender: ChannelSender = {
    async sendText(externalChatId, text, opts) {
      if (mode === "ok") {
        sent.push({
          chatId: externalChatId,
          text,
          senderAlias: opts?.senderAlias ?? null,
          model: opts?.model ?? null,
        })
        return { ok: true }
      }
      if (mode === "retry") return { ok: false, error: "429 rate", terminal: false }
      return { ok: false, error: "403 forbidden", terminal: true }
    },
  }
  return {
    sent,
    sender,
    setMode(m: "ok" | "retry" | "terminal") {
      mode = m
    },
  }
}

function build(finals: Record<string, string>) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  const injector = makeFakeInjector()
  const s = makeFakeSender()
  let idc = 0
  let tick = 0
  const gw = new ChannelGateway({
    db: store,
    injector,
    sender: s.sender,
    // 契约升级：终稿带署名（senderAlias）+ 型号（model，AC-N4），fake 统一署 黄仁勋
    readFinalMessage: (id) =>
      finals[id] === undefined
        ? null
        : {
            content: finals[id],
            senderAlias: "黄仁勋",
            createdAt: "2026-07-04T00:00:00.000Z",
            orderSeq: null,
            model: "claude-opus-4-8",
          },
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
  return { gw, store, injector, sender: s }
}

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

function finished(assistantMessageId: string, rootMessageId: string | null) {
  return {
    invocationId: "inv",
    threadId: "thread-claude-1",
    agentId: "黄仁勋",
    exitCode: 0,
    assistantMessageId,
    rootMessageId,
  }
}

describe("T10 出站 hook（AC3/D15/D11）", () => {
  it("injected root 的 final → 投递 + 账本 pending→attempted→sent", async () => {
    const { gw, store, sender } = build({ am_1: "这是回复" })
    await gw.handleInbound(msg())
    await gw.onInvocationFinished(finished("am_1", "um_1"))
    assert.deepEqual(sender.sent, [
      { chatId: "oc_sun", text: "这是回复", senderAlias: "黄仁勋", model: "claude-opus-4-8" },
    ])
    const row = store.db
      .prepare("SELECT state FROM channel_outbound_ledger WHERE internal_message_id = ?")
      .get("am_1") as { state: string }
    assert.equal(row.state, "sent")
  })

  it("rootMessageId=null 的 final → 不投（D15：无外部来源）", async () => {
    const { gw, sender } = build({ am_1: "后台产物" })
    await gw.onInvocationFinished(finished("am_1", null))
    assert.equal(sender.sent.length, 0)
  })

  it("root 查不到 injected 行（web 发起）→ 不投", async () => {
    const { gw, sender } = build({ am_1: "web 回复" })
    await gw.onInvocationFinished(finished("am_1", "um_web_only"))
    assert.equal(sender.sent.length, 0)
  })

  it("同 final 二次事件 → 不重复投（UNIQUE 幂等）", async () => {
    const { gw, sender } = build({ am_1: "回复" })
    await gw.handleInbound(msg())
    await gw.onInvocationFinished(finished("am_1", "um_1"))
    await gw.onInvocationFinished(finished("am_1", "um_1"))
    assert.equal(sender.sent.length, 1)
  })

  it("空 content → 跳过不投（AC3 防空消息）", async () => {
    const { gw, sender } = build({ am_1: "" })
    await gw.handleInbound(msg())
    await gw.onInvocationFinished(finished("am_1", "um_1"))
    assert.equal(sender.sent.length, 0)
  })

  it("sender 非 terminal 失败 → 留 attempted（reconcile 补）", async () => {
    const { gw, store, sender } = build({ am_1: "回复" })
    await gw.handleInbound(msg())
    sender.setMode("retry")
    await gw.onInvocationFinished(finished("am_1", "um_1"))
    const row = store.db
      .prepare("SELECT state, attempts FROM channel_outbound_ledger WHERE internal_message_id = ?")
      .get("am_1") as { state: string; attempts: number }
    assert.equal(row.state, "attempted")
    assert.equal(row.attempts, 1)
  })

  it("sender terminal 失败 → failed_terminal", async () => {
    const { gw, store, sender } = build({ am_1: "回复" })
    await gw.handleInbound(msg())
    sender.setMode("terminal")
    await gw.onInvocationFinished(finished("am_1", "um_1"))
    const row = store.db
      .prepare("SELECT state FROM channel_outbound_ledger WHERE internal_message_id = ?")
      .get("am_1") as { state: string }
    assert.equal(row.state, "failed_terminal")
  })

  it("A2A：同 root 两个 invocation（两 final）各投一条（AC3 multi-final）", async () => {
    const { gw, sender } = build({ am_huang: "黄仁勋的回复", am_fan: "范德彪的回复" })
    await gw.handleInbound(msg())
    await gw.onInvocationFinished(finished("am_huang", "um_1"))
    await gw.onInvocationFinished(finished("am_fan", "um_1"))
    assert.equal(sender.sent.length, 2)
    assert.deepEqual(
      sender.sent.map((s) => s.text),
      ["黄仁勋的回复", "范德彪的回复"],
    )
  })

  it("r2 P1-new：deliverFinal 抛异常 → inflight 仍被清，后续队列不永久卡死", async () => {
    // 真实 sender 可能 throw（getToken HTTP/解析错不在 try 内）；throw 不能把 binding 卡死
    dbSeq += 1
    const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
    openStores.push(store)
    const injector = makeFakeInjector()
    const throwMode = true
    const sender: ChannelSender = {
      async sendText(chatId, text) {
        if (throwMode) throw new Error("getToken exploded")
        return { ok: true }
      },
    }
    let idc = 0
    let tick = 0
    const audits: string[] = []
    const gw = new ChannelGateway({
      db: store,
      injector,
      sender,
      readFinalMessage: () => ({ content: "回复", senderAlias: null, createdAt: "2026-07-04T00:00:00.000Z", orderSeq: null }),
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
      audit: (e) => audits.push(e),
    })
    // 两条消息：第一条注入 in-flight，第二条排队
    await gw.handleInbound(msg({ externalMessageId: "om_1", text: "一" }))
    await gw.handleInbound(msg({ externalMessageId: "om_2", text: "二" }))
    assert.equal(injector.injected.length, 1)

    // 第一条 turn 结束：deliverFinal 内 sender THROW
    injector.setBusy(false)
    await gw.onInvocationFinished(finished("am_1", "um_1")) // 不得向上抛
    // inflight 必须已清 → 第二条被 drain 注入（不永久卡队）
    assert.equal(injector.injected.length, 2, "sender throw 后第二条仍应 drain")
    assert.ok(
      audits.some((a) => a.includes("outbound-deliver-error")),
      "出站异常应有审计",
    )
  })

  it("错误终态 final（invocation.failed）→ 同路径投递回执（AC3 错误回执 / guardian 残余3）", async () => {
    // connector 对 invocation.finished 与 invocation.failed 同一订阅 onInvocationFinished；
    // failed 事件带错误占位 assistantMessageId + root，readFinalMessage 读到错误终稿 → 投回执。
    // continuation-final 是同 root 的又一个 finished，机制同上「A2A multi-final」已测。
    const { gw, sender } = build({ am_err: "抱歉，处理出错了：provider timeout" })
    await gw.handleInbound(msg())
    await gw.onInvocationFinished(finished("am_err", "um_1"))
    assert.deepEqual(sender.sent, [
      {
        chatId: "oc_sun",
        text: "抱歉，处理出错了：provider timeout",
        senderAlias: "黄仁勋",
        model: "claude-opus-4-8",
      },
    ])
  })

  it("署名+型号透传：readFinalMessage 的 senderAlias/model 原样递给 sender（AC-N4 卡片可见性）", async () => {
    const { gw, sender } = build({ am_1: "在。需要我做什么？" })
    await gw.handleInbound(msg())
    await gw.onInvocationFinished(finished("am_1", "um_1"))
    assert.equal(sender.sent.length, 1)
    assert.equal(sender.sent[0].senderAlias, "黄仁勋")
    assert.equal(sender.sent[0].model, "claude-opus-4-8")
  })
})
