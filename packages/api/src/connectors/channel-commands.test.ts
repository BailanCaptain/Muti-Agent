import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { SqliteStore } from "../db/sqlite"
import { ChannelAdminStore } from "./channel-admin-store"
import {
  ChannelCommandExecutor,
  type CommandExecutorDeps,
  parseCommand,
} from "./channel-commands"
import type { ChannelCommandContext } from "./channel-types"

/**
 * F040 P2.6 T6（AC-N2）：命令 parser（纯函数矩阵）+ executor 五命令
 * （/rooms /newroom /switch /agent /status /help；/model 在 T7）。
 * executor 用真 ChannelAdminStore + 真临时 SQLite（binding 写路径是正确性核心），
 * rooms/runtimeConfig/findThread 注 fake。
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "f040-cmds-"))
let n = 0
const opened: SqliteStore[] = []
after(() => {
  for (const db of opened) {
    try {
      db.db.close()
    } catch {}
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

describe("T6 parseCommand（纯函数矩阵）", () => {
  it("零参命令 + 大小写不敏感命令词", () => {
    assert.deepEqual(parseCommand("/rooms"), { kind: "rooms" })
    assert.deepEqual(parseCommand("/HELP"), { kind: "help" })
    assert.deepEqual(parseCommand("/Status"), { kind: "status" })
  })

  it("rest-of-line 命令：标题/目标保留内部空格", () => {
    assert.deepEqual(parseCommand("/newroom 周末 出游 计划"), {
      kind: "newroom",
      title: "周末 出游 计划",
    })
    assert.deepEqual(parseCommand("/switch R-003"), { kind: "switch", target: "R-003" })
    assert.deepEqual(parseCommand("/switch 移动群房"), { kind: "switch", target: "移动群房" })
    assert.deepEqual(parseCommand("/agent 范德彪"), { kind: "agent", target: "范德彪" })
  })

  it("缺参 → usage；未知词 → unknown", () => {
    assert.deepEqual(parseCommand("/newroom"), { kind: "usage", command: "newroom" })
    assert.deepEqual(parseCommand("/switch  "), { kind: "usage", command: "switch" })
    assert.deepEqual(parseCommand("/agent"), { kind: "usage", command: "agent" })
    assert.deepEqual(parseCommand("/xyz 什么"), { kind: "unknown", word: "xyz" })
    assert.deepEqual(parseCommand("/"), { kind: "unknown", word: "" })
  })

  it("/model 全形态：R-号定位（大小写不敏感）/ show / show-agent / set / clear", () => {
    assert.deepEqual(parseCommand("/model"), {
      kind: "model",
      roomRef: null,
      action: { type: "show" },
    })
    assert.deepEqual(parseCommand("/model r-002"), {
      kind: "model",
      roomRef: "R-002",
      action: { type: "show" },
    })
    assert.deepEqual(parseCommand("/model 范德彪"), {
      kind: "model",
      roomRef: null,
      action: { type: "show-agent", agent: "范德彪" },
    })
    assert.deepEqual(parseCommand("/model 范德彪 gpt-5.4"), {
      kind: "model",
      roomRef: null,
      action: { type: "set", agent: "范德彪", model: "gpt-5.4" },
    })
    assert.deepEqual(parseCommand("/model R-002 范德彪 gpt-5.4 high"), {
      kind: "model",
      roomRef: "R-002",
      action: { type: "set", agent: "范德彪", model: "gpt-5.4", effort: "high" },
    })
    assert.deepEqual(parseCommand("/model 范德彪 default"), {
      kind: "model",
      roomRef: null,
      action: { type: "clear", agent: "范德彪" },
    })
    assert.deepEqual(parseCommand("/model a b c d"), { kind: "usage", command: "model" })
  })
})

// ---- executor 五命令 ----

function build() {
  const db = new SqliteStore(path.join(tmpRoot, `db-${n++}.sqlite`))
  opened.push(db)
  let tick = 0
  const adminStore = new ChannelAdminStore({
    db,
    channel: "feishu",
    genId: () => `cid-${++tick}`,
    now: () => "2026-07-05T00:00:00.000Z",
  })
  const roomList: Array<{ id: string; roomId: string | null; title: string }> = [
    { id: "sg-mobile", roomId: "R-001", title: "手机房" },
    { id: "sg-group", roomId: "R-002", title: "移动群房" },
    { id: "sg-dup-a", roomId: "R-003", title: "同名房" },
    { id: "sg-dup-b", roomId: "R-004", title: "同名房" },
  ]
  let created = 0
  // /model 读写面：有状态（写路径断言用）；seed 与 T6 断言一致
  const sessionCfg: Record<string, Record<string, unknown>> = {
    "sg-mobile": { claude: { model: "claude-opus-4-6", effort: "high" } },
  }
  const pendingCfg: Record<string, Record<string, unknown>> = {}
  const busy = new Set<string>()
  const deps: CommandExecutorDeps = {
    adminStore,
    rooms: {
      list: () => [...roomList],
      create: (title: string) => {
        created += 1
        const room = { id: `sg-new-${created}`, roomId: `R-10${created}`, title }
        roomList.push(room)
        return room
      },
    },
    runtimeConfig: {
      getGlobal: () => ({ codex: { model: "gpt-5" } }),
      getSession: (groupId) => structuredClone(sessionCfg[groupId] ?? {}),
      setSession: (groupId, cfg) => {
        sessionCfg[groupId] = cfg
      },
      getPending: (groupId) => structuredClone(pendingCfg[groupId] ?? {}),
      setPending: (groupId, cfg) => {
        pendingCfg[groupId] = cfg
      },
    },
    findThread: (_g, p) => ({
      id: `t-${p}`,
      currentModel: p === "gemini" ? "gemini-3.1-pro-preview" : null,
    }),
    isBusy: (groupId, provider) => busy.has(`${groupId}:${provider}`),
  }
  const exec = new ChannelCommandExecutor(deps)
  const ctx = (o: Partial<ChannelCommandContext> = {}): ChannelCommandContext => ({
    chatId: "p2p_sun",
    chatKind: "p2p",
    senderOpenId: "ou_sun",
    text: "/rooms",
    binding: { sessionGroupId: "sg-mobile", defaultProvider: "claude" },
    channelDefaults: { bindSessionGroup: "sg-mobile", defaultProvider: "claude" },
    ...o,
  })
  const run = (text: string, o: Partial<ChannelCommandContext> = {}) =>
    exec.execute({ ...ctx(o), text })
  return { db, adminStore, run, roomList, sessionCfg, pendingCfg, busy }
}

function binding(db: SqliteStore, chatId: string) {
  const row = db.db
    .prepare(
      "SELECT session_group_id, default_provider FROM channel_bindings WHERE connector_id = 'feishu' AND external_chat_id = ?",
    )
    .get(chatId) as { session_group_id: string; default_provider: string } | undefined
  return row ? { ...row } : undefined
}

describe("T6 executor：/rooms /newroom /switch /agent /status /help", () => {
  it("/rooms：R-号+房间名逐行，当前绑定标注；未绑 chat 给引导", async () => {
    const { run } = build()
    const out = await run("/rooms")
    assert.match(out, /R-001.*手机房.*← 当前/)
    assert.match(out, /R-002.*移动群房/)
    const unbound = await run("/rooms", { binding: null, chatKind: "group", chatId: "oc_x" })
    assert.match(unbound, /还没选房间/)
    assert.doesNotMatch(unbound, /← 当前/)
  })

  it("/newroom：建房 + 当前对话换绑一步（binding 落库）；标题校验（空 usage / 超 40 拒 / 控制字符拒）", async () => {
    const { db, run } = build()
    const out = await run("/newroom 周末计划", { chatKind: "group", chatId: "oc_g1", binding: null })
    assert.match(out, /R-101/)
    assert.match(out, /周末计划/)
    assert.deepEqual(binding(db, "oc_g1"), {
      session_group_id: "sg-new-1",
      default_provider: "claude",
    })
    const usage = await run("/newroom")
    assert.match(usage, /用法/)
    const tooLong = await run(`/newroom ${"长".repeat(41)}`)
    assert.match(tooLong, /1-40/)
    const ctrl = await run(`/newroom 名字${String.fromCharCode(7)}坏`)
    assert.match(ctrl, /控制字符/)
    assert.equal(binding(db, "p2p_sun"), undefined, "校验失败不该动 binding")
  })

  it("/switch：R-号大小写不敏感 / 完整房名 / 同名列候选 / 找不到指 /rooms", async () => {
    const { db, run } = build()
    const byId = await run("/switch r-002", { chatId: "p2p_sun" })
    assert.match(byId, /R-002/)
    assert.equal(binding(db, "p2p_sun")?.session_group_id, "sg-group")
    const byTitle = await run("/switch 手机房")
    assert.match(byTitle, /R-001/)
    assert.equal(binding(db, "p2p_sun")?.session_group_id, "sg-mobile")
    const ambiguous = await run("/switch 同名房")
    assert.match(ambiguous, /R-003/)
    assert.match(ambiguous, /R-004/)
    assert.equal(binding(db, "p2p_sun")?.session_group_id, "sg-mobile", "歧义不动 binding")
    const missing = await run("/switch 不存在的房")
    assert.match(missing, /\/rooms/)
    const zeroless = await run("/switch R-2")
    assert.match(zeroless, /R-002/)
    assert.equal(
      binding(db, "p2p_sun")?.session_group_id,
      "sg-group",
      "省零 R-2 匹配库存补零 R-002（07-05 小孙反馈格式难用）",
    )
  })

  it("/agent：花名/provider id/@花名 三形态 → binding.default_provider 落库；未知目标回词表", async () => {
    const { db, run } = build()
    const byAlias = await run("/agent 范德彪")
    assert.match(byAlias, /范德彪（codex）/)
    assert.equal(binding(db, "p2p_sun")?.default_provider, "codex")
    const byId = await run("/agent CLAUDE")
    assert.match(byId, /黄仁勋/)
    assert.equal(binding(db, "p2p_sun")?.default_provider, "claude")
    const byAt = await run("/agent @桂芬")
    assert.equal(binding(db, "p2p_sun")?.default_provider, "gemini")
    const unknown = await run("/agent 罗翔")
    assert.match(unknown, /花名/)
    assert.equal(binding(db, "p2p_sun")?.default_provider, "gemini", "未知目标不动 binding")
  })

  it("/agent 未绑且无种子的群 → 引导先 /switch 或 /newroom（不静默建绑定）", async () => {
    const { db, run } = build()
    const out = await run("/agent 范德彪", {
      chatKind: "group",
      chatId: "oc_unbound",
      binding: null,
    })
    assert.match(out, /\/switch|\/newroom/)
    assert.equal(binding(db, "oc_unbound"), undefined)
  })

  it("/status：房间 + 默认应答人 + 三 agent 生效模型带来源（房间覆盖/全局/默认/CLI 默认）", async () => {
    const { run } = build()
    const out = await run("/status")
    assert.match(out, /R-001.*手机房/)
    assert.match(out, /默认应答人.*黄仁勋/)
    assert.match(out, /claude-opus-4-6（房间覆盖）/)
    assert.match(out, /gpt-5（全局）/)
    assert.match(out, /gemini-3\.1-pro-preview（默认）/)
    const unbound = await run("/status", { binding: null, chatKind: "group", chatId: "oc_y" })
    assert.match(unbound, /还没选房间/)
  })

  it("/help 覆盖全词表 + 保姆级格式说明（空格规则/照抄例子/省零等价）；未知命令回 /help 提示", async () => {
    const { run } = build()
    const help = await run("/help")
    for (const w of ["/rooms", "/newroom", "/switch", "/agent", "/model", "/status", "/help"]) {
      assert.ok(help.includes(w), `help 缺 ${w}`)
    }
    assert.match(help, /用空格隔开/, "格式总规则必须写明空格分隔（07-05 小孙点名）")
    assert.match(help, /例：/, "命令要带可照抄的例子")
    assert.match(help, /R-3 = R-003/, "R-号省零等价要写进手册")
    assert.match(help, /黄仁勋 \/ 范德彪 \/ 桂芬/, "花名清单动态拼自 PROVIDER_ALIASES")
    const unknown = await run("/xyz")
    assert.match(unknown, /\/help/)
  })
})

describe("T7 /model 读写清（复用 session-runtime-config 合同）", () => {
  it("show：当前房带房名抬头 + 三 agent 生效行；R-号定位别的房；R-号不存在 → 引导", async () => {
    const { run } = build()
    const cur = await run("/model")
    assert.match(cur, /R-001.*手机房/)
    assert.match(cur, /claude-opus-4-6（房间覆盖）/)
    const other = await run("/model R-002")
    assert.match(other, /R-002.*移动群房/)
    assert.match(other, /gpt-5（全局）/, "别的房没有房间覆盖 → codex 显全局")
    assert.doesNotMatch(other, /房间覆盖/)
    const missing = await run("/model R-999")
    assert.match(missing, /没找到 R-999/)
    const zeroless = await run("/model R-2")
    assert.match(zeroless, /R-002.*移动群房/, "省零 R-2 匹配库存补零 R-002")
  })

  it("show-agent：单 agent 一行；未知 agent 回词表", async () => {
    const { run } = build()
    const one = await run("/model 桂芬")
    assert.match(one, /桂芬（gemini）：gemini-3\.1-pro-preview（默认）/)
    assert.doesNotMatch(one, /范德彪/)
    const unknown = await run("/model 罗翔")
    assert.match(unknown, /花名/)
  })

  it("set 空闲：session config 落库（patch 语义保旧 effort）+ 同字段清 pending 防倒灌；回执已生效", async () => {
    const { run, sessionCfg, pendingCfg } = build()
    pendingCfg["sg-mobile"] = { codex: { model: "gpt-stale" } }
    const out = await run("/model 范德彪 gpt-5.4")
    assert.match(out, /已生效/)
    assert.deepEqual(sessionCfg["sg-mobile"].codex, { model: "gpt-5.4" })
    assert.deepEqual(sessionCfg["sg-mobile"].claude, { model: "claude-opus-4-6", effort: "high" }, "别的 agent 不动")
    assert.deepEqual(pendingCfg["sg-mobile"].codex, {}, "同字段 stale pending 被清（防 flush 倒灌盖掉新值）")
    // 带强度：effort 一起落
    await run("/model 范德彪 gpt-5.4 xhigh")
    assert.deepEqual(sessionCfg["sg-mobile"].codex, { model: "gpt-5.4", effort: "xhigh" })
  })

  it("set 运行中：写 pending 不动 config；回执下轮生效", async () => {
    const { run, sessionCfg, pendingCfg, busy } = build()
    busy.add("sg-mobile:codex")
    const out = await run("/model 范德彪 gpt-5.4 high")
    assert.match(out, /下轮/)
    assert.equal(sessionCfg["sg-mobile"].codex, undefined, "运行中不动 active config")
    assert.deepEqual(pendingCfg["sg-mobile"].codex, { model: "gpt-5.4", effort: "high" })
  })

  it("set R-号定位别的房：写到目标房，不碰当前房", async () => {
    const { run, sessionCfg } = build()
    const out = await run("/model R-002 桂芬 gemini-3-flash-preview")
    assert.match(out, /R-002/)
    assert.deepEqual(sessionCfg["sg-group"].gemini, { model: "gemini-3-flash-preview" })
    assert.equal(sessionCfg["sg-mobile"].gemini, undefined)
  })

  it("型号格式闸（spawn argv 注入面）：分号/flag 前缀/超长/非 ASCII 全拒，零写入", async () => {
    const { run, sessionCfg, pendingCfg } = build()
    for (const bad of ["gpt;rm", "--yolo", `a${"b".repeat(64)}`, "模型中文", "-mfoo"]) {
      const out = await run(`/model 范德彪 ${bad}`)
      assert.match(out, /型号格式|用法/, `应拒：${bad}`)
    }
    assert.equal(sessionCfg["sg-mobile"].codex, undefined)
    assert.equal(pendingCfg["sg-mobile"], undefined)
  })

  it("强度闭集按 agent：codex 非法值列合法集；gemini 不支持强度", async () => {
    const { run, sessionCfg } = build()
    const badEffort = await run("/model 范德彪 gpt-5.4 turbo")
    assert.match(badEffort, /none.*minimal.*low/, "报错列出 codex 合法强度集")
    assert.equal(sessionCfg["sg-mobile"].codex, undefined)
    const gemini = await run("/model 桂芬 gemini-3-flash-preview max")
    assert.match(gemini, /不支持.*强度/)
    assert.equal(sessionCfg["sg-mobile"].gemini, undefined)
  })

  it("default 清覆盖：model/effort 双清但保 contextWindow；pending 同步清；回执还原", async () => {
    const { run, sessionCfg, pendingCfg } = build()
    sessionCfg["sg-mobile"].claude = {
      model: "claude-opus-4-6",
      effort: "high",
      contextWindow: 180000,
    }
    pendingCfg["sg-mobile"] = { claude: { model: "claude-haiku-4-5" } }
    const out = await run("/model 黄仁勋 default")
    assert.match(out, /还原|全局/)
    assert.deepEqual(sessionCfg["sg-mobile"].claude, { contextWindow: 180000 })
    assert.deepEqual(pendingCfg["sg-mobile"].claude, undefined, "pending 覆盖同步清（防 flush 复活）")
  })

  it("未绑且不带 R-号 → 引导先绑房", async () => {
    const { run } = build()
    const out = await run("/model", { binding: null, chatKind: "group", chatId: "oc_z" })
    assert.match(out, /还没选房间/)
  })
})
