import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../db/sqlite"
import { ChannelGateway } from "./channel-gateway"
import type { ChannelSender, FinalMessage, InboundChannelMessage } from "./channel-types"

/**
 * F040 P3 T2（AC15）：占位卡状态机 sent→replaced|failed|expired。
 * 真临时 SQLite（placeholder 列是账本真列）+ fake sender 记录三个能力面的调用。
 * 关键面：发卡 fire-and-forget 不阻断主链 / claimAndSend CAS 认领+失败回滚 /
 * 空手 turn 收尾 / sweeper 超时 / optional 渠道零行为 / 命令面不发卡。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-placeholder-"))
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
  let counter = 0
  return {
    handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void) {
      counter += 1
      emit({
        type: "message.created",
        payload: {
          threadId: (event as { payload: { threadId: string } }).payload.threadId,
          sessionGroupId: "sg-mobile",
          message: { id: `um_${counter}`, role: "user" } as unknown,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => null,
  }
}

type SentRecord = {
  chatId: string
  text: string
  replacePlaceholder?: string
}

function makeSender(
  opts: {
    withPlaceholder?: boolean
    placeholderFail?: boolean
    sendTextFailOnce?: boolean
    /** P1-2：失败但报告占位卡已被 PATCH 消费（长文本首片变身后余片失败） */
    sendTextFailConsumedOnce?: boolean
  } = {},
) {
  const sent: SentRecord[] = []
  const placeholderCalls: string[] = []
  const patchCalls: Array<{ messageId: string; text: string }> = []
  let phSeq = 0
  let failedOnce = false
  const base: ChannelSender = {
    async sendText(chatId, text, o) {
      if (opts.sendTextFailOnce && !failedOnce) {
        failedOnce = true
        return { ok: false, error: "boom", terminal: false }
      }
      if (opts.sendTextFailConsumedOnce && !failedOnce) {
        failedOnce = true
        return { ok: false, error: "tail boom", terminal: false, placeholderConsumed: true }
      }
      sent.push({ chatId, text, replacePlaceholder: o?.replacePlaceholder })
      return { ok: true }
    },
  }
  if (opts.withPlaceholder !== false) {
    base.sendPlaceholder = async (chatId) => {
      placeholderCalls.push(chatId)
      if (opts.placeholderFail) return { ok: false, error: "ph boom" }
      phSeq += 1
      return { ok: true, messageId: `ph_${phSeq}` }
    }
    base.patchCard = async (messageId, o) => {
      patchCalls.push({ messageId, text: o.text })
      return { ok: true }
    }
  }
  return { sender: base, sent, placeholderCalls, patchCalls }
}

function build(senderOpts: Parameters<typeof makeSender>[0] = {}) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  const { sender, sent, placeholderCalls, patchCalls } = makeSender(senderOpts)
  const finals = new Map<string, FinalMessage>()
  const audits: Array<{ kind: string }> = []
  let idc = 0
  let tick = 0
  const gw = new ChannelGateway({
    db: store,
    injector: makeFakeInjector(),
    sender,
    readFinalMessage: (id) => finals.get(id) ?? null,
    resolveThread: () => "thread-claude-1",
    config: () => ({
      connectorId: "feishu",
      allowedOpenIds: ["ou_sun"],
      bindSessionGroup: "sg-mobile",
      defaultProvider: "claude",
      allowedGroupChats: [],
      groupMembers: {},
      groupBindings: {},
    }),
    commands: {
      async execute() {
        return "收到命令"
      },
    },
    genId: () => `id-${++idc}`,
    now: () => `2026-07-05T01:00:${String(tick++ % 60).padStart(2, "0")}.000Z`,
    audit: (kind: string) => {
      audits.push({ kind })
    },
  })
  return { gw, store, sent, placeholderCalls, patchCalls, finals, audits }
}

function msg(o: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "p2p_sun",
    externalMessageId: `om_${Math.floor(Math.random() * 1e9)}`,
    senderOpenId: "ou_sun",
    chatKind: "p2p",
    text: "帮我看看这个",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

/** 发卡是 fire-and-forget（void 调用）——断言前 flush 微任务/宏任务队列 */
async function flush() {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

function phRow(store: SqliteStore) {
  return store.db
    .prepare(
      `SELECT id, state, root_message_id, placeholder_message_id, placeholder_state
         FROM channel_inbound_ledger ORDER BY seq DESC LIMIT 1`,
    )
    .get() as {
    id: string
    state: string
    root_message_id: string | null
    placeholder_message_id: string | null
    placeholder_state: string | null
  }
}

const FINAL: FinalMessage = {
  content: "答复来了",
  senderAlias: "黄仁勋",
  createdAt: "2026-07-05T01:00:10.000Z",
  orderSeq: 1,
  model: "claude-opus-4-8",
}

describe("T2 占位卡状态机（AC15）", () => {
  it("注入成功 → 占位卡发出 + 账本 sent；终稿 → sendText 带 replacePlaceholder + 标 replaced", async () => {
    const { gw, store, sent, placeholderCalls, finals } = build()
    // handleInbound 恒返 "queued"（排队登记语义）；注入结果看账本 state
    await gw.handleInbound(msg())
    await flush()
    assert.deepEqual(placeholderCalls, ["p2p_sun"])
    const row1 = phRow(store)
    assert.equal(row1.state, "injected")
    assert.equal(row1.placeholder_message_id, "ph_1")
    assert.equal(row1.placeholder_state, "sent")

    finals.set("am_1", FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].replacePlaceholder, "ph_1")
    assert.equal(phRow(store).placeholder_state, "replaced")
  })

  it("同 root 第二条终稿 → 不再带 replacePlaceholder（占位卡只变身一次）", async () => {
    const { gw, store, sent, finals } = build()
    await gw.handleInbound(msg())
    await flush()
    finals.set("am_1", FINAL)
    finals.set("am_2", { ...FINAL, content: "第二条", orderSeq: 2 })
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    await gw.onInvocationFinished({ assistantMessageId: "am_2", rootMessageId: "um_1" })
    assert.equal(sent.length, 2)
    assert.equal(sent[0].replacePlaceholder, "ph_1")
    assert.equal(sent[1].replacePlaceholder, undefined)
    assert.equal(phRow(store).placeholder_state, "replaced")
  })

  it("发送失败（非终态）→ 占位卡认领回滚回 sent（reconcile 重投时再变身）", async () => {
    const { gw, store, finals } = build({ sendTextFailOnce: true })
    await gw.handleInbound(msg())
    await flush()
    finals.set("am_1", FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    // 第一次 sendText 失败 → 出站行留 attempted、占位卡回滚 'sent'
    assert.equal(phRow(store).placeholder_state, "sent")
  })

  it("P1-2 回归：失败但 placeholderConsumed → 认领不回滚（保持 replaced，sweeper 不毁已变身卡）", async () => {
    const { gw, store, finals } = build({ sendTextFailConsumedOnce: true })
    await gw.handleInbound(msg())
    await flush()
    finals.set("am_1", FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    // 首片已 PATCH 变身（占位卡在飞书侧已是终稿首片）——回滚会让 sweeper 15min 后毁内容
    assert.equal(phRow(store).placeholder_state, "replaced")
    // 把时钟拨旧跑 sweeper：replaced 不在打扫范围，卡不被 PATCH 成超时文案
    store.db
      .prepare(`UPDATE channel_inbound_ledger SET updated_at = '2026-07-05T00:00:00.000Z'`)
      .run()
    await gw.sweepPlaceholders()
    assert.equal(phRow(store).placeholder_state, "replaced")
  })

  it("P1-1 回归：生产成功路径空终稿（有 assistantMessageId、content 全空白）→ 占位卡同套收尾标 failed", async () => {
    const { gw, store, sent, patchCalls, finals } = build()
    await gw.handleInbound(msg())
    await flush()
    // exit 0 但空输出：final 存在、content 只有空白——deliverFinal 空内容分支是唯一出口
    finals.set("am_1", { ...FINAL, content: "   " })
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sent.length, 0, "空终稿不投递")
    assert.equal(patchCalls.length, 1)
    assert.match(patchCalls[0].text, /没有产出回复/)
    assert.equal(phRow(store).placeholder_state, "failed")
  })

  it("failed 空手 turn（无终稿、root 零出站行）→ patchCard 失败文案 + 标 failed", async () => {
    const { gw, store, patchCalls } = build()
    await gw.handleInbound(msg())
    await flush()
    await gw.onInvocationFinished({ assistantMessageId: null, rootMessageId: "um_1" })
    assert.equal(patchCalls.length, 1)
    assert.equal(patchCalls[0].messageId, "ph_1")
    assert.match(patchCalls[0].text, /没有产出回复/)
    assert.equal(phRow(store).placeholder_state, "failed")
  })

  it("failed 但 root 已有出站行（终稿已投）→ 占位卡不动（保持 replaced）", async () => {
    const { gw, store, patchCalls, finals } = build()
    await gw.handleInbound(msg())
    await flush()
    finals.set("am_1", FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    await gw.onInvocationFinished({ assistantMessageId: null, rootMessageId: "um_1" })
    assert.equal(patchCalls.length, 0)
    assert.equal(phRow(store).placeholder_state, "replaced")
  })

  it("渠道不支持占位卡（最小 fake）→ 零行为不炸，终稿正常 POST", async () => {
    const { gw, store, sent, finals } = build({ withPlaceholder: false })
    await gw.handleInbound(msg())
    await flush()
    const row = phRow(store)
    assert.equal(row.placeholder_message_id, null)
    assert.equal(row.placeholder_state, null)
    finals.set("am_1", FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].replacePlaceholder, undefined)
  })

  it("发卡失败 → 审计 + 字段留 NULL + 终稿正常 POST（占位卡绝不反向影响主链）", async () => {
    const { gw, store, sent, finals, audits } = build({ placeholderFail: true })
    await gw.handleInbound(msg())
    await flush()
    const row = phRow(store)
    assert.equal(row.state, "injected", "发卡失败不影响注入主链")
    assert.equal(row.placeholder_message_id, null)
    assert.equal(row.placeholder_state, null)
    assert.ok(audits.some((a) => a.kind === "placeholder-send-failed"))
    finals.set("am_1", FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].replacePlaceholder, undefined)
  })

  it("sweepPlaceholders：sent 超 15min → patchCard 超时文案 + expired；迟到终稿正常 POST", async () => {
    const { gw, store, sent, patchCalls, finals } = build()
    await gw.handleInbound(msg())
    await flush()
    // 把发卡时刻拨回 1 小时前（now fake 秒级递增，直接改库最直接）
    store.db
      .prepare(
        `UPDATE channel_inbound_ledger SET updated_at = '2026-07-05T00:00:00.000Z'
          WHERE placeholder_state = 'sent'`,
      )
      .run()
    await gw.sweepPlaceholders()
    assert.equal(patchCalls.length, 1)
    assert.match(patchCalls[0].text, /超时/)
    assert.equal(phRow(store).placeholder_state, "expired")
    // 迟到终稿：占位卡已 expired → 不带 replacePlaceholder，内容不丢
    finals.set("am_1", FINAL)
    await gw.onInvocationFinished({ assistantMessageId: "am_1", rootMessageId: "um_1" })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].replacePlaceholder, undefined)
  })

  it("sweepPlaceholders：未超时的 sent 不动", async () => {
    const { gw, store, patchCalls } = build()
    await gw.handleInbound(msg())
    await flush()
    await gw.sweepPlaceholders()
    assert.equal(patchCalls.length, 0)
    assert.equal(phRow(store).placeholder_state, "sent")
  })

  it("命令消息（门后旁路）→ 不注入不发卡", async () => {
    const { gw, placeholderCalls } = build()
    const r = await gw.handleInbound(msg({ text: "/help" }))
    assert.equal(r, "command_handled")
    await flush()
    assert.equal(placeholderCalls.length, 0)
  })
})
