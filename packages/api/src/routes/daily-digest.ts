import fs from "node:fs"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import { loadRuntimeConfig, saveRuntimeConfig } from "../runtime/runtime-config"
import type { ReconcileOutcome } from "../services/daily-digest/daily-digest-job"
import {
  digestEnvSeeds,
  resolveEffectiveDigestSettings,
  validateDigestSettings,
} from "../services/daily-digest/digest-settings"
import { sourceLabel } from "../services/daily-digest/source-labels"
import { listAllSourceMeta } from "../services/daily-digest/sources/registry"

/**
 * F037 网页版日报端点（小孙 07-05 分栏改版 #2 + §5 设置页）。
 * - 归档读取面：数据源 = daily-digest job 的归档目录（summary.json + items.jsonl），
 *   零重抓零重算；归档天然也是 F029 语料库，这两个端点同样是 F029 的读取面。
 * - 设置面：runtime-config `dailyDigest` 段的 GET/PUT（字段级覆盖 .env 种子，热生效）；
 *   secrets 永不下发——只出「已配置」布尔。
 * - 立即补发：force reconcile（与 scheduler 共享同一实例，进程内互斥不许旁路）。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface DailyDigestRoutesOpts {
  /** 归档根，默认 <cwd>/.runtime/daily-digest（与 scheduler-bootstrap rootDir 约定一致） */
  baseDir?: string
  /** 立即补发入口：**必须**是 scheduler 同一 bootDailyDigest 实例（server.ts 统一持有） */
  runtime?: {
    reconcile: (now: Date, opts?: { force?: boolean }) => Promise<ReconcileOutcome>
  }
  /** isDigestEnabled(process.env)；未启用时 send-now 503（设置面照常可用） */
  enabled?: boolean
  /** 测试注入 */
  env?: NodeJS.ProcessEnv
}

type SendNowOutcome = (ReconcileOutcome | { status: "error"; detail: string }) & {
  startedAt: string
  finishedAt: string
}

function listDates(baseDir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && DATE_RE.test(e.name))
    .filter((e) => {
      const day = path.join(baseDir, e.name)
      return (
        fs.existsSync(path.join(day, "summary.json")) ||
        fs.existsSync(path.join(day, "items.jsonl"))
      )
    })
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, 90)
}

function readJsonl(file: string): unknown[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  const out: unknown[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      // 单行损坏跳过，不拖垮整天数据
    }
  }
  return out
}

export function registerDailyDigestRoutes(app: FastifyInstance, opts: DailyDigestRoutesOpts = {}) {
  const baseDir = opts.baseDir ?? path.join(process.cwd(), ".runtime", "daily-digest")
  const routeEnv = () => opts.env ?? process.env

  app.get("/api/daily-digest/dates", async () => ({ dates: listDates(baseDir) }))

  // ---- 设置面（§5：模型/收件人/X 账号/小红书关键词/逐源开关/发送时间/邮件密度）----
  app.get("/api/daily-digest/settings", async () => {
    const env = routeEnv()
    const stored = loadRuntimeConfig().dailyDigest ?? null
    return {
      enabled: opts.enabled ?? false,
      stored,
      effective: resolveEffectiveDigestSettings(env, stored ?? undefined),
      // 纯 .env 基线（stored=∅ 的生效值）：前端「与默认相同的字段不落存储」的 diff 基准，
      // 免得前端复刻内置默认常量
      seedEffective: resolveEffectiveDigestSettings(env, undefined),
      envSeeds: digestEnvSeeds(env),
      // secrets 只出布尔（Iron Law §3：值是人工件，前端只显示已配置/未配置）
      secrets: {
        smtp: Boolean(env.MULTI_AGENT_DIGEST_SMTP_USER && env.MULTI_AGENT_DIGEST_SMTP_PASS),
        githubPat: Boolean(env.MULTI_AGENT_DIGEST_GITHUB_PAT),
        xApiKey: Boolean(env.MULTI_AGENT_DIGEST_X_API_KEY),
        rsshubBase: Boolean(env.MULTI_AGENT_DIGEST_RSSHUB_BASE),
        xhsBase: Boolean(env.MULTI_AGENT_DIGEST_XHS_MCP_BASE),
      },
      sources: listAllSourceMeta().map((m) => ({ ...m, label: sourceLabel(m.id) })),
    }
  })

  app.put("/api/daily-digest/settings", async (request, reply) => {
    const body = request.body as { settings?: unknown } | null
    if (!body || typeof body !== "object" || body.settings === undefined) {
      reply.code(400)
      return { error: "Body must include { settings: {...} } (null = 清空回落 .env)." }
    }
    // settings: null → 显式清空整段（全回落 .env 种子/默认）
    if (body.settings !== null) {
      const errors = validateDigestSettings(body.settings)
      if (errors.length > 0) {
        reply.code(400)
        return { error: "Invalid dailyDigest settings.", errors }
      }
    }
    try {
      // 段级 RMW：只动 dailyDigest 段，agent/wikiCompile 段原样带回（save 内 sanitize 兜底）
      const cfg = loadRuntimeConfig()
      if (body.settings === null) {
        cfg.dailyDigest = undefined
      } else {
        cfg.dailyDigest = body.settings as typeof cfg.dailyDigest
      }
      saveRuntimeConfig(cfg)
    } catch (error) {
      reply.code(500)
      return { error: `Failed to save digest settings: ${(error as Error).message}` }
    }
    const env = routeEnv()
    const stored = loadRuntimeConfig().dailyDigest ?? null
    return {
      ok: true,
      stored,
      effective: resolveEffectiveDigestSettings(env, stored ?? undefined),
    }
  })

  // ---- 立即补发（§5 按钮）：force reconcile 后台跑，前端轮询状态 ----
  let inFlight: { startedAt: string } | null = null
  let lastOutcome: SendNowOutcome | null = null

  app.post("/api/daily-digest/send-now", async (request, reply) => {
    if (!opts.runtime) {
      reply.code(503)
      return {
        error: "日报未启用（SMTP 凭证未配置且未设 MULTI_AGENT_DIGEST_ENABLED=1），无法补发",
      }
    }
    if (inFlight) {
      reply.code(409)
      return { error: "已有一次补发在进行中", startedAt: inFlight.startedAt }
    }
    const startedAt = new Date().toISOString()
    inFlight = { startedAt }
    // 管道要跑几分钟（33 账号限速 + LLM），不占住 HTTP —— 202 + 轮询 GET
    opts.runtime
      .reconcile(new Date(), { force: true })
      .then(
        (o) => {
          lastOutcome = { ...o, startedAt, finishedAt: new Date().toISOString() }
        },
        (err) => {
          lastOutcome = {
            status: "error",
            detail: String(err).slice(0, 300),
            startedAt,
            finishedAt: new Date().toISOString(),
          }
        },
      )
      .finally(() => {
        inFlight = null
      })
    reply.code(202)
    return { started: true, startedAt }
  })

  app.get("/api/daily-digest/send-now", async () => ({
    running: Boolean(inFlight),
    startedAt: inFlight?.startedAt ?? null,
    lastOutcome,
  }))

  app.get("/api/daily-digest/:date", async (request, reply) => {
    const { date } = request.params as { date: string }
    // 路径守卫：严格日期形状才可能拼进 path（防遍历）
    if (!DATE_RE.test(date)) {
      reply.code(400)
      return { error: "date must be YYYY-MM-DD" }
    }
    const dayDir = path.join(baseDir, date)
    const summaryPath = path.join(dayDir, "summary.json")
    const itemsPath = path.join(dayDir, "items.jsonl")
    if (!fs.existsSync(summaryPath) && !fs.existsSync(itemsPath)) {
      reply.code(404)
      return { error: `no digest archive for ${date}` }
    }
    let summaryDoc: unknown = null
    try {
      summaryDoc = JSON.parse(fs.readFileSync(summaryPath, "utf8"))
    } catch {
      // 旧归档（改版前）没有 summary.json：items 照常给，前端降级为纯条目视图
    }
    const items = readJsonl(itemsPath)
    // 中文源名随包下发（真相源在 api 侧 source-labels，前端零重复维护）
    const labels: Record<string, string> = {}
    for (const it of items) {
      const sid = (it as { sourceId?: unknown }).sourceId
      if (typeof sid === "string" && !(sid in labels)) labels[sid] = sourceLabel(sid)
    }
    return { businessDate: date, summary: summaryDoc, items, labels }
  })
}
