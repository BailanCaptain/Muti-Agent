import { formatBusinessDate, prevBusinessDate } from "../business-dates"
import { SafeHttpError } from "../../../net/safe-http-client"
import { buildNormalizedItem, parseRssOrAtom } from "../feed-parsers"
import { isTechTopicItem } from "../relevance-filter"
import type { DigestCategory, DigestSource, NormalizedItem, SourceFetchContext } from "../types"
import { enrichHnComments } from "./hn-comments"

/**
 * F037 表驱动源注册（唯一加源入口）。
 * 源清单 = docs/discussions/F037-daily-digest-sources-research.md 逐个实测验证过的 URL
 * （2026-07-02 调研 + 2026-07-03 fixture 抓取二次活体验证全通）。
 * urls 数组 = fallback 链：前一个失败/空结果自动试下一个（Agent-Reach 模式）。
 */

type UrlOrBuilder = string | ((now: Date) => string)

export interface FeedRetryPolicy {
  maxAttempts: 1 | 2
  delayMs: number
  retryHttpStatuses: readonly number[]
}

export interface RssSourceDef {
  sourceId: string
  category: DigestCategory
  urls: UrlOrBuilder[]
  headers?: Record<string, string>
  keepIf?: (item: NormalizedItem) => boolean
  /** RSSHub 路由（如 /hupu/nba）：配置了自建实例（AC13）时把自建 URL 前插到 fallback 链 */
  rsshubRoute?: string
  /** true = 优先直连不走代理（源对代理出口 IP 有反爬） */
  direct?: boolean
  /** 质量层 3："digest"=整期简报型源（标题无信息量，被选中后必须深读正文重写标题） */
  contentMode?: "digest"
  /** 仅幂等 GET feed 的显式受控重试；默认不重试，禁止扩散到其他源。 */
  retryPolicy?: FeedRetryPolicy
}

export interface RawJsonItem {
  title: string
  url: string
  publishedAt?: string | null
  snippet?: string
  /** 质量层 1：平台内互动量（points/upvotes/热度/回复数），只做同源内排序 */
  engagement?: number
}

export interface JsonSourceDef {
  sourceId: string
  category: DigestCategory
  urls: UrlOrBuilder[]
  headers?: Record<string, string>
  map: (json: unknown) => RawJsonItem[]
  keepIf?: (item: NormalizedItem) => boolean
  /** 质量层 3：同 RssSourceDef.contentMode（ai-hot 的 title/summary 已是条目级，暂无 JSON 源需要） */
  contentMode?: "digest"
  /**
   * #30 富化钩（07-05 P1）：keep 过滤后的条目做二次取数（如 HN 热评）。
   * 契约：**自兜错**——富化失败必须返回原 items，绝不把整源打挂；rawBody 是首个
   * 成功 URL 的原响应（可回读 map 丢掉的字段，如 objectID）。
   */
  enrich?: (
    items: NormalizedItem[],
    rawBody: string,
    ctx: SourceFetchContext,
  ) => Promise<NormalizedItem[]>
}

const AI_KEYWORDS =
  /(\bai\b|llm|gpt|claude|gemini|deepseek|qwen|mistral|llama|openai|anthropic|nvidia|inference|training|transformer|agent|model|vllm|sglang|cuda|gpu)/i

/** #28 YouTube 频道 Atom feed（channel_id 形态，无需 API key） */
const ytFeed = (channelId: string): string =>
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`

const YOUTUBE_FEED_RETRY_POLICY: FeedRetryPolicy = {
  maxAttempts: 2,
  delayMs: 750,
  retryHttpStatuses: [404, 408, 425, 429, 500, 502, 503, 504],
}

/**
 * #28 时效窗（视频/release 类低频源共用）：keepIf 无 now 注入（表驱动合同），此处用真时钟——
 * 测试用相对当前时刻构造 publishedAt 即可确定性通过。无日期保守保留（同 X provider 口径）。
 * 7 天：与 job 层 E1 新鲜窗同口径。旧值 72h 会让「发版超 3 天才加源/停跑几天」的 release
 * 永久漏报（实案：vllm-ascend v0.22.1rc1 07-02 发版，07-07 加源后一直窗外，小孙从未见过它）。
 * E1 之后重复回流由 shown 已见账本治（上过邮件即不再出现），窗口只管「多旧算旧」。
 */
export function withinRecentWindow(it: Pick<NormalizedItem, "publishedAt">): boolean {
  if (!it.publishedAt) return true
  const ts = Date.parse(it.publishedAt)
  return Number.isNaN(ts) || ts >= Date.now() - 7 * 24 * 3600_000
}

/** RSSHub 公共实例 fallback 链（rsshub.app 已废；自建实例经 env 注入后由 job 层前插，见 AC13） */
export const RSSHUB_INSTANCES = ["https://rsshub.rssforever.com", "https://rsshub.ktachibana.party"]

const rsshub = (route: string): string[] => RSSHUB_INSTANCES.map((base) => `${base}${route}`)

export const RSS_SOURCES: RssSourceDef[] = [
  // ---- AI（AC3）----
  // contentMode:digest —— 34.7% 期数标题是 "not much happened today"（反炒作品牌），价值全在正文
  {
    sourceId: "smol-ai",
    category: "ai",
    urls: ["https://news.smol.ai/rss.xml"],
    contentMode: "digest",
  },
  { sourceId: "openai-news", category: "ai", urls: ["https://openai.com/news/rss.xml"] },
  { sourceId: "deepmind-blog", category: "ai", urls: ["https://deepmind.google/blog/rss.xml"] },
  { sourceId: "mistral-blog", category: "ai", urls: ["https://mistral.ai/rss.xml"] },
  {
    sourceId: "anthropic-news",
    category: "ai",
    urls: [
      "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml",
    ],
  },
  {
    sourceId: "meta-ai-blog",
    category: "ai",
    urls: ["https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_meta_ai.xml"],
  },
  { sourceId: "vllm-blog", category: "ai", urls: ["https://vllm.ai/blog/rss.xml"] },
  {
    sourceId: "sglang-releases",
    category: "ai",
    urls: ["https://github.com/sgl-project/sglang/releases.atom"],
    keepIf: (it) => !/nightly/i.test(it.title),
  },
  // ---- NPU 推理（小孙 07-06 点名「我是 NPU 推理的」）：vLLM 主仓 + 昇腾插件 release 动态。
  // releases.atom 零 auth；7 天窗内的 release 都是候选，上过邮件由 shown 账本压重
  {
    sourceId: "vllm-releases",
    category: "ai",
    urls: ["https://github.com/vllm-project/vllm/releases.atom"],
    keepIf: withinRecentWindow,
  },
  {
    sourceId: "vllm-ascend-releases",
    category: "ai",
    urls: ["https://github.com/vllm-project/vllm-ascend/releases.atom"],
    keepIf: withinRecentWindow,
  },
  {
    sourceId: "hf-blog",
    category: "ai",
    urls: ["https://huggingface.co/blog/feed.xml"],
    keepIf: (it) => AI_KEYWORDS.test(`${it.title} ${it.rawSnippet}`),
  },
  // ---- 主表 v2.1 P0 扩源（07-05 实测 200 真 RSS）----
  { sourceId: "google-ai-blog", category: "ai", urls: ["https://blog.google/technology/ai/rss/"] },
  { sourceId: "qwen-blog", category: "ai", urls: ["https://qwenlm.github.io/blog/index.xml"] },
  {
    // #24 Techmeme：英文科技头条人工策展；river 含并购/政策等泛科技 → AI 关键词过滤保持纯粹（D15）
    sourceId: "techmeme",
    category: "ai",
    urls: ["https://www.techmeme.com/feed.xml"],
    keepIf: (it) => AI_KEYWORDS.test(`${it.title} ${it.rawSnippet}`),
  },
  // ---- #28 YouTube AI 频道（P1，小孙 07-05「后置件往前提」；六频道 ID 逐个 curl 实测
  // 200 + 标题核对）。频道以周更为主：7 天时效窗滤旧片，回流由 shown 账本压重 ----
  {
    sourceId: "yt-two-minute-papers",
    category: "ai",
    urls: [ytFeed("UCbfYPyITQ-7l4upoX8nvctg")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-lex-fridman",
    category: "ai",
    urls: [ytFeed("UCSHZKyawb77ixDdsGog4iWA")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-3blue1brown",
    category: "ai",
    urls: [ytFeed("UCYO_jab_esuFRV4b17AJtAw")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-fireship",
    category: "ai",
    urls: [ytFeed("UCsBjURrPoezykLs9EqgamOA")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-ai-explained",
    category: "ai",
    urls: [ytFeed("UCNJ1Ymd5yFuUPtn21xtRbbw")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-karpathy",
    category: "ai",
    urls: [ytFeed("UCXUPKJO5MZQN11PqgIvyuvQ")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  // ---- 07-11 扩六频道（小孙「AI 领域影响大的」；channel_id 逐个页面源码抠 + feed
  // 实测 200 + 标题核对。坑：@Anthropic 是路人 Matt Gregory，官方=@anthropic-ai——
  // 与 X 裸 claude=路人同款坑，官方 handle 必验活）----
  {
    sourceId: "yt-dwarkesh",
    category: "ai",
    urls: [ytFeed("UCXl4i9dYBrFOabk0xGmbkRA")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-yannic-kilcher",
    category: "ai",
    urls: [ytFeed("UCZHmQk67mSJgfCCTn7xBfew")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-mlst",
    category: "ai",
    urls: [ytFeed("UCMLtBahI5DMrt0NPvDSoIRQ")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-openai",
    category: "ai",
    urls: [ytFeed("UCXZCJLdBC09xxGZ6gcdrc6A")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-anthropic",
    category: "ai",
    urls: [ytFeed("UCrDwWp7EBBv4NwvScIpBDOA")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  {
    sourceId: "yt-deepmind",
    category: "ai",
    urls: [ytFeed("UCP7jMXSY2xbc3KCAE0MHQ-A")],
    keepIf: withinRecentWindow,
    retryPolicy: YOUTUBE_FEED_RETRY_POLICY,
  },
  // ---- 热点（AC4）----
  {
    sourceId: "bbc-zhongwen",
    category: "hot",
    urls: ["https://feeds.bbci.co.uk/zhongwen/simp/rss.xml"],
  },
  // AC13：澎湃精选（调研实测多公共实例 200）
  {
    sourceId: "thepaper",
    category: "hot",
    urls: rsshub("/thepaper/featured"),
    rsshubRoute: "/thepaper/featured",
  },
]
// 篮球/电竞/股市源已删（2026-07-03 小孙拍板「纯粹一点」）；ESPN/HLTV 反爬教训
// （简单 UA+direct:true 优先直连）留存于 git 历史与 feature doc，direct 机制保留给后续源用。

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export const JSON_SOURCES: JsonSourceDef[] = [
  // ---- AI（AC3）----
  {
    sourceId: "hf-daily-papers",
    category: "ai",
    // HF daily papers 周末/凌晨可能空 → 回退前 1-3 天（空结果自动走链）
    urls: [1, 2, 3].map(
      (d) => (now: Date) =>
        `https://huggingface.co/api/daily_papers?date=${prevBusinessDate(formatBusinessDate(now, "UTC"), d)}`,
    ),
    map: (json) =>
      asArray(json).map((e) => {
        const rec = asRecord(e)
        const paper = asRecord(rec.paper)
        const upvotes = typeof paper.upvotes === "number" ? paper.upvotes : 0
        return {
          title: String(rec.title ?? paper.title ?? ""),
          url: `https://huggingface.co/papers/${String(paper.id ?? "")}`,
          publishedAt: typeof rec.publishedAt === "string" ? rec.publishedAt : null,
          snippet: `[▲${upvotes}] ${String(rec.summary ?? "")}`,
          engagement: upvotes,
        }
      }),
  },
  {
    sourceId: "hn-ai",
    category: "ai",
    urls: [
      (now: Date) =>
        `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=50&numericFilters=points%3E100,created_at_i%3E${Math.floor(now.getTime() / 1000) - 86_400}`,
    ],
    map: (json) =>
      asArray(asRecord(json).hits).map((h) => {
        const rec = asRecord(h)
        const url =
          typeof rec.url === "string" && rec.url
            ? rec.url
            : `https://news.ycombinator.com/item?id=${String(rec.objectID ?? "")}`
        return {
          title: String(rec.title ?? ""),
          url,
          publishedAt: typeof rec.created_at === "string" ? rec.created_at : null,
          snippet: `${Number(rec.points ?? 0)} points on Hacker News`,
          engagement: Number(rec.points ?? 0),
        }
      }),
    keepIf: (it) => AI_KEYWORDS.test(it.title),
    // #30 热评富化（P1）：榜内前 5 拉 items/{id} 顶层评论 ×2 进 snippet（fail-open）
    enrich: (items, rawBody, ctx) => enrichHnComments(items, rawBody, ctx),
  },
  {
    // #20 AI HOT（主表 v2.1）：LLM 策展中文 AI 聚合（公众号/The Decoder/RSS），自带中文 summary
    // 免 auth 但 nginx 挡无 UA 请求（SafeHttpClient 默认带浏览器 UA，07-04 实测 200）
    sourceId: "ai-hot",
    category: "ai",
    urls: ["https://aihot.virxact.com/api/public/items?mode=selected"],
    map: (json) =>
      asArray(asRecord(json).items).map((e) => {
        const rec = asRecord(e)
        return {
          title: String(rec.title ?? rec.title_en ?? ""),
          url: String(rec.url ?? rec.permalink ?? ""),
          publishedAt: typeof rec.publishedAt === "string" ? rec.publishedAt : null,
          snippet: `[${String(rec.source ?? "AI HOT")}] ${String(rec.summary ?? "")}`,
          engagement: Number(rec.score ?? 0), // AI HOT 策展分
        }
      }),
  },
  // ---- 社区动态（07-06 改版：技术社区热议归社区板块，热点板块留纯大众热榜）----
  {
    // #21 V2EX 热议（主表 v2.1）：公开 API 免 key（Agent-Reach 端点备案，07-05 实测）。
    // E2 科技词表 keepIf（07-07 小孙「社区动态太多没用内容」）：全站热议含大量
    // 生活/职场/理财贴，正向匹配 AI/科技才进——宁缺勿滥
    sourceId: "v2ex-hot",
    category: "community",
    urls: ["https://www.v2ex.com/api/topics/hot.json"],
    keepIf: isTechTopicItem,
    map: (json) =>
      asArray(json).map((e) => {
        const rec = asRecord(e)
        return {
          title: String(rec.title ?? ""),
          url: String(rec.url ?? ""),
          publishedAt:
            typeof rec.created === "number" ? new Date(rec.created * 1000).toISOString() : null,
          snippet: `[${Number(rec.replies ?? 0)} 回复] ${String(rec.content ?? "")}`,
          engagement: Number(rec.replies ?? 0),
        }
      }),
  },
  {
    sourceId: "zhihu-hot",
    category: "hot",
    urls: ["https://api.zhihu.com/topstory/hot-list"],
    map: (json) =>
      asArray(asRecord(json).data).map((c) => {
        const rec = asRecord(c)
        const target = asRecord(rec.target)
        // target.id 是超长数字有 JS 精度丢失，必须从 url 字符串取 id
        const apiUrl = String(target.url ?? "")
        const qid = apiUrl.match(/questions\/(\d+)/)?.[1]
        return {
          title: String(target.title ?? ""),
          url: qid ? `https://www.zhihu.com/question/${qid}` : apiUrl,
          publishedAt:
            typeof target.created === "number"
              ? new Date(target.created * 1000).toISOString()
              : null,
          snippet: String(target.excerpt ?? ""),
        }
      }),
  },
  {
    sourceId: "baidu-hot",
    category: "hot",
    urls: ["https://top.baidu.com/api/board?tab=realtime"],
    map: (json) => {
      const cards = asArray(asRecord(asRecord(json).data).cards)
      const content = cards.flatMap((c) => asArray(asRecord(c).content))
      return content.map((e) => {
        const rec = asRecord(e)
        return {
          title: String(rec.query ?? rec.word ?? ""),
          url: String(rec.rawUrl ?? rec.url ?? ""),
          publishedAt: null,
          snippet: `[热度 ${String(rec.hotScore ?? "?")}] ${String(rec.desc ?? "")}`,
          engagement: Number(rec.hotScore ?? 0),
        }
      })
    },
  },
  {
    sourceId: "toutiao-hot",
    category: "hot",
    urls: ["https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc"],
    map: (json) =>
      asArray(asRecord(json).data).map((e) => {
        const rec = asRecord(e)
        return {
          title: String(rec.Title ?? ""),
          url: String(rec.Url ?? ""),
          publishedAt: null,
          snippet: `[热度 ${String(rec.HotValue ?? "?")}]`,
          engagement: Number(rec.HotValue ?? 0),
        }
      }),
  },
]

function resolveUrl(u: UrlOrBuilder, now: Date): string {
  return typeof u === "function" ? u(now) : u
}

function applyKeep(
  items: NormalizedItem[],
  keepIf?: (i: NormalizedItem) => boolean,
): NormalizedItem[] {
  return keepIf ? items.filter(keepIf) : items
}

function isRetryableFeedError(
  error: unknown,
  policy: FeedRetryPolicy,
  signal: AbortSignal,
): error is SafeHttpError {
  if (signal.aborted || !(error instanceof SafeHttpError)) return false
  if (error.kind === "network" || error.kind === "timeout") return true
  return (
    error.kind === "http_status" &&
    typeof error.status === "number" &&
    policy.retryHttpStatuses.includes(error.status)
  )
}

async function waitForFeedRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (delayMs <= 0) return true
  return new Promise<boolean>((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(ready)
    }
    const onAbort = () => finish(false)
    signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => finish(!signal.aborted), delayMs)
  })
}

async function fetchFeedText(
  ctx: SourceFetchContext,
  http: SourceFetchContext["http"],
  sourceId: string,
  url: string,
  headers: Record<string, string> | undefined,
  policy: FeedRetryPolicy | undefined,
): Promise<string> {
  const maxAttempts = policy?.maxAttempts ?? 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const body = await http.fetchText(url, { headers, signal: ctx.signal })
      if (attempt > 1) {
        console.warn(`[daily-digest] ${sourceId} source-recovered attempt=${attempt}`)
      }
      return body
    } catch (error) {
      if (
        !policy ||
        attempt >= maxAttempts ||
        !isRetryableFeedError(error, policy, ctx.signal)
      ) {
        throw error
      }
      const delayMs =
        policy.delayMs <= 0
          ? 0
          : Math.max(1, Math.round(policy.delayMs * (0.75 + Math.random() * 0.5)))
      console.warn(
        `[daily-digest] ${sourceId} feed-retry attempt=${attempt + 1}/${maxAttempts} kind=${error.kind}${typeof error.status === "number" ? ` status=${error.status}` : ""} delayMs=${delayMs}`,
      )
      if (!(await waitForFeedRetry(delayMs, ctx.signal))) throw error
    }
  }
  throw new Error(`${sourceId} feed attempts exhausted`)
}

/**
 * fallback 链：逐 URL × 逐 transport 试，非空即返；全空/全错抛最后错误（orchestrator 记 failed）。
 * def.direct=true 优先 ctx.httpDirect（不走代理）——部分源（ESPN/HLTV）对代理出口 IP 返回
 * 403/挑战页而直连正常；但直连通道也会趋势性劣化（espn 2026-07-03 实测 3 连 timeout）
 * → direct 源直连失败后仍退回代理通道兜底（两条 transport 都试）。
 *
 * 07-06 首跑纠偏：**解析出条目但被 keepIf 全滤 ≠ 失败**——安静频道/无匹配日照样健康
 * （yt-3blue1brown 被 72h 窗滤空曾误报 failed → 异常提醒卡+3 天告警全是噪音）。
 * parse 返回 { parsedCount, items }：parsedCount>0 且 kept 0 → 健康空直接返 []（同源
 * 换跳内容一样，不再试下一 URL）；parsedCount=0 才算这一跳解析失败继续走链。
 */
async function fetchViaChain(
  ctx: SourceFetchContext,
  def: {
    sourceId: string
    urls: UrlOrBuilder[]
    headers?: Record<string, string>
    direct?: boolean
    retryPolicy?: FeedRetryPolicy
  },
  parse: (body: string) => { parsedCount: number; items: NormalizedItem[] },
): Promise<NormalizedItem[]> {
  const clients =
    def.direct && ctx.httpDirect && ctx.httpDirect !== ctx.http
      ? [ctx.httpDirect, ctx.http]
      : [ctx.http]
  let lastError: unknown = null
  let failedHops = 0
  for (const u of def.urls) {
    const url = resolveUrl(u, ctx.now())
    for (const http of clients) {
      try {
        const body = await fetchFeedText(
          ctx,
          http,
          def.sourceId,
          url,
          def.headers,
          def.retryPolicy,
        )
        const { parsedCount, items } = parse(body)
        if (items.length > 0 || parsedCount > 0) {
          // 德彪 r-final P3：前跳失败、后跳成功要透出——否则主 URL 长期腐烂完全不可见
          // （orchestrator 只记最终 ok）。parsedCount>0 且 kept 0 = 健康空：源活着本窗口没货
          if (failedHops > 0)
            console.warn(
              `[daily-digest] ${def.sourceId} 前 ${failedHops} 跳失败后走备用成功：${String(lastError).slice(0, 120)}`,
            )
          return items.length > 0 ? items : []
        }
        lastError = new Error(`no items parsed from ${url}`)
        failedHops++
      } catch (err) {
        if (ctx.signal.aborted) throw err
        lastError = err
        failedHops++
      }
    }
  }
  throw lastError ?? new Error(`all urls exhausted for ${def.sourceId}`)
}

export function makeRssSource(def: RssSourceDef): DigestSource {
  return {
    sourceId: def.sourceId,
    category: def.category,
    fetch: (ctx) =>
      fetchViaChain(ctx, def, (body) => {
        const raw = parseRssOrAtom(body, def.sourceId, def.category)
        return { parsedCount: raw.length, items: applyKeep(raw, def.keepIf) }
      }),
  }
}

export function mapJsonItems(def: JsonSourceDef, json: unknown): NormalizedItem[] {
  const raw = def.map(json).filter((r) => r.title && r.url)
  const items = raw.map((r) =>
    buildNormalizedItem(
      def.sourceId,
      def.category,
      r.title,
      r.url,
      r.publishedAt ?? null,
      r.snippet ?? "",
      r.engagement,
    ),
  )
  return applyKeep(items, def.keepIf)
}

export function makeJsonSource(def: JsonSourceDef): DigestSource {
  return {
    sourceId: def.sourceId,
    category: def.category,
    async fetch(ctx) {
      let rawBody = ""
      const items = await fetchViaChain(ctx, def, (body) => {
        let json: unknown
        try {
          json = JSON.parse(body)
        } catch {
          return { parsedCount: 0, items: [] }
        }
        rawBody = body
        // parsedCount = map 出的原始条数（keepIf 前）——健康空判定与 RSS 同口径
        const mapped = def.map(json).filter((r) => r.title && r.url)
        return { parsedCount: mapped.length, items: mapJsonItems(def, json) }
      })
      // #30 富化钩：enrich 契约自兜错（失败回原 items），这里不再包一层
      if (def.enrich && items.length > 0) return def.enrich(items, rawBody, ctx)
      return items
    },
  }
}

export interface BuildSourcesOptions {
  /** AC13 自建 RSSHub base（env MULTI_AGENT_DIGEST_RSSHUB_BASE）：前插到有 rsshubRoute 的源链首 */
  rsshubBase?: string
}

export function buildAllSources(opts: BuildSourcesOptions = {}): DigestSource[] {
  const rss = RSS_SOURCES.map((def) => {
    if (opts.rsshubBase && def.rsshubRoute) {
      const base = opts.rsshubBase.replace(/\/$/, "")
      return makeRssSource({ ...def, urls: [`${base}${def.rsshubRoute}`, ...def.urls] })
    }
    return makeRssSource(def)
  })
  return [...rss, ...JSON_SOURCES.map(makeJsonSource)]
}

/** 出站白名单从 registry 自动推导 + 显式追加（github/reddit/digg 是独立 fetcher 模块不在 registry 表内） */
export const EXTRA_ALLOWED_HOSTS = [
  "github.com",
  "api.github.com",
  "news.smol.ai",
  "www.reddit.com", // #22 shreddit svc
  "digg.com", // #23 Digg AI 1000
]

/** 质量层 3：简报型源清单（被选中后必须深读正文）——从 registry 单一真相源推导 */
export function deriveDeepReadSourceIds(): string[] {
  return [...RSS_SOURCES, ...JSON_SOURCES]
    .filter((d) => d.contentMode === "digest")
    .map((d) => d.sourceId)
}

/**
 * #34 YouTube 频道源清单（yt- 前缀既成约定）：deep-read 字幕路线用——**不并入
 * deriveDeepReadSourceIds**（那是 renderer 速览排除口径：简报型标题无信息量；
 * YouTube 标题有信息量，没被精选仍该进速览）。
 */
export function deriveYouTubeSourceIds(): string[] {
  return RSS_SOURCES.filter((d) => d.sourceId.startsWith("yt-")).map((d) => d.sourceId)
}

export function deriveOutboundAllowlist(now = new Date()): string[] {
  const hosts = new Set<string>(EXTRA_ALLOWED_HOSTS)
  for (const def of [...RSS_SOURCES, ...JSON_SOURCES]) {
    for (const u of def.urls) hosts.add(new URL(resolveUrl(u, now)).hostname.toLowerCase())
  }
  return [...hosts].sort()
}

/**
 * 设置页「逐源开关」的完整源清单（F037 §5）：registry 表驱动源 + 独立 fetcher 模块 +
 * 条件源（X/小红书——是否实际启用由 env/设置决定，开关先行注册）。纯静态元数据，
 * 不构造任何 fetcher。label 由 source-labels 另行映射（路由层组装）。
 */
export function listAllSourceMeta(): Array<{ id: string; category: DigestCategory }> {
  const out: Array<{ id: string; category: DigestCategory }> = [
    ...[...RSS_SOURCES, ...JSON_SOURCES].map((d) => ({
      id: d.sourceId,
      category: d.category,
    })),
    // 独立 fetcher 模块（多 URL 遍历/RSC 提取/限速遍历，不适合表驱动）；
    // 07-06 社区改版：Reddit/Digg/X/小红书全归社区动态板块
    { id: "reddit-ai", category: "community" },
    { id: "digg-ai", category: "community" },
    { id: "x-firsthand", category: "community" },
    // xiaohongshu 07-11 从设置页摘除（#31 转 F029 当 UGC 核查源、日报侧休眠——
    // 小孙「设置里为啥还有小红书」）；适配器/boot 接线留存，重启用时把本行加回即可
    // #33 播客速递（07-10）：条件源（MULTI_AGENT_DIGEST_STT_API_KEY 配了才实际启用），开关先行注册
    { id: "podcast-transcribe", category: "podcast" },
    // GitHub 榜单族（时间切换器：日榜+月榜每天常驻 / 周榜+新秀周一，07-06 小孙「月榜咋没有了」）
    { id: "github-trending-daily", category: "github" },
    { id: "github-trending-weekly", category: "github" },
    { id: "github-ai-newcomers", category: "github" },
    { id: "github-trending-monthly", category: "github" },
  ]
  return out
}
