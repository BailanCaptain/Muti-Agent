import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import type { RealtimeClientEvent, RealtimeServerEvent } from "@multi-agent/shared"
import { SqliteStore } from "../../db/sqlite"
import { ChannelGateway } from "../channel-gateway"
import type { ChannelSender } from "../channel-types"
import { type FeishuWsTransport, startFeishuConnector } from "../feishu/feishu-connector"

/**
 * F040 端到端种子：真 SQLite + 真 gateway + 真 parser（经 connector）+ fake transport/injector/sender。
 * Phase 1（T15）：AC2/3/5/7 合训 —— 入站事件 → 村长消息 → invocation.finished → 出站 sent，
 * 含连发保序 + crash 恢复。Phase 2（T12）：群链路 —— 群事件 → 门（AC10）→ 归因注入（AC11）
 * → 排队 ack（AC12）→ 署名卡片回群 + p2p/群互不串（AC13 切片）。这是 quality-gate 的证据源。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-e2e-"))
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

/** 终稿种子：字符串 = 默认署名黄仁勋；对象 = 指定署名（多 agent 协作链署名断言用） */
type FinalSeed = string | { content: string; senderAlias: string | null }

type HarnessOpts = {
  /** 群三元组（T12）：缺省 = 群模式关（Phase 1 行为） */
  group?: {
    allowedGroupChats: string[]
    groupMembers: Record<string, { name: string; role: "owner" | "participant" }>
    groupBindings: Record<string, string>
  }
  /** bot 自身 open_id（群 @bot 判定）；缺省 null = 群 fail-closed */
  botOpenId?: string | null
}

function makeHarness(
  dbFile?: string,
  finals: Record<string, FinalSeed> = {},
  opts: HarnessOpts = {},
) {
  const file = dbFile ?? path.join(tmpRoot, `e2e-${++dbSeq}.sqlite`)
  const store = new SqliteStore(file)
  openStores.push(store)

  let turnCounter = 0
  const injectedRoots: string[] = []
  const injectedPayloads: Array<Record<string, unknown>> = []
  let busy = false
  const injector = {
    setBusy: (v: boolean) => {
      busy = v
    },
    handleClientEvent(event: RealtimeClientEvent, emit: (e: RealtimeServerEvent) => void) {
      busy = true
      turnCounter += 1
      const root = `um_${turnCounter}`
      injectedRoots.push(root)
      injectedPayloads.push((event as { payload: Record<string, unknown> }).payload)
      emit({
        type: "message.created",
        payload: {
          threadId: (event as { payload: { threadId: string } }).payload.threadId,
          sessionGroupId: "sg-mobile",
          // biome-ignore lint/suspicious/noExplicitAny: fake
          message: { id: root, role: "user" } as any,
        },
      } as RealtimeServerEvent)
    },
    getBusyStatus: () => (busy ? "运行中" : null),
  }

  const sent: Array<{ chatId: string; text: string; senderAlias: string | null }> = []
  const sender: ChannelSender = {
    async sendText(chatId, text, sendOpts) {
      sent.push({ chatId, text, senderAlias: sendOpts?.senderAlias ?? null })
      return { ok: true }
    },
  }

  let idc = 0
  let tick = 0
  const gw = new ChannelGateway({
    db: store,
    injector,
    sender,
    readFinalMessage: (id) => {
      const seed = finals[id]
      if (seed === undefined) return null
      return {
        content: typeof seed === "string" ? seed : seed.content,
        senderAlias: typeof seed === "string" ? "黄仁勋" : seed.senderAlias,
        createdAt: "2026-07-04T00:00:00.000Z",
        orderSeq: null,
      }
    },
    resolveThread: () => "thread-claude-1",
    config: {
      connectorId: "feishu",
      allowedOpenIds: ["ou_sun"],
      bindSessionGroup: "sg-mobile",
      defaultProvider: "claude",
      allowedGroupChats: opts.group?.allowedGroupChats ?? [],
      groupMembers: opts.group?.groupMembers ?? {},
      groupBindings: opts.group?.groupBindings ?? {},
    },
    genId: () => `id-${++idc}`,
    now: () => `2026-07-03T00:00:${String(tick++).padStart(2, "0")}.000Z`,
  })

  let emitEvent: ((data: unknown) => Promise<void>) | null = null
  const transport: FeishuWsTransport = {
    async start(onEvent) {
      emitEvent = (d) => Promise.resolve(onEvent(d))
    },
    async stop() {},
  }

  return {
    store,
    file,
    gw,
    injector,
    sent,
    injectedRoots,
    injectedPayloads,
    async connect() {
      await startFeishuConnector({ transport, gateway: gw, botOpenId: opts.botOpenId ?? null })
    },
    async recv(text: string, messageId: string, openId = "ou_sun") {
      await emitEvent?.({
        sender: { sender_id: { open_id: openId }, sender_type: "user" },
        message: {
          message_id: messageId,
          chat_id: "oc_sun",
          chat_type: "p2p",
          message_type: "text",
          create_time: "1720000000000",
          content: JSON.stringify({ text }),
        },
      })
    },
    /** 群事件（T12）：mentionBot=true 时调用方在 text 里写 @_user_1 占位符（真机 schema 同构） */
    async recvGroup(
      text: string,
      messageId: string,
      o: { openId: string; chatId?: string; mentionBot?: boolean },
    ) {
      const mentions =
        (o.mentionBot ?? true)
          ? [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "multi-agent" }]
          : []
      await emitEvent?.({
        sender: { sender_id: { open_id: o.openId }, sender_type: "user" },
        message: {
          message_id: messageId,
          chat_id: o.chatId ?? "oc_group1",
          chat_type: "group",
          message_type: "text",
          create_time: "1720000000000",
          content: JSON.stringify({ text }),
          ...(mentions.length > 0 ? { mentions } : {}),
        },
      })
    },
    /** 模拟一轮 turn 结束：idle + 触发 finished（root=最近注入的） */
    async finishTurn(rootIndex: number, assistantMessageId: string) {
      injector.setBusy(false)
      await gw.onInvocationFinished({
        assistantMessageId,
        rootMessageId: injectedRoots[rootIndex],
      })
    },
  }
}

/** T12 群配置：彪哥=participant；ou_sun ∈ allowedOpenIds = owner（不列成员表 → 归因回落「村长」） */
const GROUP = {
  allowedGroupChats: ["oc_group1"],
  groupMembers: { ou_biao: { name: "彪哥", role: "participant" as const } },
  groupBindings: { oc_group1: "sg-group" },
}

describe("F040 E2E 飞书私聊往返", () => {
  it("入站文本 → 村长消息 → final → 出站回推（完整往返）", async () => {
    const h = makeHarness(undefined, { am_1: "村长你好，我在" })
    await h.connect()
    await h.recv("在吗", "om_1")
    assert.equal(h.injectedRoots.length, 1) // 村长消息已注入
    await h.finishTurn(0, "am_1")
    assert.deepEqual(h.sent, [{ chatId: "oc_sun", text: "村长你好，我在", senderAlias: "黄仁勋" }])
    // 账本终态
    const inbound = h.store.db
      .prepare("SELECT state FROM channel_inbound_ledger WHERE external_message_id='om_1'")
      .get() as { state: string }
    assert.equal(inbound.state, "injected")
    const outbound = h.store.db
      .prepare("SELECT state FROM channel_outbound_ledger WHERE internal_message_id='am_1'")
      .get() as { state: string }
    assert.equal(outbound.state, "sent")
  })

  it("turn 中连发 3 条（含重投）→ 幂等 + 保序 + 各自往返", async () => {
    const h = makeHarness(undefined, { am_1: "回复一", am_2: "回复二", am_3: "回复三" })
    await h.connect()
    await h.recv("一", "om_1")
    await h.recv("二", "om_2")
    await h.recv("一(重投)", "om_1") // 重投 om_1 → duplicate
    await h.recv("三", "om_3")
    // 只有 om_1 注入（busy），om_2/om_3 排队，重投不入库
    assert.equal(h.injectedRoots.length, 1)
    const count = h.store.db
      .prepare("SELECT COUNT(*) AS n FROM channel_inbound_ledger")
      .get() as { n: number }
    assert.equal(count.n, 3) // om_1, om_2, om_3（重投未新增）

    await h.finishTurn(0, "am_1")
    assert.equal(h.injectedRoots.length, 2) // om_2 drain
    await h.finishTurn(1, "am_2")
    assert.equal(h.injectedRoots.length, 3) // om_3 drain
    await h.finishTurn(2, "am_3")

    assert.deepEqual(
      h.sent.map((s) => s.text),
      ["回复一", "回复二", "回复三"],
    )
  })

  it("crash 后新实例同 DB → reconcile 续投未完成的出站 + drain 排队入站", async () => {
    const file = path.join(tmpRoot, `e2e-crash-${++dbSeq}.sqlite`)
    // 第一段：收两条，第一条注入并 final 落库但"崩溃"在出站前
    const h1 = makeHarness(file, { am_1: "崩溃前的回复" })
    await h1.connect()
    await h1.recv("一", "om_1")
    await h1.recv("二", "om_2")
    // 手动把 om_1 的出站登记成 pending（模拟 final 已落库、发送前崩溃）
    const bindingId = (
      h1.store.db.prepare("SELECT id FROM channel_bindings LIMIT 1").get() as { id: string }
    ).id
    h1.store.db
      .prepare(
        `INSERT INTO channel_outbound_ledger (id, binding_id, internal_message_id, state, attempts, possible_duplicate, created_at, updated_at)
         VALUES ('o-crash', ?, 'am_1', 'pending', 0, 0, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z')`,
      )
      .run(bindingId)

    // 第二段：新实例同 DB（新进程），reconcile
    const h2 = makeHarness(file, { am_1: "崩溃前的回复", am_2: "第二条回复" })
    h2.injector.setBusy(false)
    await h2.gw.reconcileOnBoot()
    // 出站 am_1 补投 + 入站 om_2 续 drain
    assert.ok(
      h2.sent.some((s) => s.text === "崩溃前的回复"),
      "出站 pending 应被 reconcile 补投",
    )
    assert.ok(h2.injectedRoots.length >= 1, "排队的 om_2 应被续 drain 注入")
  })
})

describe("F040 E2E 群链路（T12 · AC10/11/12 + AC13 切片）", () => {
  it("群 @bot → 门 → 归因注入 → 排队 ack → finished → 署名卡片回群（全链）", async () => {
    const h = makeHarness(
      undefined,
      { am_g1: "服务器正常", am_g2: { content: "磁盘还剩 200G", senderAlias: "范德彪" } },
      { group: GROUP, botOpenId: "ou_bot" },
    )
    await h.connect()

    // participant 彪哥 @bot 派活：占位符剥除 + 归因前缀独立成行 + senderDisplayName 持久化位
    await h.recvGroup("@_user_1 查一下服务器状态", "om_g1", { openId: "ou_biao" })
    assert.equal(h.injectedRoots.length, 1)
    assert.equal(h.injectedPayloads[0]?.content, "[飞书·彪哥]\n查一下服务器状态")
    assert.equal(h.injectedPayloads[0]?.senderDisplayName, "彪哥")
    assert.equal(h.injectedPayloads[0]?.alias, "村长")

    // owner（∈ allowedOpenIds、未列成员表）同群跟发 → busy 排队 + 群内 ack 报昵称+位置（AC12）
    await h.recvGroup("@_user_1 再看下磁盘", "om_g2", { openId: "ou_sun" })
    assert.equal(h.injectedRoots.length, 1) // 第二条未注入（排队）
    assert.deepEqual(h.sent.at(-1), {
      chatId: "oc_group1",
      text: "已排队（第 1 位）｜村长",
      senderAlias: null,
    })

    // 第一轮 finished → 署名卡片回群 + drain 第二条（owner 归因回落「村长」）
    await h.finishTurn(0, "am_g1")
    assert.ok(
      h.sent.some(
        (s) => s.chatId === "oc_group1" && s.text === "服务器正常" && s.senderAlias === "黄仁勋",
      ),
      "第一轮终稿应署名回群",
    )
    assert.equal(h.injectedRoots.length, 2)
    assert.equal(h.injectedPayloads[1]?.content, "[飞书·村长]\n再看下磁盘")

    // 第二轮 finished → 多 agent 协作链署名（范德彪）回群
    await h.finishTurn(1, "am_g2")
    assert.ok(
      h.sent.some((s) => s.text === "磁盘还剩 200G" && s.senderAlias === "范德彪"),
      "第二轮终稿应带协作 agent 署名",
    )

    // 账本终态：两条入站 injected、两条出站 sent（spread：node:sqlite 行是 null-prototype）
    const inbound = (
      h.store.db
        .prepare("SELECT external_message_id, state FROM channel_inbound_ledger ORDER BY seq")
        .all() as Array<{ external_message_id: string; state: string }>
    ).map((r) => ({ ...r }))
    assert.deepEqual(inbound, [
      { external_message_id: "om_g1", state: "injected" },
      { external_message_id: "om_g2", state: "injected" },
    ])
    const outbound = (
      h.store.db
        .prepare(
          "SELECT internal_message_id, state FROM channel_outbound_ledger ORDER BY created_at",
        )
        .all() as Array<{ internal_message_id: string; state: string }>
    ).map((r) => ({ ...r }))
    assert.deepEqual(outbound, [
      { internal_message_id: "am_g1", state: "sent" },
      { internal_message_id: "am_g2", state: "sent" },
    ])
  })

  it("群门（AC10）：未@bot 静默 / 陌生群不回执（防探测）/ 陌生成员回执引导", async () => {
    const h = makeHarness(undefined, {}, { group: GROUP, botOpenId: "ou_bot" })
    await h.connect()

    // 成员间正常聊天（未 @bot）→ 静默：不注入不入账本不回执
    await h.recvGroup("你们看这个 bug 怎么办", "om_n1", { openId: "ou_biao", mentionBot: false })
    // 陌生群 @bot → 拒（审计自举 chatId），不回执防探测
    await h.recvGroup("@_user_1 在吗", "om_n2", { openId: "ou_biao", chatId: "oc_unknown" })
    // 白名单群内陌生成员 @bot → 拒 + 群内回执引导 owner 配置
    await h.recvGroup("@_user_1 干活", "om_n3", { openId: "ou_stranger" })

    assert.equal(h.injectedRoots.length, 0)
    const n = (
      h.store.db.prepare("SELECT COUNT(*) AS n FROM channel_inbound_ledger").get() as { n: number }
    ).n
    assert.equal(n, 0) // 三条全被门挡在账本之外
    assert.equal(h.sent.length, 1) // 只有陌生成员一条回执
    assert.equal(h.sent[0]?.chatId, "oc_group1")
    assert.match(h.sent[0]?.text ?? "", /没有被授权/)
  })

  it("p2p 与群同 gateway：往返互不串（AC13 切片）— 回各自 chat、群带归因/私聊无前缀", async () => {
    const h = makeHarness(
      undefined,
      { am_p: "私聊回复", am_g: { content: "群回复", senderAlias: "范德彪" } },
      { group: GROUP, botOpenId: "ou_bot" },
    )
    await h.connect()

    await h.recv("在吗", "om_p1")
    assert.equal(h.injectedPayloads[0]?.content, "在吗") // p2p 无归因前缀（Phase 1 原样）
    assert.equal("senderDisplayName" in (h.injectedPayloads[0] ?? {}), false)
    await h.finishTurn(0, "am_p")

    await h.recvGroup("@_user_1 群里派活", "om_g1", { openId: "ou_biao" })
    assert.equal(h.injectedPayloads[1]?.content, "[飞书·彪哥]\n群里派活")
    await h.finishTurn(1, "am_g")

    // 各回各家 + 各自署名；无跨投
    assert.deepEqual(h.sent, [
      { chatId: "oc_sun", text: "私聊回复", senderAlias: "黄仁勋" },
      { chatId: "oc_group1", text: "群回复", senderAlias: "范德彪" },
    ])
    // 两条 binding 独立（chat_kind / session_group 各归各；spread 去 null-prototype）
    const bindings = (
      h.store.db
        .prepare(
          "SELECT external_chat_id, chat_kind, session_group_id FROM channel_bindings ORDER BY external_chat_id",
        )
        .all() as Array<Record<string, unknown>>
    ).map((r) => ({ ...r }))
    assert.deepEqual(bindings, [
      { external_chat_id: "oc_group1", chat_kind: "group", session_group_id: "sg-group" },
      { external_chat_id: "oc_sun", chat_kind: "p2p", session_group_id: "sg-mobile" },
    ])
  })
})
