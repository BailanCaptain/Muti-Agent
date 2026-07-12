import { buildNormalizedItem } from "../feed-parsers"
import type { DigestSource, NormalizedItem } from "../types"
import { type PacingOptions, forEachPaced, resolvePacing } from "./pacing"

/**
 * #22 Reddit AI 社区（主表 v2.1）：shreddit svc partial 免 key 路线（last30days 生产同款）。
 * 背景：官方 API 停自助注册、匿名 .json 已 403 全封（2026-06 外部现实）——但 Reddit 网页
 * 自身 SPA 的数据端点 `/svc/shreddit/community-more-posts/{sort}/?name={sub}&t=day` 返回
 * HTML，`<shreddit-post>` 标签属性自带真实 score/comment-count（2026-07-05 活体验证 200×90 帖）。
 * 纪律（last30days C 节）：浏览器 UA（SafeHttpClient 默认）+ Accept-Language 显式；
 * 子版间限速 ≈1 req/s（它家令牌桶 5rps 的保守档）；结构改版/反爬变脸 → 解析 0 帖抛错
 * 由 orchestrator 记 failed（B 项提醒卡可见）。大陆网络走 boot 层代理（reddit 直连不通）。
 */

/** AINews 的 Reddit recap 也主要盯这几个子版（12 subreddits 的 AI 核心子集） */
export const REDDIT_AI_SUBS = ["LocalLLaMA", "MachineLearning", "OpenAI", "ClaudeAI", "singularity"]

/** ≈1-0.8 req/s，5 子版 ~4s；预算 2 分钟兜慢网 */
const REDDIT_PACING_DEFAULTS = { delayMs: 600, jitterMs: 600, maxTotalMs: 120_000 }

export interface ShredditPost {
  title: string
  permalink: string
  score: number
  comments: number
  /** 归一 ISO；源格式 "2026-07-03T20:02:26.378000+0000" */
  createdAt: string | null
  postType: string
  subreddit: string
}

/** 德彪 batchA-r1 P2：越界 numeric entity（>0x10FFFF）会让 fromCodePoint 抛 RangeError
 * 炸掉整个子版解析 —— 畸形输入换 U+FFFD，不抛。 */
function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�"
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(Number.parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function isoOrNull(raw: string): string | null {
  const t = Date.parse(raw)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** `<shreddit-post ...>` 开标签属性 → 结构化帖子（解析器是唯一维护点） */
export function parseShredditPosts(html: string): ShredditPost[] {
  const tags = html.match(/<shreddit-post\b[^>]*>/g) ?? []
  const out: ShredditPost[] = []
  for (const tag of tags) {
    const attr = (name: string): string => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ""
    const title = decodeEntities(attr("post-title"))
    const permalink = attr("permalink")
    if (!title || !permalink.startsWith("/r/")) continue
    out.push({
      title,
      permalink,
      score: Number(attr("score") || "0"),
      comments: Number(attr("comment-count") || "0"),
      createdAt: attr("created-timestamp") ? isoOrNull(attr("created-timestamp")) : null,
      postType: attr("post-type"),
      subreddit: attr("subreddit-prefixed-name").replace(/^r\//, ""),
    })
  }
  return out
}

export interface RedditAiOptions {
  subreddits?: string[]
  /** 每子版取 top N（按真实 score 排），默认 8 */
  perSub?: number
  pacing?: PacingOptions
}

export function makeRedditAiSource(opts: RedditAiOptions = {}): DigestSource {
  const subs = opts.subreddits ?? REDDIT_AI_SUBS
  const perSub = opts.perSub ?? 8
  const pacing = resolvePacing(opts.pacing, REDDIT_PACING_DEFAULTS)
  return {
    sourceId: "reddit-ai",
    category: "community",
    // 限速遍历长跑：预算 + 60s 余量覆盖 orchestrator 默认 45s（同 x-provider 语义）
    timeoutBudgetMs: pacing.maxTotalMs + 60_000,
    async fetch(ctx): Promise<NormalizedItem[]> {
      const out: NormalizedItem[] = []
      await forEachPaced(subs, pacing, ctx.signal, async (sub) => {
        try {
          const html = await ctx.http.fetchText(
            `https://www.reddit.com/svc/shreddit/community-more-posts/top/?name=${encodeURIComponent(sub)}&t=day`,
            { headers: { "accept-language": "en-US,en;q=0.9" } },
          )
          const posts = parseShredditPosts(html)
            .sort((a, b) => b.score - a.score)
            .slice(0, perSub)
          for (const p of posts) {
            out.push(
              buildNormalizedItem(
                "reddit-ai",
                // 德彪批次 D r1 P1：item 级 category 必须与源声明一致（orchestrator 只认 item 自带值）
                "community",
                p.title,
                `https://www.reddit.com${p.permalink}`,
                p.createdAt,
                // 真实赞数/评论数前置（互动量即选材信号，AINews/last30days 同款）；非文本帖标类型
                `[▲${p.score} · ${p.comments} 评论${p.postType && p.postType !== "text" ? ` · ${p.postType}` : ""}] r/${p.subreddit || sub}`,
                p.score,
              ),
            )
          }
        } catch {
          // 单子版失败跳过（per-sub 隔离）；整源健康由 orchestrator 记
        }
      })
      if (out.length === 0)
        throw new Error("reddit-ai: 0 posts parsed（反爬变脸/结构改版/代理不通？）")
      return out
    },
  }
}
