import { buildNormalizedItem, stripHtml } from "../feed-parsers"
import {
  assessGithubAiEligibility,
  type GithubAiEligibility,
  type GithubRepoEvidence,
} from "../github-eligibility"
import type { DigestSource, NormalizedItem } from "../types"

/**
 * AC7 GitHub 周榜：scrape trending?since=weekly（唯一权威「N stars this week」，官方无 API）
 * + AI 核心用途准入 + 新秀子榜（近 7 天新仓，总星≈创建以来增星）。
 * OSS Insight 周增数字系统性低估 30-45 倍 → 只可做名次兜底，禁止其数字进正文（调研结论）。
 */

export interface TrendingRepo {
  repo: string
  description: string
  /** 榜单周期内增星（日榜=今日增/周榜=周增/月榜=月增，按抓取 since 参数） */
  windowStars: number
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
    const growthMatch = flat.match(/([\d,]+)\s*stars (?:this week|this month|today)/)?.[1]
    if (!growthMatch) continue
    const windowStars = Number(growthMatch.replace(/,/g, ""))
    const language = flat.match(/itemprop="programmingLanguage">([^<]+)</)?.[1] ?? ""
    const totalStars = Number(
      (flat.match(/stargazers"[\s\S]*?<\/svg>\s*([\d,]+)/)?.[1] ?? "").replace(/,/g, ""),
    )
    if (!Number.isFinite(windowStars) || windowStars <= 0) continue
    if (!Number.isFinite(totalStars) || totalStars < 0) continue
    out.push({ repo, description, windowStars, language, totalStars })
  }
  return out
}

function starsFmt(n: number): string {
  return n.toLocaleString("en-US")
}

export interface GithubSourceOptions {
  /** MULTI_AGENT_DIGEST_GITHUB_PAT；有 PAT 时为弱/冲突候选补 topics + README 证据。 */
  pat?: string
  /** 四榜单轮共享 API 证据，避免同仓重复拉取；缓存事实而非裁决，防止先到的 unknown 污染后续强证据。 */
  evidenceCache?: GithubEvidenceCache
}

interface GithubMetadataEvidence {
  status: "loaded" | "failed"
  topics: string[]
}

interface GithubReadmeEvidence {
  status: "loaded" | "failed"
  text: string | null
}

export interface GithubEvidenceCache {
  metadata: Map<string, Promise<GithubMetadataEvidence>>
  readme: Map<string, Promise<GithubReadmeEvidence>>
  requestGate: GithubRequestGate
}

interface GithubRequestGate {
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

function createGithubRequestGate(limit: number): GithubRequestGate {
  let active = 0
  const waiters: Array<{
    resolve: () => void
    reject: (reason?: unknown) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []

  const drain = () => {
    while (active < limit && waiters.length > 0) {
      const waiter = waiters.shift()!
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error("GitHub request aborted"))
        continue
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort)
      }
      active++
      waiter.resolve()
    }
  }

  return {
    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await new Promise<void>((resolve, reject) => {
        const waiter: (typeof waiters)[number] = { resolve, reject, signal }
        if (signal) {
          waiter.onAbort = () => {
            const index = waiters.indexOf(waiter)
            if (index >= 0) waiters.splice(index, 1)
            reject(signal.reason ?? new Error("GitHub request aborted"))
          }
          signal.addEventListener("abort", waiter.onAbort, { once: true })
        }
        waiters.push(waiter)
        drain()
      })
      try {
        if (signal?.aborted) throw signal.reason ?? new Error("GitHub request aborted")
        return await task()
      } finally {
        active--
        drain()
      }
    },
  }
}

export function createGithubEvidenceCache(maxConcurrentRequests = 6): GithubEvidenceCache {
  return {
    metadata: new Map(),
    readme: new Map(),
    requestGate: createGithubRequestGate(Math.max(1, maxConcurrentRequests)),
  }
}

export const GITHUB_SOURCE_TIMEOUT_MS = 180_000

type GithubEvidenceAudit = NonNullable<NormalizedItem["githubMeta"]>["evidence"]

interface GithubRepoDecision {
  assessment: GithubAiEligibility
  evidence: GithubEvidenceAudit
}

type TrendingPeriod = "daily" | "weekly" | "monthly"

function githubHeaders(pat?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    ...(pat ? { authorization: `Bearer ${pat}` } : {}),
  }
}

function parseReadmeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { content?: unknown; encoding?: unknown }
    if (parsed.encoding === "base64" && typeof parsed.content === "string") {
      return Buffer.from(parsed.content.replace(/\s+/g, ""), "base64").toString("utf8")
    }
  } catch {
    // 测试/兼容端点可直接返回 README 纯文本
  }
  return body
}

async function assessRepo(
  evidence: GithubRepoEvidence,
  ctx: Parameters<DigestSource["fetch"]>[0],
  opts: GithubSourceOptions,
): Promise<GithubRepoDecision> {
  let assessment = await assessGithubAiEligibility(evidence)
  let audit: GithubEvidenceAudit = {
    topics: evidence.topics,
    metadataStatus: evidence.topics.length > 0 ? "embedded" : "not_requested",
    readmeStatus: "not_requested",
    evidenceComplete: evidence.evidenceComplete,
  }
  if (assessment.state !== "unknown" || !opts.pat) return { assessment, evidence: audit }

  const cache = opts.evidenceCache ?? createGithubEvidenceCache()
  let metadataTask = cache.metadata.get(evidence.repo)
  if (!metadataTask) {
    metadataTask = (async (): Promise<GithubMetadataEvidence> => {
      try {
        const body = await cache.requestGate.run(
          () =>
            ctx.http.fetchText(`https://api.github.com/repos/${evidence.repo}`, {
              headers: githubHeaders(opts.pat),
              signal: ctx.signal,
            }),
          ctx.signal,
        )
        const parsed = JSON.parse(body) as { topics?: unknown }
        return {
          status: "loaded",
          topics: Array.isArray(parsed.topics)
            ? parsed.topics.filter((topic): topic is string => typeof topic === "string")
            : [],
        }
      } catch {
        return { status: "failed", topics: [] }
      }
    })()
    cache.metadata.set(evidence.repo, metadataTask)
  }
  const metadata = await metadataTask
  if (metadata.status === "failed" && cache.metadata.get(evidence.repo) === metadataTask) {
    cache.metadata.delete(evidence.repo)
  }
  audit = {
    ...audit,
    topics: metadata.topics,
    metadataStatus: metadata.status,
    evidenceComplete: false,
  }
  if (metadata.status === "failed") {
    return {
      assessment: await assessGithubAiEligibility({ ...evidence, evidenceComplete: false }),
      evidence: audit,
    }
  }

  assessment = await assessGithubAiEligibility({
    ...evidence,
    topics: metadata.topics,
    evidenceComplete: false,
  })
  if (assessment.state !== "unknown") return { assessment, evidence: audit }

  let readmeTask = cache.readme.get(evidence.repo)
  if (!readmeTask) {
    readmeTask = (async (): Promise<GithubReadmeEvidence> => {
      try {
        const body = await cache.requestGate.run(
          () =>
            ctx.http.fetchText(`https://api.github.com/repos/${evidence.repo}/readme`, {
              headers: githubHeaders(opts.pat),
              signal: ctx.signal,
            }),
          ctx.signal,
        )
        return { status: "loaded", text: parseReadmeBody(body).slice(0, 20_000) }
      } catch {
        return { status: "failed", text: null }
      }
    })()
    cache.readme.set(evidence.repo, readmeTask)
  }
  const readme = await readmeTask
  if (readme.status === "failed" && cache.readme.get(evidence.repo) === readmeTask) {
    cache.readme.delete(evidence.repo)
  }
  audit = {
    ...audit,
    readmeStatus: readme.status,
    evidenceComplete: metadata.status === "loaded" && readme.status === "loaded",
  }
  return {
    assessment: await assessGithubAiEligibility({
      ...evidence,
      topics: metadata.topics,
      readme: readme.text,
      evidenceComplete: audit.evidenceComplete,
    }),
    evidence: audit,
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  map: (value: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < values.length) {
      if (signal?.aborted) throw signal.reason ?? new Error("GitHub eligibility aborted")
      const index = cursor++
      output[index] = await map(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return output
}

function compareGrowth(a: TrendingRepo, b: TrendingRepo): number {
  return (
    b.windowStars - a.windowStars ||
    b.totalStars - a.totalStars ||
    a.repo.localeCompare(b.repo, "en")
  )
}

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
    timeoutBudgetMs: GITHUB_SOURCE_TIMEOUT_MS,
    async fetch(ctx): Promise<NormalizedItem[]> {
      const evidenceCache = opts.evidenceCache ?? createGithubEvidenceCache()
      const html = await evidenceCache.requestGate.run(
        () =>
          ctx.http.fetchText(`https://github.com/trending?since=${period}`, {
            signal: ctx.signal,
          }),
        ctx.signal,
      )
      const repos = parseTrendingHtml(html)
      if (repos.length === 0)
        throw new Error("trending parse produced 0 repos（页面改版？检查解析器）")

      const effectiveOpts = {
        ...opts,
        evidenceCache,
      }
      const assessed = await mapWithConcurrency(
        repos.slice(0, 100),
        6,
        async (repo) => ({
          repo,
          decision: await assessRepo(
            {
              repo: repo.repo,
              description: repo.description,
              topics: [],
              readme: null,
              evidenceComplete: false,
            },
            ctx,
            effectiveOpts,
          ),
        }),
        ctx.signal,
      )

      return assessed
        .sort((a, b) => compareGrowth(a.repo, b.repo))
        .map(({ repo: r, decision }) => {
          const item = buildNormalizedItem(
            sourceId,
            "github",
            r.repo,
            `https://github.com/${r.repo}`,
            null,
            `+${starsFmt(r.windowStars)} ${starsPhrase} · ★${starsFmt(r.totalStars)}${r.language ? ` · ${r.language}` : ""} · ${r.description}`,
          )
          return {
            ...item,
            githubMeta: {
              repo: r.repo,
              period,
              windowStars: r.windowStars,
              totalStars: r.totalStars,
              language: r.language,
              description: r.description,
              evidence: decision.evidence,
              eligibility: decision.assessment,
            },
          }
        })
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

/** 新秀子榜：全站近 7 天新仓先做 AI 准入，再按创建以来真实增星（total stars）排序。 */
export function makeGithubNewcomersSource(opts: GithubSourceOptions = {}): DigestSource {
  return {
    sourceId: "github-ai-newcomers",
    category: "github",
    timeoutBudgetMs: GITHUB_SOURCE_TIMEOUT_MS,
    async fetch(ctx): Promise<NormalizedItem[]> {
      const since = new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
      const q = encodeURIComponent(`created:>${since}`)
      const evidenceCache = opts.evidenceCache ?? createGithubEvidenceCache()
      const effectiveOpts = { ...opts, evidenceCache }
      const body = await evidenceCache.requestGate.run(
        () =>
          ctx.http.fetchText(
            `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=100`,
            {
              headers: githubHeaders(opts.pat),
              signal: ctx.signal,
            },
          ),
        ctx.signal,
      )
      const j = JSON.parse(body) as { items?: Array<Record<string, unknown>> }
      const candidates = (Array.isArray(j.items) ? j.items : [])
        .map((rec) => ({
          rec,
          repo: typeof rec.full_name === "string" ? rec.full_name : "",
          description: typeof rec.description === "string" ? rec.description : "",
          topics: Array.isArray(rec.topics)
            ? rec.topics.filter((topic): topic is string => typeof topic === "string")
            : [],
          totalStars: Number(rec.stargazers_count),
        }))
        .filter(
          (candidate) =>
            candidate.repo.includes("/") &&
            Number.isFinite(candidate.totalStars) &&
            candidate.totalStars > 0,
        )
      const assessed = await mapWithConcurrency(
        candidates,
        6,
        async (candidate) => ({
          ...candidate,
          decision: await assessRepo(
            {
              repo: candidate.repo,
              description: candidate.description,
              topics: candidate.topics,
              readme: null,
              evidenceComplete: false,
            },
            ctx,
            effectiveOpts,
          ),
        }),
        ctx.signal,
      )
      return assessed
        .sort((a, b) => b.totalStars - a.totalStars || a.repo.localeCompare(b.repo, "en"))
        .map(({ repo, description, totalStars, decision }) => {
          const item = buildNormalizedItem(
            "github-ai-newcomers",
            "github",
            `🆕 ${repo}`,
            `https://github.com/${repo}`,
            // publishedAt 恒 null（德彪 DE-r2 P2）：四路 GH 榜必须同为 null，跨榜同 repo 的
            // dedupe 才是「先到者赢」= 源数组顺序（日>周>新秀>月）；此前带 created_at 会让
            // 新秀项顶掉 daily 项。新仓时效已在 snippet 文案（"新仓 7 天"）与搜索窗本身表达
            null,
            `新仓 7 天 ★${starsFmt(totalStars)} · ${description}`,
          )
          return {
            ...item,
            githubMeta: {
              repo,
              period: "newcomer",
              windowStars: totalStars,
              totalStars,
              language: "",
              description,
              evidence: decision.evidence,
              eligibility: decision.assessment,
            },
          }
        })
    },
  }
}
