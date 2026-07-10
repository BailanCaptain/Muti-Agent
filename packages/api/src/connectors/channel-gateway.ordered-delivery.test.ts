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
 * F040 Phase 2 T14：AC13.5 顺序投递（设计 v2 德彪 r2 GO）。
 * held_order 状态 + 双腿判定（Leg A 账本自持 / Leg B live dep）+ 四放行路径统一
 * canReleaseOrdered + CAS claim + hold_since 计时 sweeper + 非阻塞 hold。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-ordered-"))
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

type FinalMeta = { content: string; createdAt: string | null; orderSeq?: number | null }

function build(finals: Record<string, FinalMeta>) {
  dbSeq += 1
  const store = new SqliteStore(path.join(tmpRoot, `db-${dbSeq}.sqlite`))
  openStores.push(store)
  let counter = 0
  const injected: string[] = []
  const injector = {
    handleClientEvent(e: RealtimeClientEvent, emit: (x: RealtimeServerEvent) => void) {
      injected.push((e as { payload: { content: string } }).payload.content)
      counter += 1
      emit({
        type: "message.created",
        payload: {
          threadId: "thread-claude-1",
          sessionGroupId: "sg-mobile",
          // biome-ignore lint/suspicious/noExplicitAny: fake
          message: { id: `um_${counter}`, role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => null,
  }
  const sent: Array<{ chatId: string; text: string }> = []
  const outcomes: Array<"ok" | "retry" | "terminal"> = []
  const sender: ChannelSender = {
    async sendText(chatId, text) {
      const mode = outcomes.shift() ?? "ok"
      if (mode === "ok") {
        sent.push({ chatId, text })
        return { ok: true }
      }
      if (mode === "retry") return { ok: false, error: "429", terminal: false }
      return { ok: false, error: "403", terminal: true }
    },
  }
  const audits: Array<{ event: string; meta: Record<string, unknown> }> = []
  // Leg B live 状态：root → 「有更早 created 的在飞 turn」；legBCalls 记录 exclude 透传
  const runningByRoot = new Map<string, boolean>()
  const legBCalls: Array<{ root: string; exclude: string | undefined }> = []
  let nowMs = Date.parse("2026-07-04T00:00:00.000Z")
  let idc = 0
  const gw = new ChannelGateway({
    db: store,
    injector,
    sender,
    readFinalMessage: (id) =>
      finals[id] === undefined
        ? null
        : {
            content: finals[id].content,
            senderAlias: null,
            createdAt: finals[id].createdAt,
            orderSeq: finals[id].orderSeq ?? null,
          },
    resolveThread: () => "thread-claude-1",
    hasEarlierRunningTurn: (root, _before, exclude) => {
      legBCalls.push({ root, exclude })
      return runningByRoot.get(root) ?? false
    },
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
    now: () => new Date(nowMs).toISOString(),
    audit: (event, meta) => audits.push({ event, meta }),
  })
  return {
    gw,
    store,
    sent,
    audits,
    injected,
    outcomes,
    runningByRoot,
    legBCalls,
    advance(ms: number) {
      nowMs += ms
    },
  }
}

function msg(o: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    connectorId: "feishu",
    externalChatId: "oc_sun",
    externalMessageId: `om_${Math.random().toString(36).slice(2)}`,
    senderOpenId: "ou_sun",
    chatKind: "p2p",
    text: "在吗",
    mentionsBot: true,
    senderName: null,
    ...o,
  }
}

const T1 = "2026-07-04T00:00:01.000Z" // 仁勋起笔（早）
const T2 = "2026-07-04T00:00:20.000Z" // 德彪起笔（晚）

describe("T14 顺序投递（AC13.5）", () => {
  it("Leg B：晚起笔 final 先完成 → held_order；早起笔完成后按序补投（[早, 晚]）", async () => {
    const f = build({
      am_early: { content: "仁勋的话", createdAt: T1 },
      am_late: { content: "德彪的话", createdAt: T2 },
    })
    await f.gw.handleInbound(msg())
    f.runningByRoot.set("um_1", true) // 仁勋还在跑
    await f.gw.onInvocationFinished({ assistantMessageId: "am_late", rootMessageId: "um_1" })
    assert.equal(f.sent.length, 0, "德彪必须 hold")
    const held = f.store.db
      .prepare("SELECT state, hold_since FROM channel_outbound_ledger WHERE internal_message_id='am_late'")
      .get() as { state: string; hold_since: string | null }
    assert.equal(held.state, "held_order")
    assert.ok(held.hold_since, "必须记 hold_since（sweeper 计时基准）")

    f.runningByRoot.set("um_1", false) // 仁勋 turn 结束
    await f.gw.onInvocationFinished({ assistantMessageId: "am_early", rootMessageId: "um_1" })
    assert.deepEqual(
      f.sent.map((s) => s.text),
      ["仁勋的话", "德彪的话"],
      "严格按房间起笔序",
    )
  })

  it("P2-2 同毫秒平局：Leg A 按 orderSeq(rowid) 判序 —— 同 createdAt 晚 rowid held、按 [小,大] 序补投", async () => {
    // 德彪 P2 审 r1 P2-2：房间列表按 (created_at, rowid) 排；顺序门必须同键，
    // 否则同毫秒双 final 退化成完成序。
    const f = build({
      am_a: { content: "先起笔(rowid小)", createdAt: T1, orderSeq: 100 },
      am_b: { content: "后起笔(rowid大)", createdAt: T1, orderSeq: 101 },
    })
    await f.gw.handleInbound(msg())
    f.outcomes.push("retry") // A 首投非终态滞留（attempted 留账本，order_seq=100）
    await f.gw.onInvocationFinished({ assistantMessageId: "am_a", rootMessageId: "um_1" })
    await f.gw.onInvocationFinished({ assistantMessageId: "am_b", rootMessageId: "um_1" })
    assert.equal(f.sent.length, 0)
    const b = f.store.db
      .prepare(
        "SELECT state, message_order_seq FROM channel_outbound_ledger WHERE internal_message_id='am_b'",
      )
      .get() as { state: string; message_order_seq: number | null }
    assert.equal(b.state, "held_order", "同毫秒但 rowid 更大 → 必须 hold（created_at-only 会漏）")
    assert.equal(b.message_order_seq, 101, "tie 键落账")

    await f.gw.reconcileOnBoot()
    assert.deepEqual(
      f.sent.map((s) => s.text),
      ["先起笔(rowid小)", "后起笔(rowid大)"],
      "同毫秒按 rowid 序补投",
    )
  })

  it("P2-2 平局反向：同毫秒 rowid 更小的后到 final 不被大 rowid 阻塞（船已开语义不倒灌）", async () => {
    const f = build({
      am_a: { content: "rowid小后到", createdAt: T1, orderSeq: 100 },
      am_b: { content: "rowid大先到", createdAt: T1, orderSeq: 101 },
    })
    await f.gw.handleInbound(msg())
    await f.gw.onInvocationFinished({ assistantMessageId: "am_b", rootMessageId: "um_1" }) // B 先完成先投出（A 未注册无从阻）
    await f.gw.onInvocationFinished({ assistantMessageId: "am_a", rootMessageId: "um_1" })
    assert.deepEqual(
      f.sent.map((s) => s.text),
      ["rowid大先到", "rowid小后到"],
      "B 已 sent（终态）不构成阻塞源；A 照常放行不死锁",
    )
  })

  it("P2-2 Leg B 自排除：gateway 把 finished 的 invocationId 透传给 hasEarlierRunningTurn", async () => {
    const f = build({ am_x: { content: "x", createdAt: T1, orderSeq: 7 } })
    await f.gw.handleInbound(msg())
    await f.gw.onInvocationFinished({
      assistantMessageId: "am_x",
      rootMessageId: "um_1",
      invocationId: "inv-self-1",
    })
    assert.ok(
      f.legBCalls.some((c) => c.root === "um_1" && c.exclude === "inv-self-1"),
      "excludeInvocationId 必须到达 Leg B 判定（自排除防自锁 60s）",
    )
  })

  it("Leg A：早 final 非终态滞留（attempted）→ 晚 final held；reconcile 按序补投", async () => {
    const f = build({
      am_early: { content: "早的", createdAt: T1 },
      am_late: { content: "晚的", createdAt: T2 },
    })
    await f.gw.handleInbound(msg())
    f.outcomes.push("retry") // 早 final 首投失败（非终态 → attempted 滞留）
    await f.gw.onInvocationFinished({ assistantMessageId: "am_early", rootMessageId: "um_1" })
    await f.gw.onInvocationFinished({ assistantMessageId: "am_late", rootMessageId: "um_1" })
    assert.equal(f.sent.length, 0)
    const late = f.store.db
      .prepare("SELECT state FROM channel_outbound_ledger WHERE internal_message_id='am_late'")
      .get() as { state: string }
    assert.equal(late.state, "held_order", "Leg A：账本里有更早非终态行 → hold")

    await f.gw.reconcileOnBoot()
    assert.deepEqual(
      f.sent.map((s) => s.text),
      ["早的", "晚的"],
      "reconcile 同过顺序门，按序补投",
    )
  })

  it("failed 前序不阻塞：早 final 终态失败 → 晚 final 放行", async () => {
    const f = build({
      am_early: { content: "早的", createdAt: T1 },
      am_late: { content: "晚的", createdAt: T2 },
    })
    await f.gw.handleInbound(msg())
    f.outcomes.push("terminal") // 早 final 终态拒
    await f.gw.onInvocationFinished({ assistantMessageId: "am_early", rootMessageId: "um_1" })
    await f.gw.onInvocationFinished({ assistantMessageId: "am_late", rootMessageId: "um_1" })
    assert.deepEqual(
      f.sent.map((s) => s.text),
      ["晚的"],
      "前序 failed_terminal 不是阻塞源",
    )
  })

  it("sweeper：hold 超 60s 强制放行 + out-of-order-forced 审计带定位字段", async () => {
    const f = build({ am_late: { content: "被卡的", createdAt: T2 } })
    await f.gw.handleInbound(msg())
    f.runningByRoot.set("um_1", true)
    await f.gw.onInvocationFinished({ assistantMessageId: "am_late", rootMessageId: "um_1" })
    assert.equal(f.sent.length, 0)

    f.advance(61_000)
    await f.gw.sweepHeldOrders()
    assert.deepEqual(
      f.sent.map((s) => s.text),
      ["被卡的"],
      "超时必须强制放行（卡死 agent 不饿死投递）",
    )
    const forced = f.audits.find((a) => a.event === "out-of-order-forced")
    assert.ok(forced, "必须审计强制乱序")
    assert.equal(forced?.meta.rootMessageId, "um_1")
    assert.ok(forced?.meta.bindingId)
    assert.equal(forced?.meta.forcedMessageId, "am_late")
    assert.equal(forced?.meta.forcedCreatedAt, T2)
    assert.ok((forced?.meta.holdAgeMs as number) >= 60_000)
    assert.equal(forced?.meta.forceAfterMs, 60_000)
  })

  it("sweeper 临界区：blocker 已清 → 正常放行，不打 forced 标", async () => {
    const f = build({ am_late: { content: "其实能走了", createdAt: T2 } })
    await f.gw.handleInbound(msg())
    f.runningByRoot.set("um_1", true)
    await f.gw.onInvocationFinished({ assistantMessageId: "am_late", rootMessageId: "um_1" })
    f.runningByRoot.set("um_1", false) // sweep 前 blocker 清除
    f.advance(61_000)
    await f.gw.sweepHeldOrders()
    assert.equal(f.sent.length, 1)
    assert.equal(
      f.audits.some((a) => a.event === "out-of-order-forced"),
      false,
      "正常可放行不得打 forced 标",
    )
  })

  it("重启保序：held_order 行过 reconcile 顺序门（前序 pending 先投，held 随后）", async () => {
    const f = build({
      am_early: { content: "早的", createdAt: T1 },
      am_late: { content: "晚的", createdAt: T2 },
    })
    await f.gw.handleInbound(msg())
    // 直接 seed 崩溃前状态：早=pending（已登记未投），晚=held_order
    const b = f.store.db
      .prepare("SELECT id FROM channel_bindings LIMIT 1")
      .get() as { id: string }
    f.store.db
      .prepare(
        `INSERT INTO channel_outbound_ledger (id, binding_id, internal_message_id, state, attempts, possible_duplicate, created_at, updated_at, root_message_id, message_created_at, hold_since)
         VALUES ('o-early', ?, 'am_early', 'pending', 0, 0, '2026-07-04T00:00:02.000Z', '2026-07-04T00:00:02.000Z', 'um_1', ?, NULL),
                ('o-late', ?, 'am_late', 'held_order', 0, 0, '2026-07-04T00:00:21.000Z', '2026-07-04T00:00:21.000Z', 'um_1', ?, '2026-07-04T00:00:21.000Z')`,
      )
      .run(b.id, T1, b.id, T2)
    await f.gw.reconcileOnBoot()
    assert.deepEqual(
      f.sent.map((s) => s.text),
      ["早的", "晚的"],
      "重启后顺序门不失效（r1 P1-1 核心场景）",
    )
  })

  it("NULL legacy 行不阻塞新行、自身按 AC8 原语义补投", async () => {
    const f = build({
      am_legacy: { content: "老行", createdAt: null },
      am_new: { content: "新行", createdAt: T2 },
    })
    await f.gw.handleInbound(msg())
    const b = f.store.db.prepare("SELECT id FROM channel_bindings LIMIT 1").get() as { id: string }
    f.store.db
      .prepare(
        `INSERT INTO channel_outbound_ledger (id, binding_id, internal_message_id, state, attempts, possible_duplicate, created_at, updated_at, root_message_id, message_created_at, hold_since)
         VALUES ('o-legacy', ?, 'am_legacy', 'pending', 0, 0, '2026-07-04T00:00:01.000Z', '2026-07-04T00:00:01.000Z', 'um_1', NULL, NULL)`,
      )
      .run(b.id)
    // 新 final 到达：NULL 行不算阻塞源 → 直接投
    await f.gw.onInvocationFinished({ assistantMessageId: "am_new", rootMessageId: "um_1" })
    assert.deepEqual(f.sent.map((s) => s.text), ["新行"])
    // legacy 行自身照旧 reconcile
    await f.gw.reconcileOnBoot()
    assert.deepEqual(f.sent.map((s) => s.text), ["新行", "老行"])
  })

  it("跨 root 不互等：root A 被卡不影响 root B 投递", async () => {
    const f = build({
      am_a: { content: "A 的", createdAt: T2 },
      am_b: { content: "B 的", createdAt: T2 },
    })
    await f.gw.handleInbound(msg({ externalMessageId: "om_a" }))
    await f.gw.onInvocationFinished({ assistantMessageId: "am_hold", rootMessageId: "um_1" }) // 清 inflight
    await f.gw.handleInbound(msg({ externalMessageId: "om_b" }))
    f.runningByRoot.set("um_1", true) // root A 有在飞
    await f.gw.onInvocationFinished({ assistantMessageId: "am_a", rootMessageId: "um_1" })
    await f.gw.onInvocationFinished({ assistantMessageId: "am_b", rootMessageId: "um_2" })
    assert.deepEqual(f.sent.map((s) => s.text), ["B 的"], "B 不等 A")
  })

  it("非阻塞 hold：held 之后同 binding 下一条用户消息照常 drain（inflight 已清）", async () => {
    const f = build({ am_late: { content: "held 的", createdAt: T2 } })
    await f.gw.handleInbound(msg({ externalMessageId: "om_1", text: "一" }))
    f.runningByRoot.set("um_1", true)
    await f.gw.onInvocationFinished({ assistantMessageId: "am_late", rootMessageId: "um_1" })
    assert.equal(f.sent.length, 0, "held 不投")
    await f.gw.handleInbound(msg({ externalMessageId: "om_2", text: "二" }))
    assert.equal(f.injected.length, 2, "hold 不得卡住入站 turn slot（r1 P1-3）")
  })
})
