import { XMLParser } from "fast-xml-parser"
import { buildNormalizedItem } from "../feed-parsers"
import type { DigestSource, NormalizedItem, SourceFetchContext } from "../types"
import {
  MAX_EPISODE_SEC,
  type PodcastEpisodeRef,
  type PodcastTranscriber,
  type PodcastTranscriberDeps,
  createPodcastTranscriber,
  episodeCacheKey,
  readEpisodeRecord,
} from "./podcast-transcribe"
import { RSSHUB_INSTANCES, withinRecentWindow } from "./registry"

/**
 * #33 播客速递源（小孙 07-10 拍「现在搞」）：小宇宙播客经 RSSHub `/xiaoyuzhou/podcast/:id`
 * 拿 feed（enclosure 直出 media.xyzcdn.net 音频直链，07-10 四家全实测 200）→ 7 天窗新集 →
 * 转写引擎（podcast-transcribe）→ NormalizedItem（rawSnippet=提炼要点）。
 *
 * 板块语义：category="podcast" 与 github 同为 items 直渲流——不进 summarizer LLM 挑选，
 * 无新集当天板块整体不出现（renderer 空节自动消失）。跨日去重走 shown 账本（job 预滤）；
 * 集级幂等走转写缓存（同集永不重转写）。
 */

export interface PodcastFeedDef {
  /** 小宇宙 podcast id（xiaoyuzhoufm.com/podcast/<pid>） */
  pid: string
  /** 播客名：进 item title 前缀与 topicTag */
  name: string
}

/**
 * 默认清单（07-10 四家 + 07-11 小孙「多加一点，AI 领域影响大的」扩四家；
 * RSSHub 路由逐家实测通+标题核对）——设置页整源开关，改清单改这。
 * 周更 ×8 ≈ 每天 1-3 新集，单轮 cap 3 集自然限流（超出次日缓存续做）。
 */
export const PODCAST_FEEDS: PodcastFeedDef[] = [
  { pid: "648b0b641c48983391a63f98", name: "42章经" },
  { pid: "5e5c52c9418a84a04625e6cc", name: "硅谷101" },
  { pid: "5e74b52c418a84a046ecaceb", name: "What's Next 科技早知道" },
  { pid: "61cbaac48bb4cd867fcabe22", name: "OnBoard!" },
  // 07-11 扩：AI 深访/一手信息密度最高的四家（张小珺常出 2h+ 长访谈——超 3h 集按
  // MAX_EPISODE_SEC 跳过，命中率实跑观察后再议放宽）
  { pid: "626b46ea9cbbf0451cf5a962", name: "张小珺商业访谈录" },
  { pid: "61933ace1b4320461e91fd55", name: "晚点聊 LateTalk" },
  { pid: "60502e253c92d4f62c2a9577", name: "十字路口Crossing" },
  { pid: "61358d971c5d56efe5bcb5d2", name: "乱翻书" },
]

export const PODCAST_SOURCE_ID = "podcast-transcribe"

/** 单轮新转写上限：Groq 免费层 28.8K audio-sec/天 ≈8h（硅基流动更宽）——3 集封顶留余量，超出的明天缓存续做 */
export const MAX_NEW_EPISODES_PER_RUN = 3

/** itunes:duration 三形态容错："1:10:46" / "50:20" / "3020"（纯秒） */
export function parseDurationSec(raw: string): number | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const parts = s.split(":").map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return null
}

function text(v: unknown): string {
  if (v === undefined || v === null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  const obj = v as Record<string, unknown>
  if (typeof obj["#text"] === "string" || typeof obj["#text"] === "number")
    return String(obj["#text"])
  if (typeof obj.__cdata === "string") return String(obj.__cdata)
  return ""
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

/**
 * 播客 RSS 解析（parseRssOrAtom 不带 enclosure/duration，这里独立解但同款容错风格）：
 * 解析失败/无条目返回 []（chain 语义由调用方处理）。
 */
export function parsePodcastFeed(xml: string, podcastName: string): PodcastEpisodeRef[] {
  let doc: Record<string, unknown>
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      cdataPropName: "__cdata",
    })
    doc = parser.parse(xml)
  } catch {
    return []
  }
  const rss = doc.rss as Record<string, unknown> | undefined
  const channel = rss?.channel as Record<string, unknown> | undefined
  if (!channel) return []

  const out: PodcastEpisodeRef[] = []
  for (const item of toArray(
    channel.item as Record<string, unknown> | Array<Record<string, unknown>>,
  )) {
    const rec = item as Record<string, unknown>
    const title = text(rec.title).trim()
    const episodeUrl = text(rec.link) || text(rec.guid)
    const enclosure = rec.enclosure as Record<string, unknown> | undefined
    const enclosureUrl = typeof enclosure?.["@_url"] === "string" ? enclosure["@_url"] : ""
    if (!title || !episodeUrl || !enclosureUrl) continue
    const pubRaw = text(rec.pubDate)
    const pubTs = Date.parse(pubRaw)
    out.push({
      episodeUrl: episodeUrl.trim(),
      enclosureUrl: enclosureUrl.trim(),
      title,
      podcast: podcastName,
      publishedAt: Number.isNaN(pubTs) ? null : new Date(pubTs).toISOString(),
      durationSec: parseDurationSec(text(rec["itunes:duration"])),
    })
  }
  return out
}

export interface PodcastSourceConfig extends PodcastTranscriberDeps {
  /** AC13 自建 RSSHub base（有则前插 fallback 链首，同 registry rsshubRoute 模式） */
  rsshubBase?: string
  /** 缺省 PODCAST_FEEDS；测试注入 */
  feeds?: PodcastFeedDef[]
  /** 测试注入转写器；缺省由 deps 构造 */
  transcriber?: PodcastTranscriber
}

function feedUrls(pid: string, rsshubBase?: string): string[] {
  const route = `/xiaoyuzhou/podcast/${pid}`
  const bases = [...(rsshubBase ? [rsshubBase.replace(/\/$/, "")] : []), ...RSSHUB_INSTANCES]
  return bases.map((b) => `${b}${route}`)
}

export function makePodcastSource(cfg: PodcastSourceConfig): DigestSource {
  const log = cfg.log ?? (() => {})
  const feeds = cfg.feeds ?? PODCAST_FEEDS
  const transcriber = cfg.transcriber ?? createPodcastTranscriber(cfg)

  async function fetchFeedEpisodes(
    ctx: SourceFetchContext,
    feed: PodcastFeedDef,
  ): Promise<PodcastEpisodeRef[] | null> {
    let lastErr: unknown = null
    for (const url of feedUrls(feed.pid, cfg.rsshubBase)) {
      try {
        const xml = await ctx.http.fetchText(url)
        const eps = parsePodcastFeed(xml, feed.name)
        if (eps.length > 0) return eps
        lastErr = new Error(`no episodes parsed from ${url}`)
      } catch (err) {
        lastErr = err
      }
    }
    log(`[daily-digest] 播客 feed 全链失败：${feed.name}——${String(lastErr).slice(0, 120)}`)
    return null
  }

  return {
    sourceId: PODCAST_SOURCE_ID,
    category: "podcast",
    // 最坏 3 集全链（下载 180s+转码 180s+转写 300s+提炼 120s）≈ 40min 理论值，实测单集 ~2min；
    // 15min 预算：正常轮绰绰有余，异常轮被 orchestrator 掐掉不拖全局（其他源并发不受影响）
    timeoutBudgetMs: 900_000,
    async fetch(ctx) {
      // 德彪 r2 P1：预 abort 时连 feeds 都不拉（原实现先并发拉全部 feed 才进循环查 signal）
      ctx.signal.throwIfAborted()
      const perFeed = await Promise.all(feeds.map((f) => fetchFeedEpisodes(ctx, f)))
      const okFeeds = perFeed.filter((r): r is PodcastEpisodeRef[] => r !== null)
      // 全部 feed 都拉不下来 = 坏源（RSSHub 挂了/路由变更），进 health 告警链
      if (okFeeds.length === 0) throw new Error(`播客 ${feeds.length} 家 feed 全部拉取失败`)

      // 7 天窗内的新集才是候选（withinRecentWindow 同口径：无日期保守保留）
      const recent = okFeeds
        .flat()
        .filter((ep) => withinRecentWindow(ep))
        // 旧→新：配额吃紧时先把积压的老集清掉，播出顺序也更自然
        .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""))

      // health 计数三分法（德彪 r1 P2-2）：缓存命中 ≠ 新工作成功（旧缓存会掩盖当日
      // STT/ffmpeg 故障）；策略性 skip（3h 门/单轮额度）不进失败分母（把健康源记 failed
      // 是误报）。「新工作全败」才算坏源。
      const items: NormalizedItem[] = []
      let newAttempted = 0
      let newFailed = 0
      let lastErr: unknown = null
      for (const ep of recent) {
        // P1-2：orchestrator 预算掐断后快停——不再启动任何新集工作
        ctx.signal.throwIfAborted()
        // 3h 门 = 策略 skip（前移到 source 层，不再由 transcriber 抛错——P2-2 误报侧）
        if (ep.durationSec && ep.durationSec > MAX_EPISODE_SEC) {
          log(
            `[daily-digest] 播客超 3h 跳过（配额保护）：${ep.podcast}｜${ep.title}（${Math.round(ep.durationSec / 60)}min）`,
          )
          continue
        }
        const cached = readEpisodeRecord(cfg.baseDir, episodeCacheKey(ep.enclosureUrl))
        const isNewWork = !cached?.digestZh
        if (isNewWork) {
          if (newAttempted >= MAX_NEW_EPISODES_PER_RUN) {
            log(
              `[daily-digest] 播客单轮转写额度（${MAX_NEW_EPISODES_PER_RUN}）用完，${ep.podcast}｜${ep.title} 留到下轮`,
            )
            continue
          }
          newAttempted++ // 占额度先行（失败也耗——防单轮内反复烧同一集）
        }
        try {
          const rec = await transcriber.ensureDigest(ep, ctx.signal)
          items.push({
            ...buildNormalizedItem(
              PODCAST_SOURCE_ID,
              "podcast",
              `${ep.podcast}｜${ep.title}`,
              ep.episodeUrl,
              ep.publishedAt,
              rec.digestZh ?? "",
            ),
            topicTag: ep.podcast,
          })
        } catch (err) {
          // 被预算掐断不是源故障：向上抛（orchestrator 已按 timeout 记账），别落 failed
          if (ctx.signal.aborted) throw err
          if (isNewWork) newFailed++
          lastErr = err
          log(
            `[daily-digest] 播客转写失败（跳过本集）：${ep.podcast}｜${ep.title}——${String(err).slice(0, 160)}`,
          )
        }
      }
      // 新工作全干砸（典型：ffmpeg 未装 / STT key 失效 / 配额尽）= 坏源，抛给 health；
      // 缓存直出的旧集不算成功证据（P2-2 漏报侧）
      if (newAttempted > 0 && newFailed === newAttempted) {
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
      }
      return items
    },
  }
}
