import { PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { resolveMentionTarget } from "../routes/callbacks"
import { type AgentKind, MODEL_CATALOG } from "../runtime/model-catalog"
import {
  type AgentOverride,
  isValidWikiCompileModelId,
  resolveEffectiveOverride,
  validateSessionRuntimeConfigInput,
} from "../runtime/runtime-config"
import type { ChannelAdminStore } from "./channel-admin-store"
import type { ChannelCommandContext, ChannelCommandHandler } from "./channel-types"

/**
 * 型号格式闸：与 wikiCompile 同一把（runtime-config.ts:59-69 结论原文适用）——
 * 命令文本来自 IM，model 最终进 CLI spawn argv；`[A-Za-z0-9][A-Za-z0-9._:/-]*` ≤64
 * 杀 cmd.exe 元字符注入 + `-` 开头 flag 注入，真实 model id 全通过零功能代价。
 * session PUT 路由历史上只 trim（前端选择器恒发合法值）；IM 入口按最严闸走。
 */
const isValidModelId = isValidWikiCompileModelId

/**
 * F040 P2.6（AC-N2，D19 词表）：飞书指挥面命令模块。
 * parseCommand 纯函数（词表全形态 → 结构化命令）；executor 只做命令语义——
 * owner 门/幂等/异常收口都在 gateway（channel-gateway.handleCommand）。
 * 绑定写路径全部走 ChannelAdminStore 原语（rebindChat/setDefaultResponder，
 * 与管理页同一套，D20 绑定自助化）。
 */

export type ModelAction =
  | { type: "show" }
  | { type: "show-agent"; agent: string }
  | { type: "set"; agent: string; model: string; effort?: string }
  | { type: "clear"; agent: string }

export type ParsedCommand =
  | { kind: "rooms" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "newroom"; title: string }
  | { kind: "switch"; target: string }
  | { kind: "agent"; target: string }
  | { kind: "model"; roomRef: string | null; action: ModelAction }
  | { kind: "usage"; command: "newroom" | "switch" | "agent" | "model" }
  | { kind: "unknown"; word: string }

const ROOM_REF_RE = /^r-\d+$/i

/** R-号归一：大小写不敏感输入 → 大写规范形（与 session_groups.room_id 存储形态一致） */
function normalizeRoomRef(raw: string): string {
  return `R-${raw.slice(2)}`
}

/** R-号等价：数字段相等即同一房。库存三位补零（R-003），人手打 R-3 也认（07-05 小孙反馈格式难用） */
function sameRoomRef(a: string, b: string): boolean {
  return Number.parseInt(a.slice(2), 10) === Number.parseInt(b.slice(2), 10)
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim()
  const afterSlash = trimmed.slice(1)
  const word = (afterSlash.split(/\s+/)[0] ?? "").toLowerCase()
  const rest = afterSlash.slice(word.length).trim()

  switch (word) {
    case "rooms":
      return { kind: "rooms" }
    case "help":
      return { kind: "help" }
    case "status":
      return { kind: "status" }
    case "newroom":
      return rest.length === 0 ? { kind: "usage", command: "newroom" } : { kind: "newroom", title: rest }
    case "switch":
      return rest.length === 0 ? { kind: "usage", command: "switch" } : { kind: "switch", target: rest }
    case "agent":
      return rest.length === 0 ? { kind: "usage", command: "agent" } : { kind: "agent", target: rest }
    case "model": {
      const args = rest.length === 0 ? [] : rest.split(/\s+/)
      let roomRef: string | null = null
      if (args.length > 0 && ROOM_REF_RE.test(args[0])) {
        roomRef = normalizeRoomRef(args[0])
        args.shift()
      }
      if (args.length === 0) return { kind: "model", roomRef, action: { type: "show" } }
      if (args.length === 1) {
        return { kind: "model", roomRef, action: { type: "show-agent", agent: args[0] } }
      }
      if (args.length === 2) {
        return args[1].toLowerCase() === "default"
          ? { kind: "model", roomRef, action: { type: "clear", agent: args[0] } }
          : { kind: "model", roomRef, action: { type: "set", agent: args[0], model: args[1] } }
      }
      if (args.length === 3) {
        return {
          kind: "model",
          roomRef,
          action: { type: "set", agent: args[0], model: args[1], effort: args[2] },
        }
      }
      return { kind: "usage", command: "model" }
    }
    default:
      return { kind: "unknown", word }
  }
}

// ---- executor ----

export type CommandExecutorDeps = {
  adminStore: ChannelAdminStore
  rooms: {
    /** 活房间（archived/deleted 排除，与管理页 /rooms 端点同一口径） */
    list(): Array<{ id: string; roomId: string | null; title: string }>
    /** 建房 + 默认三线程（sessionService.createSessionGroup(title) 同一原语） */
    create(title: string): { id: string; roomId: string | null; title: string }
  }
  runtimeConfig: {
    getGlobal(): Record<string, AgentOverride | undefined>
    getSession(groupId: string): Record<string, unknown>
    setSession(groupId: string, cfg: Record<string, unknown>): void
    getPending(groupId: string): Record<string, unknown>
    setPending(groupId: string, cfg: Record<string, unknown>): void
  }
  findThread(groupId: string, provider: string): { id: string; currentModel: string | null } | null
  /** 目标房该 agent 是否有在飞 turn（/model busy→pending 归档语义用，T7） */
  isBusy(groupId: string, provider: string): boolean
}

/** usage 回执：参数不对时回的引导——必须带可原样照抄的例子（07-05 小孙点名手册要保姆级） */
const USAGE: Record<"newroom" | "switch" | "agent" | "model", string> = {
  newroom:
    "用法：/newroom 房间名（命令和房名之间空一格；房名 1-40 字，可以带空格）。\n例：`/newroom 周末计划` —— 建好房并把本对话切过去。",
  switch:
    "用法：/switch R-号或完整房名（命令后空一格）。\n例：`/switch R-3` 或 `/switch 周末计划`。R-号发 /rooms 能看到，前面的 0 可省（R-3 = R-003）。",
  agent: "用法：/agent 花名（命令后空一格）。\n例：`/agent 范德彪` —— 改本对话默认应答人。",
  model:
    "用法：/model 花名 型号 强度（每段之间用空格隔开，强度可省略）；`/model 花名 default` 清掉房间覆盖；最前面加 R-号可指定别的房间。\n例：`/model 范德彪 gpt-5.4 high`、`/model R-2 范德彪 default`。",
}

/** 展示顺序固定（默认应答人仁勋在前）；PROVIDERS 常量序是注册序不是展示序 */
const DISPLAY_PROVIDERS: Provider[] = ["claude", "codex", "gemini"]

function aliasOf(provider: string): string {
  return PROVIDER_ALIASES[provider as Provider] ?? provider
}

function providerOfAlias(alias: string): Provider | null {
  for (const [provider, a] of Object.entries(PROVIDER_ALIASES)) {
    if (a === alias) return provider as Provider
  }
  return null
}

/**
 * /help 全文：保姆级——顶部格式总规则 + 每条命令给可原样照抄的例子。
 * 07-05 小孙反馈「手册一定要详细，不然不会用」；例子里的型号取自 MODEL_CATALOG 真值，照抄能跑。
 */
const HELP_TEXT = [
  "**飞书命令手册**（仅群主可用）",
  "格式：`/` 后面紧跟命令词（中间不加空格），命令和参数之间**用空格隔开**；多打几个空格没关系，大小写随意。",
  "",
  "**查看**",
  "- `/rooms` —— 列出所有房间（R-号 + 房名，标出本对话当前所在的房间）",
  "- `/status` —— 看本对话：当前房间、默认应答人、各 agent 生效模型",
  "- `/help` —— 本手册",
  "",
  "**换房间**",
  "- `/newroom 房间名` —— 建新房并把本对话切过去。例：`/newroom 周末计划`（房名可带空格）",
  "- `/switch R-号或房名` —— 切到已有房间。例：`/switch R-3` 或 `/switch 周末计划`（R-号前面的 0 可省，R-3 = R-003）",
  "",
  "**改默认应答人**",
  `- \`/agent 花名\` —— 例：\`/agent 范德彪\`。可选：${DISPLAY_PROVIDERS.map((p) => aliasOf(p)).join(" / ")}`,
  "",
  "**看/改模型**（参数按空格切，顺序固定：花名 型号 强度）",
  "- `/model` —— 看本房各 agent 的生效模型和来源",
  "- `/model 范德彪` —— 只看这一个 agent",
  "- `/model 范德彪 gpt-5.4` —— 给本房这个 agent 设型号；带强度：`/model 范德彪 gpt-5.4 high`",
  "- `/model 范德彪 default` —— 清掉房间覆盖，回到全局设置",
  "- 改别的房间：最前面加 R-号。例：`/model R-2 范德彪 default`",
].join("\n")

/** 房间名与管理页 displayName 同一约束（1-40 字无控制字符；PATCH title 路由同款） */
function validateRoomTitle(title: string): string | null {
  if (title.length === 0 || title.length > 40) return "房间名长度需在 1-40 字之间。"
  for (const ch of title) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20 || c === 0x7f) return "房间名不能含控制字符。"
  }
  return null
}

export class ChannelCommandExecutor implements ChannelCommandHandler {
  constructor(private readonly deps: CommandExecutorDeps) {}

  async execute(ctx: ChannelCommandContext): Promise<string> {
    const cmd = parseCommand(ctx.text)
    switch (cmd.kind) {
      case "rooms":
        return this.rooms(ctx)
      case "help":
        return HELP_TEXT
      case "status":
        return this.status(ctx)
      case "newroom":
        return this.newroom(ctx, cmd.title)
      case "switch":
        return this.switchRoom(ctx, cmd.target)
      case "agent":
        return this.agent(ctx, cmd.target)
      case "model":
        return this.model(ctx, cmd.roomRef, cmd.action)
      case "usage":
        return USAGE[cmd.command]
      case "unknown":
        return `不认识 /${cmd.word}——发 /help 看可用命令。`
    }
  }

  private rooms(ctx: ChannelCommandContext): string {
    const rooms = this.deps.rooms.list()
    if (rooms.length === 0) return "还没有任何房间——/newroom <名> 建一个。"
    const lines = rooms.map((r) => {
      const current = ctx.binding?.sessionGroupId === r.id ? "　← 当前" : ""
      return `${r.roomId ?? "—"}　${r.title}${current}`
    })
    if (!ctx.binding) {
      lines.push("", "本对话还没选房间：/switch R-号 切过去，或 /newroom 房间名 建一个。")
    }
    return lines.join("\n")
  }

  private newroom(ctx: ChannelCommandContext, title: string): string {
    const bad = validateRoomTitle(title)
    if (bad) return bad
    const room = this.deps.rooms.create(title)
    this.deps.adminStore.rebindChat(ctx.chatId, ctx.chatKind, room.id, {
      defaultProvider: ctx.binding?.defaultProvider ?? ctx.channelDefaults.defaultProvider,
    })
    return `已建 ${room.roomId ?? ""}「${room.title}」，本对话已切换过去。`
  }

  private switchRoom(ctx: ChannelCommandContext, target: string): string {
    const rooms = this.deps.rooms.list()
    let matched: Array<{ id: string; roomId: string | null; title: string }>
    if (ROOM_REF_RE.test(target)) {
      matched = rooms.filter(
        (r) => r.roomId != null && ROOM_REF_RE.test(r.roomId) && sameRoomRef(r.roomId, target),
      )
    } else {
      matched = rooms.filter((r) => r.title === target)
    }
    if (matched.length === 0) {
      return `没找到「${target}」。发 /rooms 看列表。`
    }
    if (matched.length > 1) {
      const refs = matched.map((r) => r.roomId ?? r.id).join("、")
      return `有 ${matched.length} 个房间都叫「${target}」：${refs}——用 R-号再来一次。`
    }
    const room = matched[0]
    this.deps.adminStore.rebindChat(ctx.chatId, ctx.chatKind, room.id, {
      defaultProvider: ctx.binding?.defaultProvider ?? ctx.channelDefaults.defaultProvider,
    })
    return `本对话已切到 ${room.roomId ?? ""}「${room.title}」。`
  }

  private agent(ctx: ChannelCommandContext, target: string): string {
    const resolved = resolveMentionTarget(target)
    if (!resolved.ok) return resolved.error
    const provider = providerOfAlias(resolved.alias)
    if (!provider) return `内部错误：花名 ${resolved.alias} 找不到 provider。`
    // seed 顺位：binding 现值 → p2p 渠道种子；群未绑且无种子 → 引导（不静默建绑定）
    const seed =
      ctx.binding?.sessionGroupId ??
      (ctx.chatKind === "p2p" ? ctx.channelDefaults.bindSessionGroup : null)
    if (!ctx.binding && !seed) {
      return "本对话还没选房间：先 /switch R-号 或 /newroom 房间名，再改默认应答人。"
    }
    this.deps.adminStore.setDefaultResponder(ctx.chatId, ctx.chatKind, provider, {
      seedSessionGroupId: seed,
    })
    return `本对话默认应答人已改为 ${resolved.alias}（${provider}），下一条消息生效。`
  }

  private status(ctx: ChannelCommandContext): string {
    if (!ctx.binding) {
      return [
        "本对话还没选房间：/switch R-号 切过去，或 /newroom 房间名 建一个。",
        `默认应答人（渠道默认）：${aliasOf(ctx.channelDefaults.defaultProvider)}（${ctx.channelDefaults.defaultProvider}）`,
      ].join("\n")
    }
    const groupId = ctx.binding.sessionGroupId
    const room = this.deps.rooms.list().find((r) => r.id === groupId)
    const roomLabel = room ? `${room.roomId ?? ""}「${room.title}」` : groupId
    const lines = [
      `当前房间：${roomLabel}`,
      `默认应答人：${aliasOf(ctx.binding.defaultProvider)}（${ctx.binding.defaultProvider}）`,
      "模型（生效值）：",
      ...this.modelLines(groupId),
    ]
    return lines.join("\n")
  }

  /** 逐 agent 生效模型行（/status 与 /model show 共用）：来源标注 = 房间覆盖/全局/默认/CLI 默认 */
  private modelLines(groupId: string, only?: Provider): string[] {
    const session = this.deps.runtimeConfig.getSession(groupId)
    const global = this.deps.runtimeConfig.getGlobal()
    const providers = only ? [only] : DISPLAY_PROVIDERS
    return providers.map((p) => {
      const sessionOverride = session[p] as AgentOverride | undefined
      const eff = resolveEffectiveOverride(sessionOverride, global[p], p as AgentKind)
      const thread = this.deps.findThread(groupId, p)
      let model: string
      let source: string
      if (sessionOverride?.model) {
        model = sessionOverride.model
        source = "房间覆盖"
      } else if (global[p]?.model) {
        model = global[p]?.model ?? ""
        source = "全局"
      } else if (thread?.currentModel) {
        model = thread.currentModel
        source = "默认"
      } else {
        model = "CLI 默认"
        source = ""
      }
      const effort = eff?.effort ? `｜强度 ${eff.effort}` : ""
      const sourceLabel = source ? `（${source}）` : ""
      return `- ${aliasOf(p)}（${p}）：${model}${sourceLabel}${effort}`
    })
  }

  private model(ctx: ChannelCommandContext, roomRef: string | null, action: ModelAction): string {
    // 目标房解析：R-号显式定位 > 当前对话 binding；都无 → 引导
    let groupId: string
    let label: string
    if (roomRef) {
      const room = this.deps.rooms
        .list()
        .find((r) => r.roomId != null && ROOM_REF_RE.test(r.roomId) && sameRoomRef(r.roomId, roomRef))
      if (!room) return `没找到 ${roomRef}。发 /rooms 看列表。`
      groupId = room.id
      label = `${room.roomId ?? ""}「${room.title}」`
    } else if (ctx.binding) {
      groupId = ctx.binding.sessionGroupId
      const room = this.deps.rooms.list().find((r) => r.id === groupId)
      label = room ? `${room.roomId ?? ""}「${room.title}」` : groupId
    } else {
      return "本对话还没选房间：/switch R-号 或 /newroom 房间名；或用 /model R-号 … 指定房间。"
    }

    if (action.type === "show") {
      return [`${label} 模型（生效值）：`, ...this.modelLines(groupId)].join("\n")
    }

    const resolved = resolveMentionTarget(action.agent)
    if (!resolved.ok) return resolved.error
    const provider = providerOfAlias(resolved.alias)
    if (!provider) return `内部错误：花名 ${resolved.alias} 找不到 provider。`

    if (action.type === "show-agent") {
      return [`${label} 模型（生效值）：`, ...this.modelLines(groupId, provider)].join("\n")
    }

    if (action.type === "clear") {
      // model/effort 双清但保 contextWindow/sealPct（网页设的字段不被手机一刀清）；
      // pending 同步清——否则 flush 把排队中的旧覆盖复活。
      this.deps.runtimeConfig.setSession(
        groupId,
        stripModelFields(this.deps.runtimeConfig.getSession(groupId), provider),
      )
      this.deps.runtimeConfig.setPending(
        groupId,
        stripModelFields(this.deps.runtimeConfig.getPending(groupId), provider),
      )
      return `已还原 ${label} ${resolved.alias}（${provider}）为全局设置（房间级模型/强度覆盖已清）。`
    }

    // set：双闸（格式闸 + validateSessionRuntimeConfigInput 全套）
    if (!isValidModelId(action.model)) {
      return "型号格式不对：只收字母数字开头、≤64 位的 [A-Za-z0-9._:/-]（如 gpt-5.4 / claude-opus-4-6）。"
    }
    if (action.effort !== undefined) {
      const allowed = MODEL_CATALOG[provider].efforts
      if (allowed.length === 0) {
        return `${resolved.alias}（${provider}）不支持推理强度——去掉强度参数再试。`
      }
      if (!allowed.includes(action.effort)) {
        return `强度只能是：${allowed.join(" / ")}（${provider}）。`
      }
    }
    const suffix = action.effort ? `｜强度 ${action.effort}` : ""
    const busyNow = this.deps.isBusy(groupId, provider)
    const layer = busyNow
      ? this.deps.runtimeConfig.getPending(groupId)
      : this.deps.runtimeConfig.getSession(groupId)
    const entry = {
      ...((layer[provider] as Record<string, unknown> | undefined) ?? {}),
      model: action.model,
      ...(action.effort ? { effort: action.effort } : {}),
    }
    const next = { ...layer, [provider]: entry }
    const errors = validateSessionRuntimeConfigInput(next)
    if (errors.length > 0) return `配置校验没过：${errors.join("；")}`
    if (busyNow) {
      // F021 3.3 运行守卫同语义：pending 在下一次派发 flush 进 active。
      // configSnapshot 派发时冻结——写哪层正确性等价，pending 只是归档语义。
      this.deps.runtimeConfig.setPending(groupId, next)
      return `已排队：${label} ${resolved.alias}（${provider}）→ ${action.model}${suffix}（该 agent 正在运行，下轮对话生效）。`
    }
    this.deps.runtimeConfig.setSession(groupId, next)
    // 同字段清 pending：防下一次 flush 把 stale pending 倒灌盖掉刚设的值
    // （只清我写过的字段——pending 里其他字段是早先有意排队的变更，保留照常 flush）
    const pending = this.deps.runtimeConfig.getPending(groupId)
    const pendingEntry = { ...((pending[provider] as Record<string, unknown> | undefined) ?? {}) }
    delete pendingEntry.model
    if (action.effort !== undefined) delete pendingEntry.effort
    this.deps.runtimeConfig.setPending(groupId, { ...pending, [provider]: pendingEntry })
    return `已设置：${label} ${resolved.alias}（${provider}）→ ${action.model}${suffix}（已生效）。`
  }
}

/** clear 用：剥掉某 agent 的 model/effort，别的字段原样；剥空则整项移除 */
function stripModelFields(
  cfg: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  const entry = { ...((cfg[provider] as Record<string, unknown> | undefined) ?? {}) }
  delete entry.model
  delete entry.effort
  const next = { ...cfg }
  if (Object.keys(entry).length > 0) next[provider] = entry
  else delete next[provider]
  return next
}
