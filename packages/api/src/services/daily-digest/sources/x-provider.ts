import { isMondayInTz } from "../business-dates"
import { buildNormalizedItem, parseRssOrAtom } from "../feed-parsers"
import type { DigestSource, NormalizedItem, SafeHttpClient } from "../types"
import { type PacingOptions, forEachPaced, resolvePacing } from "./pacing"
import { xHandleGroup } from "./x-handle-groups"

/** 分栏改版（07-05）：按账号挂「公司/从业者」结构标签；清单外账号不挂（渲染落「更多动态」） */
function withXGroup(item: NormalizedItem, handle: string): NormalizedItem {
  const group = xHandleGroup(handle)
  return group ? { ...item, topicTag: group } : item
}

/**
 * AC15 X/Twitter 一手动态直采 · 供应商抽象层（Phase 2）。
 *
 * 两条数据路（小孙 2026-07-03 拍 cookie 小号路线为主）：
 * 1. **rsshub**（免费，主路线）：自建 RSSHub 配小号 TWITTER_AUTH_TOKEN cookie →
 *    `/twitter/user/:handle` RSS 路由（last30days/Agent-Reach 同款 cookie 姿势；
 *    有封号风险，须专用小号——小孙人工件）。
 * 2. **twitterapi-io**（按量 ~$1-3/月，备选）：配 MULTI_AGENT_DIGEST_X_API_KEY 时优先。
 *    响应字段按其公开文档骨架实现，**未活测**（无 key）——配 key 后首跑挂 smoke 校字段。
 *
 * **默认 disabled**：无 handles（或两条路的凭证都缺）则 boot 不注册本源。
 * X 兜底信号始终有 smol.ai 544 账号 recap（D4）。
 */

export interface XProvider {
  readonly providerId: string
  /** 限速遍历的整源时间预算（makeXSource 用它抬高 orchestrator 单源预算，默认 45s 会掐死长跑源） */
  readonly maxTotalMs?: number
  /** 拉一批账号最近 tweets → NormalizedItem[]；单账号失败跳过不抛 */
  fetchHandles(
    handles: string[],
    ctx: {
      http: SafeHttpClient
      httpDirect?: SafeHttpClient
      now: () => Date
      signal?: AbortSignal
    },
  ): Promise<NormalizedItem[]>
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
/** 严格 plain object 判定（德彪 sixq-r1 P2-2：asRecord 的宽松折算会让错型字段走 String() 变 "[object Object]"） */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * 转推识别（小孙 07-11 二拍：转推**不滤**——有价值就该进报，但归属要如实、链接落原帖）。
 * 前缀形态两路线实测/文档口径——RSSHub title=`RT <显示名>: …`（07-11 本机 sama feed
 * 实锤）；twitterapi-io text=`RT @handle: …`。
 */
export function isRetweetText(s: string): boolean {
  return s.startsWith("RT ")
}

/**
 * X 条目标题：转推改写成「@转推者 转推 原作者: 原文」——不伪装成转推者本人的话。
 * RSSHub 只给原作者**显示名**（无 handle/原推 id，07-11 实测 description 亦无原帖 URL），
 * 链接维持转推 status URL：X 纯转推没有独立页面，登录态浏览器访问会自动落到原帖；
 * api 路线拿得到原推对象时直接换原帖 URL（见 createTwitterApiIoProvider）。
 */
export function xHeadline(handle: string, rawTitle: string): string {
  const rt = rawTitle.match(/^RT ([^:]{1,60}): /)
  const body = rt ? rawTitle.slice(rt[0].length) : rawTitle
  const prefix = rt ? `@${handle} 转推 ${rt[1]}: ` : `@${handle}: `
  return `${prefix}${body.slice(0, 100)}${body.length > 100 ? "…" : ""}`
}

// B 项（小孙 07-04「不能慢点去 RSS 吗，防止封号」）：逐账号限速遍历 —— 共用件抽至 ./pacing
// （07-05 reddit-shreddit 复用同款纪律；F029 批量取证亦然）

export interface TwitterApiIoOptions {
  apiKey: string
  /** 每账号取最近 N 条，默认 10 */
  perHandle?: number
  pacing?: PacingOptions
  /** 部分账号失败的观测口（德彪 batchA-r1 P2：只剩 1 条也算 ok，退化不可见） */
  log?: (msg: string) => void
}

/** 按量 API 是自家 key，不担心封号 —— 轻限速只为礼貌（防 429） */
const API_PACING_DEFAULTS = { delayMs: 250, jitterMs: 250, maxTotalMs: 240_000 }

function xLookbackMs(now: Date): number {
  return (isMondayInTz(now) ? 72 : 24) * 3600_000
}

/** TwitterAPI.io 按量供应商（$0.00015/read 档，2026-07 调研价） */
export function createTwitterApiIoProvider(opts: TwitterApiIoOptions): XProvider {
  const perHandle = opts.perHandle ?? 10
  const pacing = resolvePacing(opts.pacing, API_PACING_DEFAULTS)
  return {
    providerId: "twitterapi-io",
    maxTotalMs: pacing.maxTotalMs,
    async fetchHandles(handles, ctx) {
      const out: NormalizedItem[] = []
      const now = ctx.now()
      const cutoff = now.getTime() - xLookbackMs(now)
      const tally = createHandleFailureTally()
      await forEachPaced(handles, pacing, ctx.signal, async (handle) => {
        tally.attempted++
        try {
          const body = await ctx.http.fetchText(
            `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(handle)}&count=${perHandle}`,
            { headers: { "x-api-key": opts.apiKey } },
          )
          const j = asRecord(JSON.parse(body))
          const tweets = asArray(j.tweets ?? asRecord(j.data).tweets)
          for (const t of tweets) {
            const rec = asRecord(t)
            const id = String(rec.id ?? rec.id_str ?? "")
            let text = String(rec.text ?? rec.fullText ?? "")
            if (!id || !text) continue
            const createdAt =
              typeof rec.createdAt === "string" ? Date.parse(rec.createdAt) : Number.NaN
            if (!Number.isNaN(createdAt) && createdAt < cutoff) continue // 只要近 24h
            let url = String(rec.url ?? `https://x.com/${handle}/status/${id}`)
            let headline = xHeadline(handle, text)
            // 转推带原推对象（TwitterAPI.io 文档字段 retweeted_tweet，官方未锁结构）：
            // 链接直接换**原帖** URL、正文换原推全文（RT text 是 140 截断），标题双向归属。
            // fail-closed 类型检查（德彪 sixq-r1 P2-2：错型走 String() 会产
            // `x.com/[object Object]/…` 伪链接）：三字段必须是字符串且 handle/id 形态
            // 合法，任一不过回落 xHeadline + 转推 status URL（登录态自动落原帖，同 rsshub）
            if (isRetweetText(text)) {
              const rtRaw = rec.retweeted_tweet ?? rec.retweetedTweet
              const rtObj = isPlainRecord(rtRaw) ? rtRaw : {}
              const rtAuthor = isPlainRecord(rtObj.author) ? rtObj.author : {}
              const rtUser = asString(rtAuthor.userName) || asString(rtAuthor.screen_name)
              const rtId = asString(rtObj.id) || asString(rtObj.id_str)
              const rtText = asString(rtObj.text) || asString(rtObj.fullText)
              if (/^[A-Za-z0-9_]{1,15}$/.test(rtUser) && /^\d+$/.test(rtId) && rtText) {
                url = `https://x.com/${rtUser}/status/${rtId}`
                text = rtText
                headline = `@${handle} 转推 @${rtUser}: ${rtText.slice(0, 100)}${rtText.length > 100 ? "…" : ""}`
              }
            }
            out.push(
              withXGroup(
                buildNormalizedItem(
                  "x-firsthand",
                  "community",
                  headline,
                  url,
                  Number.isNaN(createdAt) ? null : new Date(createdAt).toISOString(),
                  text,
                ),
                handle,
              ),
            )
          }
        } catch (err) {
          // 单账号失败跳过（per-author 隔离）；退化观测走 tally（部分→log，全灭→抛）
          tally.record(handle, err)
        }
      })
      tally.settle("twitterapi-io", opts.log)
      return out
    },
  }
}

export interface RsshubXOptions {
  /** 自建 RSSHub base（MULTI_AGENT_DIGEST_RSSHUB_BASE，已是 SafeHttpClient 信任锚） */
  rsshubBase: string
  pacing?: PacingOptions
  /** 部分账号失败的观测口（德彪 batchA-r1 P2） */
  log?: (msg: string) => void
}

/**
 * cookie 小号路线限速默认（B 项防封号）：账号间 4-7s 抖动 ≈ 人翻主页的速度；
 * 整源预算 8 分钟（30 账号 × 冷缓存 ~15s + 延时也兜得住大半，超时返回已得）。
 */
const RSSHUB_PACING_DEFAULTS = { delayMs: 4000, jitterMs: 3000, maxTotalMs: 480_000 }

function isLoopbackRsshubBase(base: string): boolean {
  try {
    const hostname = new URL(base).hostname.toLowerCase().replace(/\.$/, "")
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
      hostname === "::1" ||
      hostname === "[::1]"
    )
  } catch {
    return false
  }
}

/**
 * cookie 小号路线（小孙 2026-07-03 拍板）：自建 RSSHub `/twitter/user/:handle` RSS 路由。
 * 实例侧须配 TWITTER_AUTH_TOKEN（小号 cookie，人工件）；本 provider 只消费 RSS，
 * cookie 永不经过本进程。通常只取近 24h；周一回看 72h 供周末合辑使用；无日期条目保守保留。
 */
export function createRsshubXProvider(opts: RsshubXOptions): XProvider {
  const base = opts.rsshubBase.replace(/\/$/, "")
  const preferDirect = isLoopbackRsshubBase(base)
  const pacing = resolvePacing(opts.pacing, RSSHUB_PACING_DEFAULTS)
  return {
    providerId: "rsshub-twitter",
    maxTotalMs: pacing.maxTotalMs,
    async fetchHandles(handles, ctx) {
      const out: NormalizedItem[] = []
      const now = ctx.now()
      const cutoff = now.getTime() - xLookbackMs(now)
      const tally = createHandleFailureTally()
      // 显式 loopback RSSHub 必须复用 orchestrator 的直连 client：全局 ProxyAgent 不消费
      // NO_PROXY。远端自建 RSSHub 保持原代理通道，避免破坏只能经代理访问的配置。
      const http = preferDirect && ctx.httpDirect ? ctx.httpDirect : ctx.http
      await forEachPaced(handles, pacing, ctx.signal, async (handle) => {
        tally.attempted++
        try {
          const body = await http.fetchText(`${base}/twitter/user/${encodeURIComponent(handle)}`)
          for (const item of parseRssOrAtom(body, "x-firsthand", "community")) {
            const ts = item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN
            if (!Number.isNaN(ts) && ts < cutoff) continue
            out.push(
              withXGroup(
                buildNormalizedItem(
                  "x-firsthand",
                  "community",
                  // 转推标题如实归属（xHeadline）；链接=feed 给的转推 status URL，
                  // X 登录态访问自动落原帖（RSSHub 不给原推 id，无法直构原帖链接）
                  xHeadline(handle, item.title),
                  item.canonicalUrl,
                  item.publishedAt,
                  item.rawSnippet,
                ),
                handle,
              ),
            )
          }
        } catch (err) {
          // 单账号失败跳过（per-author 隔离）；退化观测走 tally（部分→log，全灭→抛）
          tally.record(handle, err)
        }
      })
      tally.settle("rsshub-twitter", opts.log)
      return out
    },
  }
}

/**
 * 德彪 batchA-r1 P2：逐账号 catch 会把大面积失败吞成「ok + 少量条目」，X 覆盖率退化
 * 对健康/告警链完全隐身。口径：部分失败 → log 一行（比例 + 首个错误）；已尝试账号
 * **全灭** → 抛错让 orchestrator 记 failed（进 health/连续失败告警）。安静账号
 * （抓取成功但 24h 无推文）不算失败——只有异常才计入。
 */
function createHandleFailureTally() {
  const failed: string[] = []
  let firstErr = ""
  return {
    attempted: 0,
    record(handle: string, err: unknown) {
      if (failed.length === 0) firstErr = String(err).slice(0, 120)
      failed.push(handle)
    },
    settle(providerId: string, log?: (msg: string) => void) {
      if (failed.length === 0) return
      const detail = `${failed.length}/${this.attempted} 账号抓取失败（首个 @${failed[0]}：${firstErr}）`
      if (failed.length >= this.attempted) {
        throw new Error(`${providerId}: 已尝试账号全灭 — ${detail}`)
      }
      log?.(`[x-firsthand] ${providerId} ${detail}`)
    },
  }
}

export interface XSourceConfig {
  provider: XProvider
  /** 关注账号清单（env MULTI_AGENT_DIGEST_X_HANDLES 逗号分隔，人工件） */
  handles: string[]
}

/** 组装成 DigestSource；handles 空 → 抛（boot 层应根本不注册） */
export function makeXSource(cfg: XSourceConfig): DigestSource {
  return {
    sourceId: "x-firsthand",
    category: "community",
    // 限速遍历天然长跑：源预算 = provider 预算 + 60s 余量（orchestrator 默认 45s 会掐死并整包丢弃）
    timeoutBudgetMs: (cfg.provider.maxTotalMs ?? 240_000) + 60_000,
    async fetch(ctx) {
      if (cfg.handles.length === 0) throw new Error("x-firsthand: no handles configured")
      const items = await cfg.provider.fetchHandles(cfg.handles, {
        http: ctx.http,
        httpDirect: ctx.httpDirect,
        now: ctx.now,
        signal: ctx.signal,
      })
      if (items.length === 0)
        throw new Error(
          `x-firsthand(${cfg.provider.providerId}): 0 tweets fetched（凭证失效/路由未开/字段变更？）`,
        )
      return items
    },
  }
}

export type XConfig =
  | { mode: "api"; apiKey: string; handles: string[] }
  | { mode: "rsshub"; handles: string[] }

/**
 * env 解析（人工件）：handles 必配；有 API key 优先 twitterapi-io，
 * 否则有自建 RSSHub base 走 cookie 路线；两条路都缺 → 不启用。
 */
export function resolveXConfig(env: NodeJS.ProcessEnv): XConfig | null {
  const handles = (env.MULTI_AGENT_DIGEST_X_HANDLES ?? "")
    .split(",")
    .map((h) => h.trim().replace(/^@/, ""))
    .filter(Boolean)
  if (handles.length === 0) return null
  const apiKey = env.MULTI_AGENT_DIGEST_X_API_KEY
  if (apiKey) return { mode: "api", apiKey, handles }
  if (env.MULTI_AGENT_DIGEST_RSSHUB_BASE) return { mode: "rsshub", handles }
  return null
}
