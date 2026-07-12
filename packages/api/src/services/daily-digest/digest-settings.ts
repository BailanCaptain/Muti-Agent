import { MODEL_ID_MAX_LEN, isValidModelId } from "../../runtime/model-id"
import { parseRecipients } from "../../lib/email-sender"

/**
 * F037 设置页 · 日报运行配置（小孙 07-05「把前端能配的都一起做了」）。
 *
 * 存储：runtime-config JSON 的 `dailyDigest` 段（wikiCompile 同款先例：全局专属段 +
 * validate 显式 400 + sanitize 存储层最后防线）。**语义 = 字段级覆盖 .env 种子**：
 * 字段缺省 → 回落 .env / 内置默认；字段存在 → 设置页真相。secrets（SMTP/PAT/X key/
 * sidecar base）永不进本段——那些是 Iron Law §3 人工件，设置页只显示已配置/未配置。
 *
 * 热生效：daily-digest-job 每轮 reconcile 开头经 runtimeSettings() 现读本段重建
 * 动态件（收件人/模型/源清单），改完设置下一轮（或点「立即补发」）即生效，不用重启。
 */
export interface DigestSettings {
  /** 摘要主力模型 id（自由输入过 model-id 格式闸；缺省 claude-opus-4-8） */
  primaryModel?: string
  /** 摘要兜底模型 id（缺省 claude-opus-4-7） */
  fallbackModel?: string
  /** 收件人（缺省回落 MULTI_AGENT_DIGEST_TO；显式空数组非法——要么给人要么删字段） */
  recipients?: string[]
  /** X 关注账号（缺省回落 MULTI_AGENT_DIGEST_X_HANDLES；空数组 = 显式关掉 X 源） */
  xHandles?: string[]
  /** 小红书搜索关键词（缺省回落 MULTI_AGENT_DIGEST_XHS_KEYWORDS；空数组 = 关） */
  xhsKeywords?: string[]
  /** 逐源开关：禁用的 sourceId 清单（默认全开） */
  disabledSources?: string[]
  /** 发送时间 "HH:mm"（默认 07:30；cron 触发点仍按 scheduler 配置，此值是 due 门） */
  sendTime?: string
  /** 邮件密度：每板块「其余速览」行数 0-30（默认 12；0 = 关掉速览区） */
  restOverviewRows?: number
}

/** 生效值（.env 种子 + 设置覆盖 折算后）——boot 每轮 reconcile 用它重建动态件 */
export interface EffectiveDigestSettings {
  primaryModel: string
  fallbackModel: string
  recipients: string[]
  xHandles: string[]
  xhsKeywords: string[]
  disabledSources: string[]
  sendTime: string
  restOverviewRows: number
}

export const DIGEST_DEFAULT_PRIMARY_MODEL = "claude-opus-4-8"
export const DIGEST_DEFAULT_FALLBACK_MODEL = "claude-opus-4-7"
export const DIGEST_DEFAULT_SEND_TIME = "07:30"
export const DIGEST_DEFAULT_REST_ROWS = 12
export const DIGEST_REST_ROWS_MAX = 30
const MAX_RECIPIENTS = 10
const MAX_HANDLES = 50
const MAX_KEYWORDS = 10
const MAX_KEYWORD_LEN = 30
const MAX_DISABLED = 100

const SETTING_KEYS: ReadonlySet<string> = new Set([
  "primaryModel",
  "fallbackModel",
  "recipients",
  "xHandles",
  "xhsKeywords",
  "disabledSources",
  "sendTime",
  "restOverviewRows",
])

/**
 * 收件人进 allowlist sender（fail-closed 边界）——严格 mailbox 字符集（德彪 batchB-r1 P1）：
 * allowlist 比对的是**原始字符串**，所以进清单的必须已是规范 mailbox——`<a@b.com>` /
 * `a@b.com;` / `a@b.com(comment)` / `"x"@b.com` 这类 RFC 花活会让 nodemailer 解析出的
 * 实际收件地址 ≠ allowlist 字符串，闭环即失效。宁拒不放（IDN/带引号 local part 一律拒；
 * .env 种子路径是人工件不经此闸）。
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
/** X handle：字母数字下划线 ≤15（平台规则），容忍前导 @（sanitize 剥掉） */
const X_HANDLE_RE = /^@?[A-Za-z0-9_]{1,15}$/
/** sourceId 形态（registry 约定小写-连字符） */
const SOURCE_ID_RE = /^[a-z0-9-]+$/
const SEND_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
/** 关键词进 MCP JSON body：禁控制字符即可（长度另限） */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 拦截控制字符正是本意
const CONTROL_RE = /[\u0000-\u001f\u007f]/

function normalizeHandle(h: string): string {
  return h.trim().replace(/^@/, "")
}

/**
 * API 入口显式校验（AC-29 姿势：非法给 400 带原因，不静默丢）。
 * PUT 语义 = 整段替换：body 里没有的字段即「回落 .env/默认」。
 */
export function validateDigestSettings(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return ["dailyDigest: must be a plain object"]
  }
  const errors: string[] = []
  const rec = input as Record<string, unknown>
  for (const key of Object.keys(rec)) {
    if (!SETTING_KEYS.has(key)) errors.push(`dailyDigest.${key}: unknown field`)
  }
  for (const field of ["primaryModel", "fallbackModel"] as const) {
    const v = rec[field]
    if (v === undefined) continue
    if (typeof v !== "string" || !isValidModelId(v)) {
      errors.push(
        `dailyDigest.${field}: must be a model id (≤${MODEL_ID_MAX_LEN} chars, [A-Za-z0-9._:/-], 字母数字开头)`,
      )
    }
  }
  const recips = rec.recipients
  if (recips !== undefined) {
    if (!Array.isArray(recips) || recips.length === 0) {
      errors.push("dailyDigest.recipients: 至少一个收件人（要回落 .env 请删掉该字段）")
    } else if (recips.length > MAX_RECIPIENTS) {
      errors.push(`dailyDigest.recipients: 最多 ${MAX_RECIPIENTS} 个`)
    } else {
      for (const r of recips) {
        if (typeof r !== "string" || !EMAIL_RE.test(r.trim())) {
          errors.push(`dailyDigest.recipients: 非法邮箱 ${JSON.stringify(r).slice(0, 60)}`)
          break
        }
      }
    }
  }
  const handles = rec.xHandles
  if (handles !== undefined) {
    if (!Array.isArray(handles)) {
      errors.push("dailyDigest.xHandles: must be an array")
    } else if (handles.length > MAX_HANDLES) {
      errors.push(`dailyDigest.xHandles: 最多 ${MAX_HANDLES} 个账号`)
    } else {
      for (const h of handles) {
        if (typeof h !== "string" || !X_HANDLE_RE.test(h.trim())) {
          errors.push(`dailyDigest.xHandles: 非法 handle ${JSON.stringify(h).slice(0, 40)}`)
          break
        }
      }
    }
  }
  const keywords = rec.xhsKeywords
  if (keywords !== undefined) {
    if (!Array.isArray(keywords)) {
      errors.push("dailyDigest.xhsKeywords: must be an array")
    } else if (keywords.length > MAX_KEYWORDS) {
      errors.push(`dailyDigest.xhsKeywords: 最多 ${MAX_KEYWORDS} 个关键词`)
    } else {
      for (const k of keywords) {
        if (
          typeof k !== "string" ||
          k.trim().length === 0 ||
          k.trim().length > MAX_KEYWORD_LEN ||
          CONTROL_RE.test(k)
        ) {
          errors.push(`dailyDigest.xhsKeywords: 非法关键词 ${JSON.stringify(k).slice(0, 40)}`)
          break
        }
      }
    }
  }
  const disabled = rec.disabledSources
  if (disabled !== undefined) {
    if (!Array.isArray(disabled) || disabled.length > MAX_DISABLED) {
      errors.push(`dailyDigest.disabledSources: must be an array (≤${MAX_DISABLED})`)
    } else {
      for (const d of disabled) {
        if (typeof d !== "string" || !SOURCE_ID_RE.test(d)) {
          errors.push(
            `dailyDigest.disabledSources: 非法 sourceId ${JSON.stringify(d).slice(0, 40)}`,
          )
          break
        }
      }
    }
  }
  if (rec.sendTime !== undefined) {
    if (typeof rec.sendTime !== "string" || !SEND_TIME_RE.test(rec.sendTime)) {
      errors.push('dailyDigest.sendTime: must be "HH:mm" (00:00-23:59)')
    }
  }
  if (rec.restOverviewRows !== undefined) {
    const v = rec.restOverviewRows
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > DIGEST_REST_ROWS_MAX) {
      errors.push(
        `dailyDigest.restOverviewRows: must be an integer in [0, ${DIGEST_REST_ROWS_MAX}]`,
      )
    }
  }
  return errors
}

/** 存储层最后防线（手改文件/历史脏数据）：非法字段/条目静默丢，全空返回 undefined */
export function sanitizeDigestSettings(input: unknown): DigestSettings | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const rec = input as Record<string, unknown>
  const out: DigestSettings = {}
  for (const field of ["primaryModel", "fallbackModel"] as const) {
    const v = rec[field]
    if (typeof v === "string" && isValidModelId(v)) out[field] = v.trim()
  }
  if (Array.isArray(rec.recipients)) {
    const list: string[] = []
    for (const r of rec.recipients) {
      if (typeof r !== "string") continue
      const addr = r.trim()
      if (EMAIL_RE.test(addr) && !list.includes(addr)) list.push(addr)
      if (list.length >= MAX_RECIPIENTS) break
    }
    if (list.length > 0) out.recipients = list
  }
  if (Array.isArray(rec.xHandles)) {
    const list: string[] = []
    for (const h of rec.xHandles) {
      if (typeof h !== "string" || !X_HANDLE_RE.test(h.trim())) continue
      const norm = normalizeHandle(h)
      if (!list.some((x) => x.toLowerCase() === norm.toLowerCase())) list.push(norm)
      if (list.length >= MAX_HANDLES) break
    }
    out.xHandles = list // 空数组有语义（显式关 X），保留
  }
  if (Array.isArray(rec.xhsKeywords)) {
    const list: string[] = []
    for (const k of rec.xhsKeywords) {
      if (typeof k !== "string") continue
      const kw = k.trim()
      if (kw.length === 0 || kw.length > MAX_KEYWORD_LEN || CONTROL_RE.test(kw)) continue
      if (!list.includes(kw)) list.push(kw)
      if (list.length >= MAX_KEYWORDS) break
    }
    out.xhsKeywords = list // 空数组有语义（显式关小红书），保留
  }
  if (Array.isArray(rec.disabledSources)) {
    const list: string[] = []
    for (const d of rec.disabledSources) {
      if (typeof d === "string" && SOURCE_ID_RE.test(d) && !list.includes(d)) list.push(d)
      if (list.length >= MAX_DISABLED) break
    }
    if (list.length > 0) out.disabledSources = list
  }
  if (typeof rec.sendTime === "string" && SEND_TIME_RE.test(rec.sendTime)) {
    out.sendTime = rec.sendTime
  }
  if (
    typeof rec.restOverviewRows === "number" &&
    Number.isInteger(rec.restOverviewRows) &&
    rec.restOverviewRows >= 0 &&
    rec.restOverviewRows <= DIGEST_REST_ROWS_MAX
  ) {
    out.restOverviewRows = rec.restOverviewRows
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** .env 里可被设置页覆盖的种子值（secrets 不在此——只出「已配置」布尔） */
export function digestEnvSeeds(env: NodeJS.ProcessEnv): {
  recipients: string[]
  xHandles: string[]
  xhsKeywords: string[]
} {
  return {
    recipients: parseRecipients(env.MULTI_AGENT_DIGEST_TO ?? ""),
    xHandles: (env.MULTI_AGENT_DIGEST_X_HANDLES ?? "")
      .split(",")
      .map(normalizeHandle)
      .filter(Boolean),
    xhsKeywords: (env.MULTI_AGENT_DIGEST_XHS_KEYWORDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

/** 字段级折算：设置字段存在 → 设置真相；缺省 → .env 种子 / 内置默认 */
export function resolveEffectiveDigestSettings(
  env: NodeJS.ProcessEnv,
  stored: DigestSettings | undefined,
): EffectiveDigestSettings {
  const seeds = digestEnvSeeds(env)
  return {
    primaryModel: stored?.primaryModel ?? DIGEST_DEFAULT_PRIMARY_MODEL,
    fallbackModel: stored?.fallbackModel ?? DIGEST_DEFAULT_FALLBACK_MODEL,
    recipients: stored?.recipients ?? seeds.recipients,
    xHandles: stored?.xHandles ?? seeds.xHandles,
    xhsKeywords: stored?.xhsKeywords ?? seeds.xhsKeywords,
    disabledSources: stored?.disabledSources ?? [],
    sendTime: stored?.sendTime ?? DIGEST_DEFAULT_SEND_TIME,
    restOverviewRows: stored?.restOverviewRows ?? DIGEST_DEFAULT_REST_ROWS,
  }
}
