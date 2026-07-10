import fs from "node:fs"

/**
 * F040 渠道网关 env 配置加载（AC1 前半 · D5 fail-closed）。
 * 不读全局 process.env —— 调用方注入（server boot 传 process.env，测试传字面量），
 * 本模块永不写任何配置（Iron Law §3：.env 只由小孙人工维护）。
 *
 * D17/D20 语义更新（Phase 2.5+）：白名单/群成员/群绑定四个授权域 env 变量降为
 * **首启种子**（对应表空时一次性导入 ChannelAdminStore，之后 DB 为真相源，管理页/
 * 命令面维护）；APP_ID/SECRET/BIND_SESSION_GROUP/DEFAULT_PROVIDER 仍是运行配置。
 */

/**
 * API 进程（tsx index.ts）不像 next dev 那样自动加载 .env，所以 FEISHU_* 变量填进 .env
 * 后进程内读不到。这里**只窄读 FEISHU_ 前缀**变量补进 env —— 故意不用 process.loadEnvFile()
 * 全量加载，否则会把 .env 里的 CORS_ORIGIN（严格单端口）读进来，破坏 worktree preview
 * 的任意端口跨域（config.ts:16 注释）。系统环境变量（processEnv）优先于 .env 文件。
 */
export function resolveFeishuEnv(
  processEnv: Record<string, string | undefined>,
  dotenvPath: string,
): Record<string, string | undefined> {
  let fromFile: Record<string, string> = {}
  try {
    fromFile = parseFeishuLines(fs.readFileSync(dotenvPath, "utf8"))
  } catch {
    // .env 不存在 / 读不了 → 只用 processEnv（disabled fail-closed 兜底）
  }
  return { ...fromFile, ...processEnv }
}

function parseFeishuLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    if (!key.startsWith("FEISHU_")) continue // 只碰飞书变量，零副作用
    let val = t.slice(eq + 1).trim()
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** 群成员（Phase 2 T1）：昵称由 owner 配置命名（归因用，非用户自报——注入面消失） */
export type GroupMember = { name: string; role: "owner" | "participant" }

export type FeishuChannelConfig =
  | {
      enabled: true
      appId: string
      appSecret: string
      /** open_id 白名单（≥1，D5：未配白名单 = connector 不启动） */
      allowedOpenIds: string[]
      /** bootstrap 播种用 sessionGroupId（运行时真相源在 SQLite binding，D3） */
      bindSessionGroup: string
      defaultProvider: string
      /** Phase 2 群白名单（D14）；空 = 群模式关，p2p 行为零变化 */
      allowedGroupChats: string[]
      /** Phase 2 成员白名单：open_id → {昵称, 角色}；owner = open_id ∈ allowedOpenIds */
      groupMembers: Record<string, GroupMember>
      /** Phase 2 群绑定 bootstrap 种子：chat_id → sessionGroupId（SQLite binding 仍是真相源） */
      groupBindings: Record<string, string>
      /** T4 fixture 校准：FEISHU_DEBUG_EVENTS=1 → 群事件 raw JSON 落日志（默认关） */
      debugEvents: boolean
    }
  | { enabled: false; reason: string }

const REQUIRED = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_ALLOWED_OPEN_IDS",
  "FEISHU_BIND_SESSION_GROUP",
] as const

export function loadFeishuChannelConfig(
  env: Record<string, string | undefined>,
): FeishuChannelConfig {
  for (const key of REQUIRED) {
    if (!env[key]?.trim()) {
      return { enabled: false, reason: `missing required env ${key}` }
    }
  }
  const allowedOpenIds = (env.FEISHU_ALLOWED_OPEN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (allowedOpenIds.length === 0) {
    return { enabled: false, reason: "FEISHU_ALLOWED_OPEN_IDS resolves to empty allowlist" }
  }

  // ---- Phase 2 群三元组（全部可缺省：缺省 = 群模式关，p2p 零变化）----
  const allowedGroupChats = (env.FEISHU_ALLOWED_GROUP_CHATS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // 成员白名单：open_id:昵称（首冒号切分，昵称可含冒号）；昵称由 owner 命名（归因用）
  const groupMembers: Record<string, GroupMember> = {}
  for (const entry of (env.FEISHU_GROUP_MEMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const i = entry.indexOf(":")
    const openId = i < 0 ? "" : entry.slice(0, i).trim()
    const name = i < 0 ? "" : entry.slice(i + 1).trim()
    if (!openId || !name) {
      return {
        enabled: false,
        reason: `FEISHU_GROUP_MEMBERS 条目格式错（${JSON.stringify(entry)}，应为 open_id:昵称）`,
      }
    }
    groupMembers[openId] = {
      name,
      role: allowedOpenIds.includes(openId) ? "owner" : "participant",
    }
  }

  // 群绑定种子：chat_id:sessionGroupId；缺种子不禁用（库内既有 binding 仍可用，运行时门兜底）
  const groupBindings: Record<string, string> = {}
  for (const entry of (env.FEISHU_GROUP_BINDINGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const i = entry.indexOf(":")
    const chatId = i < 0 ? "" : entry.slice(0, i).trim()
    const sg = i < 0 ? "" : entry.slice(i + 1).trim()
    if (!chatId || !sg) {
      return {
        enabled: false,
        reason: `FEISHU_GROUP_BINDINGS 条目格式错（${JSON.stringify(entry)}，应为 chat_id:sessionGroupId）`,
      }
    }
    groupBindings[chatId] = sg
  }

  return {
    enabled: true,
    appId: (env.FEISHU_APP_ID ?? "").trim(),
    appSecret: (env.FEISHU_APP_SECRET ?? "").trim(),
    allowedOpenIds,
    bindSessionGroup: (env.FEISHU_BIND_SESSION_GROUP ?? "").trim(),
    defaultProvider: env.FEISHU_DEFAULT_PROVIDER?.trim() || "claude",
    allowedGroupChats,
    groupMembers,
    groupBindings,
    debugEvents: env.FEISHU_DEBUG_EVENTS?.trim() === "1",
  }
}
