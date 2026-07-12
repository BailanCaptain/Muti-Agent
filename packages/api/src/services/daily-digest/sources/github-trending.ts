import { buildNormalizedItem, stripHtml } from "../feed-parsers"
import type { DigestSource, NormalizedItem } from "../types"

/**
 * AC7 GitHub 周榜：scrape trending?since=weekly（唯一权威「N stars this week」，官方无 API）
 * + AI/MCP/skill 主题加权 + 新贵子榜（近 7 天新仓，总星≈周增星）。
 * OSS Insight 周增数字系统性低估 30-45 倍 → 只可做名次兜底，禁止其数字进正文（调研结论）。
 */

export interface TrendingRepo {
  repo: string
  description: string
  /** 榜单周期内增星（日榜=今日增/周榜=周增/月榜=月增，按抓取 since 参数） */
  weeklyStars: number
  language: string
  totalStars: number
}

/** GitHub trending 页服务端渲染 HTML → repo 列表（解析器是唯一维护点） */
export function parseTrendingHtml(html: string): TrendingRepo[] {
  const articles = html.match(/<article[\s\S]*?<\/article>/g) ?? []
  const out: TrendingRepo[] = []
  for (const a of articles) {
    const flat = a.replace(/\s+/g, " ")
    const repo = flat.match(/<h2[^>]*>[\s\S]*?href="\/([^"?]+)"/)?.[1] ?? ""
    if (!repo || !repo.includes("/")) continue
    const description = stripHtml(
      flat.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "",
    )
    const weeklyStars = Number(
      (flat.match(/([\d,]+)\s*stars (?:this week|this month|today)/)?.[1] ?? "0").replace(/,/g, ""),
    )
    const language = flat.match(/itemprop="programmingLanguage">([^<]+)</)?.[1] ?? ""
    const totalStars = Number(
      (flat.match(/stargazers"[\s\S]*?<\/svg>\s*([\d,]+)/)?.[1] ?? "0").replace(/,/g, ""),
    )
    out.push({ repo, description, weeklyStars, language, totalStars })
  }
  return out
}

const AI_TOPICS = new Set([
  "mcp",
  "model-context-protocol",
  "claude",
  "claude-code",
  "llm",
  "ai-agent",
  "agent",
  "skills",
  "openai",
  "anthropic",
  "rag",
])
const AI_DESC = /(\bai\b|llm|gpt|claude|agent|mcp|copilot|model|机器学习|大模型|智能体)/i

/** 周增星 × AI 加权（topic 命中 ×3，desc 命中 ×2） */
export function aiWeight(r: TrendingRepo, topics: string[] = []): number {
  const topicHit = topics.some((t) => AI_TOPICS.has(t.toLowerCase()))
  const descHit = AI_DESC.test(r.description)
  return r.weeklyStars * (1 + (topicHit ? 2 : 0) + (descHit ? 1 : 0))
}

function starsFmt(n: number): string {
  return n.toLocaleString("en-US")
}

export interface GithubSourceOptions {
  /** MULTI_AGENT_DIGEST_GITHUB_PAT；无 PAT 时跳过 topics 拉取，只按 desc 关键词加权 */
  pat?: string
}

type TrendingPeriod = "daily" | "weekly" | "monthly"

/** 日/周/月榜共用工厂（#27 月榜=07-04 点名；增长榜(日)=07-05 分栏改版；页面文案 stars today / this week/month） */
function makeTrendingSource(
  period: TrendingPeriod,
  sourceId: string,
  opts: GithubSourceOptions,
): DigestSource {
  const starsPhrase =
    period === "daily" ? "stars today" : `stars this ${period === "weekly" ? "week" : "month"}`
  return {
    sourceId,
    category: "github",
    async fetch(ctx): Promise<NormalizedItem[]> {
      const html = await ctx.http.fetchText(`https://github.com/trending?since=${period}`)
      const repos = parseTrendingHtml(html)
      if (repos.length === 0)
        throw new Error("trending parse produced 0 repos（页面改版？检查解析器）")

      const topicsByRepo = new Map<string, string[]>()
      if (opts.pat) {
        for (const r of repos.slice(0, 25)) {
          try {
            const body = await ctx.http.fetchText(`https://api.github.com/repos/${r.repo}`, {
              headers: {
                authorization: `Bearer ${opts.pat}`,
                accept: "application/vnd.github+json",
              },
            })
            const j = JSON.parse(body) as { topics?: string[] }
            topicsByRepo.set(r.repo, Array.isArray(j.topics) ? j.topics : [])
          } catch {
            // 单 repo topics 拉取失败不阻断周榜
          }
        }
      }

      const ranked = [...repos].sort(
        (a, b) => aiWeight(b, topicsByRepo.get(b.repo)) - aiWeight(a, topicsByRepo.get(a.repo)),
      )
      return ranked.map((r) =>
        buildNormalizedItem(
          sourceId,
          "github",
          r.repo,
          `https://github.com/${r.repo}`,
          null,
          `+${starsFmt(r.weeklyStars)} ${starsPhrase} · ★${starsFmt(r.totalStars)}${r.language ? ` · ${r.language}` : ""} · ${r.description}`,
        ),
      )
    },
  }
}

export function makeGithubWeeklySource(opts: GithubSourceOptions = {}): DigestSource {
  return makeTrendingSource("weekly", "github-trending-weekly", opts)
}

/** 增长榜（日）：小孙 07-05 分栏改版 #2 —— 每天出，看今天谁在窜（stars today） */
export function makeGithubDailySource(opts: GithubSourceOptions = {}): DigestSource {
  return makeTrendingSource("daily", "github-trending-daily", opts)
}

/** #27 GitHub 月榜（主表 v2.1，小孙 07-04 点名；07-06 起每天常驻——「月榜咋没有了」） */
export function makeGithubMonthlySource(opts: GithubSourceOptions = {}): DigestSource {
  return makeTrendingSource("monthly", "github-trending-monthly", opts)
}

/** 新贵子榜：近 7 天创建的 topic:mcp 新仓按总星排（新仓总星≈周增星，天然是增速榜） */
export function makeGithubNewcomersSource(): DigestSource {
  return {
    sourceId: "github-ai-newcomers",
    category: "github",
    async fetch(ctx): Promise<NormalizedItem[]> {
      const since = new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
      const q = encodeURIComponent(`topic:mcp created:>${since}`)
      const body = await ctx.http.fetchText(
        `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`,
        {
          headers: { accept: "application/vnd.github+json" },
        },
      )
      const j = JSON.parse(body) as { items?: Array<Record<string, unknown>> }
      const items = Array.isArray(j.items) ? j.items : []
      return items.map((rec) =>
        buildNormalizedItem(
          "github-ai-newcomers",
          "github",
          `🆕 ${String(rec.full_name ?? "")}`,
          String(rec.html_url ?? `https://github.com/${String(rec.full_name ?? "")}`),
          // publishedAt 恒 null（德彪 DE-r2 P2）：四路 GH 榜必须同为 null，跨榜同 repo 的
          // dedupe 才是「先到者赢」= 源数组顺序（日>周>新秀>月）；此前带 created_at 会让
          // 新秀项顶掉 daily 项。新仓时效已在 snippet 文案（"新仓 7 天"）与搜索窗本身表达
          null,
          `新仓 7 天 ★${starsFmt(Number(rec.stargazers_count ?? 0))} · ${String(rec.description ?? "")}`,
        ),
      )
    },
  }
}
