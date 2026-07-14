import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { runAllSources } from "../orchestrator"
import type { SafeHttpClient, SourceFetchContext } from "../types"
import {
  createGithubEvidenceCache,
  makeGithubDailySource,
  makeGithubMonthlySource,
  makeGithubNewcomersSource,
  makeGithubWeeklySource,
  parseTrendingHtml,
} from "./github-trending"

const FIX = path.join(__dirname, "..", "__fixtures__")
const trendingHtml = fs.readFileSync(path.join(FIX, "trending.weekly.html"), "utf8")
const NOW = new Date("2026-07-06T08:00:00+08:00")

function trendingArticle(input: {
  repo: string
  description: string
  starsPhrase?: "stars today" | "stars this week" | "stars this month"
  windowStars?: number
  totalStars?: number
  language?: string
}): string {
  const phrase =
    input.starsPhrase && input.windowStars !== undefined
      ? `<span>${input.windowStars.toLocaleString("en-US")} ${input.starsPhrase}</span>`
      : ""
  return `<article>
    <h2><a href="/${input.repo}">${input.repo}</a></h2>
    <p class="col-9 color-fg-muted">${input.description}</p>
    <span itemprop="programmingLanguage">${input.language ?? "TypeScript"}</span>
    <a href="/${input.repo}/stargazers"><svg></svg> ${(input.totalStars ?? 1_000).toLocaleString("en-US")}</a>
    ${phrase}
  </article>`
}

function ctxWith(http: SafeHttpClient): SourceFetchContext {
  return { http, signal: new AbortController().signal, now: () => NOW }
}

describe("parseTrendingHtml（真实 fixture）", () => {
  it("解析出 repo/desc/周增星/总星", () => {
    const repos = parseTrendingHtml(trendingHtml)
    assert.ok(repos.length >= 5)
    for (const r of repos) {
      assert.match(r.repo, /^[^/]+\/[^/]+$/)
      assert.ok(r.windowStars > 0, `${r.repo} windowStars`)
      assert.ok(r.totalStars >= 0, `${r.repo} totalStars`)
    }
  })
  it("单条缺少可靠窗口增星数 → 该条失败关闭，不以 0 混入榜单", () => {
    const html = [
      trendingArticle({
        repo: "ai/valid-growth",
        description: "LLM inference runtime",
        starsPhrase: "stars today",
        windowStars: 81,
      }),
      trendingArticle({
        repo: "ai/missing-growth",
        description: "LLM inference runtime whose growth metric failed to parse",
      }),
    ].join("\n")

    assert.deepEqual(
      parseTrendingHtml(html).map((repo) => repo.repo),
      ["ai/valid-growth"],
    )
  })
  it("页面改版（空 HTML）→ 0 repos", () => {
    assert.equal(parseTrendingHtml("<html><body>changed</body></html>").length, 0)
  })
})

describe("makeGithubWeeklySource", () => {
  it("无 PAT：snippet 含周增数", async () => {
    const http: SafeHttpClient = { fetchText: async () => trendingHtml }
    const items = await makeGithubWeeklySource().fetch(ctxWith(http))
    assert.ok(items.length >= 5)
    assert.match(items[0].rawSnippet, /stars this week/)
    assert.match(items[0].canonicalUrl, /^https:\/\/github\.com\//)
    assert.equal(items[0].category, "github")
  })
  it("解析 0 repos → 抛（orchestrator 记 failed，页面改版可观测）", async () => {
    const http: SafeHttpClient = { fetchText: async () => "<html></html>" }
    await assert.rejects(makeGithubWeeklySource().fetch(ctxWith(http)))
  })
})

describe("makeGithubMonthlySource（#27 月榜，主表 v2.1）", () => {
  it("since=monthly + 解析 stars this month + sourceId 独立", async () => {
    const monthlyHtml = trendingHtml.replace(/stars this week/g, "stars this month")
    const seen: string[] = []
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        seen.push(url)
        return monthlyHtml
      },
    }
    const items = await makeGithubMonthlySource().fetch(ctxWith(http))
    assert.match(seen[0], /since=monthly/)
    assert.ok(items.length >= 5)
    assert.equal(items[0].sourceId, "github-trending-monthly")
    assert.match(items[0].rawSnippet, /stars this month/)
  })
})

describe("makeGithubDailySource（#2 增长榜·日，07-05 分栏改版）", () => {
  it("since=daily + 解析 stars today + sourceId 独立", async () => {
    const dailyHtml = trendingHtml.replace(/stars this week/g, "stars today")
    const seen: string[] = []
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        seen.push(url)
        return dailyHtml
      },
    }
    const items = await makeGithubDailySource().fetch(ctxWith(http))
    assert.match(seen[0], /since=daily/)
    assert.ok(items.length >= 5)
    assert.equal(items[0].sourceId, "github-trending-daily")
    assert.match(items[0].rawSnippet, /^\+[\d,]+ stars today/)
  })

  it("AI 准入只做门槛：准入后严格按 windowStars 降序，不再乘 topic/描述倍率", async () => {
    const html = [
      trendingArticle({
        repo: "ai/strong-signal-lower-growth",
        description: "Model Context Protocol server for coding agents",
        starsPhrase: "stars today",
        windowStars: 444,
        totalStars: 2_486,
      }),
      trendingArticle({
        repo: "ai/higher-growth",
        description: "LLM inference engine",
        starsPhrase: "stars today",
        windowStars: 661,
        totalStars: 6_661,
      }),
    ].join("\n")
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        if (url.includes("/trending?")) return html
        if (url.endsWith("/ai/strong-signal-lower-growth"))
          return JSON.stringify({ topics: ["mcp", "model-context-protocol"] })
        if (url.endsWith("/ai/higher-growth")) return JSON.stringify({ topics: [] })
        if (url.endsWith("/readme")) return "This repository is core AI engineering infrastructure."
        throw new Error(`unexpected URL: ${url}`)
      },
    }

    const items = await makeGithubDailySource({ pat: "test-token" }).fetch(ctxWith(http))
    assert.deepEqual(
      items.slice(0, 2).map((item) => item.title),
      ["ai/higher-growth", "ai/strong-signal-lower-growth"],
    )
  })

  it("windowStars 相同 → totalStars 降序，再以 repo 名稳定打破平局", async () => {
    const html = [
      trendingArticle({
        repo: "z/low-total",
        description: "LLM inference runtime",
        starsPhrase: "stars today",
        windowStars: 500,
        totalStars: 900,
      }),
      trendingArticle({
        repo: "z/high-total",
        description: "LLM inference runtime",
        starsPhrase: "stars today",
        windowStars: 500,
        totalStars: 2_000,
      }),
      trendingArticle({
        repo: "a/high-total",
        description: "LLM inference runtime",
        starsPhrase: "stars today",
        windowStars: 500,
        totalStars: 2_000,
      }),
    ].join("\n")
    const http: SafeHttpClient = { fetchText: async () => html }

    const items = await makeGithubDailySource().fetch(ctxWith(http))
    assert.deepEqual(
      items.map((item) => item.title),
      ["a/high-total", "z/high-total", "z/low-total"],
    )
  })

  it("源保留 yes/no/unknown 审计证据；发布端只消费 yes", async () => {
    const html = [
      trendingArticle({
        repo: "Free-TV/IPTV",
        description: "Public IPTV channel list",
        starsPhrase: "stars today",
        windowStars: 900,
        totalStars: 30_000,
      }),
      trendingArticle({
        repo: "Panniantong/Agent-Reach",
        description: "AI agent search and retrieval across the web",
        starsPhrase: "stars today",
        windowStars: 800,
        totalStars: 12_000,
      }),
      trendingArticle({
        repo: "ops/generic-agent",
        description: "Lightweight monitoring agent",
        starsPhrase: "stars today",
        windowStars: 700,
        totalStars: 9_000,
      }),
    ].join("\n")
    const http: SafeHttpClient = { fetchText: async () => html }

    const items = await makeGithubDailySource().fetch(ctxWith(http))
    assert.deepEqual(
      items.map((item) => [item.title, item.githubMeta?.eligibility.state]),
      [
        ["Free-TV/IPTV", "no"],
        ["Panniantong/Agent-Reach", "yes"],
        ["ops/generic-agent", "no"],
      ],
    )
    assert.deepEqual(items[1].githubMeta?.evidence.topics, [])
    assert.equal(items[1].githubMeta?.evidence.readmeStatus, "not_requested")
    assert.ok((items[0].githubMeta?.eligibility.reasons.length ?? 0) > 0)
  })

  it("共享缓存只缓存 API 事实：先到的 unknown 不得污染后续同仓强证据", async () => {
    const weak = trendingArticle({
      repo: "owner/shared-repo",
      description: "General agent toolkit",
      starsPhrase: "stars today",
      windowStars: 100,
    })
    const strong = trendingArticle({
      repo: "owner/shared-repo",
      description: "LLM inference engine and model serving runtime",
      starsPhrase: "stars today",
      windowStars: 100,
    })
    let trendingCalls = 0
    let metadataCalls = 0
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        if (url.includes("/trending?")) return trendingCalls++ === 0 ? weak : strong
        metadataCalls++
        throw new Error("metadata unavailable")
      },
    }
    const options = { pat: "test-token", evidenceCache: createGithubEvidenceCache() }

    const first = await makeGithubDailySource(options).fetch(ctxWith(http))
    const second = await makeGithubDailySource(options).fetch(ctxWith(http))
    assert.equal(first[0].githubMeta?.eligibility.state, "unknown")
    assert.equal(second[0].githubMeta?.eligibility.state, "yes")
    assert.equal(metadataCalls, 1)
  })
})

describe("makeGithubNewcomersSource", () => {
  it("从全站近 7 天新仓取候选，不再把候选池限定为 topic:mcp", async () => {
    const seen: string[] = []
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        seen.push(url)
        return JSON.stringify({
          items: [
            {
              full_name: "x/mcp-fresh",
              html_url: "https://github.com/x/mcp-fresh",
              description: "new mcp server",
              stargazers_count: 900,
              created_at: "2026-07-01T00:00:00Z",
            },
          ],
        })
      },
    }
    const items = await makeGithubNewcomersSource().fetch(ctxWith(http))
    assert.equal(items.length, 1)
    assert.match(items[0].title, /mcp-fresh/)
    assert.match(items[0].rawSnippet, /★900/)
    assert.match(seen[0], /created%3A%3E2026-06-29/)
    assert.doesNotMatch(decodeURIComponent(seen[0]), /topic:mcp/i)
    // 德彪 DE-r2 P2：四路 GH 榜 publishedAt 必须同为 null——跨榜同 repo 的 dedupe
    // 才是「先到者赢」（源数组顺序 daily 优先）；带 created_at 会让新秀项顶掉 daily 项
    assert.equal(items[0].publishedAt, null)
  })

  it("Search API 即使返回乱序，也按新仓创建以来真实增星（total stars）降序", async () => {
    const http: SafeHttpClient = {
      fetchText: async () =>
        JSON.stringify({
          items: [
            {
              full_name: "ai/lower-growth",
              html_url: "https://github.com/ai/lower-growth",
              description: "LLM agent framework",
              topics: ["llm"],
              stargazers_count: 120,
              created_at: "2026-07-01T00:00:00Z",
            },
            {
              full_name: "ai/higher-growth",
              html_url: "https://github.com/ai/higher-growth",
              description: "AI inference runtime",
              topics: ["inference"],
              stargazers_count: 480,
              created_at: "2026-07-02T00:00:00Z",
            },
          ],
        }),
    }

    const items = await makeGithubNewcomersSource().fetch(ctxWith(http))
    assert.deepEqual(
      items.map((item) => item.title),
      ["🆕 ai/higher-growth", "🆕 ai/lower-growth"],
    )
  })

  it("PAT 补证据采用有界并发（>1 且 ≤6），完成后仍严格按真实增星排序", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      full_name: `owner/assistant-${index}`,
      description: "General assistant toolkit",
      topics: ["assistant"],
      stargazers_count: 1_000 - index,
    }))
    let inFlight = 0
    let maxInFlight = 0
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        if (url.includes("/search/repositories")) return JSON.stringify({ items: candidates })
        if (url.endsWith("/readme")) throw new Error("README should not be needed")
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 8))
        inFlight--
        return JSON.stringify({ topics: ["llm"] })
      },
    }

    const items = await makeGithubNewcomersSource({ pat: "test-token" }).fetch(ctxWith(http))
    assert.ok(maxInFlight > 1)
    assert.ok(maxInFlight <= 6)
    assert.deepEqual(
      items.map((item) => item.githubMeta?.totalStars),
      candidates.map((candidate) => candidate.stargazers_count),
    )
  })

  it("orchestrator abort 后不再领取剩余候选补证据", async () => {
    const controller = new AbortController()
    const candidates = Array.from({ length: 18 }, (_, index) => ({
      full_name: `owner/agent-${index}`,
      description: "General agent toolkit",
      topics: ["agent"],
      stargazers_count: 500 - index,
    }))
    let metadataCalls = 0
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        if (url.includes("/search/repositories")) return JSON.stringify({ items: candidates })
        metadataCalls++
        if (metadataCalls === 1) controller.abort(new Error("source timeout"))
        await new Promise((resolve) => setTimeout(resolve, 5))
        return JSON.stringify({ topics: ["llm"] })
      },
    }
    const ctx: SourceFetchContext = { ...ctxWith(http), signal: controller.signal }

    await assert.rejects(makeGithubNewcomersSource({ pat: "test-token" }).fetch(ctx))
    assert.ok(metadataCalls < candidates.length)
  })

  it("abort 必须取消已启动的 GitHub 请求，失败证据不得污染共享缓存", async () => {
    const cache = createGithubEvidenceCache()
    const source = makeGithubDailySource({ pat: "test-token", evidenceCache: cache })
    const html = trendingArticle({
      repo: "owner/assistant",
      description: "General assistant toolkit",
      starsPhrase: "stars today",
      windowStars: 100,
    })
    let metadataCalls = 0
    let abortedInFlight = false
    let notifyMetadataStarted: (() => void) | undefined
    const metadataStarted = new Promise<void>((resolve) => {
      notifyMetadataStarted = resolve
    })
    const http: SafeHttpClient = {
      fetchText: async (url, opts) => {
        if (url.includes("/trending?")) return html
        if (url.endsWith("/readme")) throw new Error("topics should resolve eligibility")
        metadataCalls++
        if (metadataCalls > 1) return JSON.stringify({ topics: ["llm"] })
        notifyMetadataStarted?.()
        const signal = (opts as { signal?: AbortSignal } | undefined)?.signal
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => resolve(JSON.stringify({ topics: ["llm"] })), 60)
          signal?.addEventListener(
            "abort",
            () => {
              abortedInFlight = true
              clearTimeout(timer)
              reject(signal.reason ?? new Error("aborted"))
            },
            { once: true },
          )
        })
      },
    }
    const firstController = new AbortController()
    const first = source.fetch({ http, signal: firstController.signal, now: () => NOW })
    await metadataStarted
    firstController.abort(new Error("source timeout"))
    await first.catch(() => [])

    assert.equal(abortedInFlight, true, "已启动请求必须收到 source abort")
    const second = await source.fetch(ctxWith(http))
    assert.equal(metadataCalls, 2, "abort/失败结果不得作为证据事实缓存")
    assert.equal(second[0].githubMeta?.eligibility.state, "yes")
  })

  it("四榜共享全局 API 并发闸，且证据补全不受 45s 默认单源预算误杀", async () => {
    const cache = createGithubEvidenceCache()
    const options = { pat: "test-token", evidenceCache: cache }
    const sources = [
      makeGithubDailySource(options),
      makeGithubWeeklySource(options),
      makeGithubMonthlySource(options),
      makeGithubNewcomersSource(options),
    ]
    let inFlight = 0
    let maxInFlight = 0
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          await new Promise((resolve) => setTimeout(resolve, 12))
          if (url.includes("/trending?")) {
            const period = new URL(url).searchParams.get("since") ?? "unknown"
            const phrase =
              period === "daily"
                ? "stars today"
                : period === "monthly"
                  ? "stars this month"
                  : "stars this week"
            return Array.from({ length: 8 }, (_, index) =>
              trendingArticle({
                repo: `${period}/assistant-${index}`,
                description: "General assistant toolkit",
                starsPhrase: phrase,
                windowStars: 100 - index,
              }),
            ).join("\n")
          }
          if (url.includes("/search/repositories")) {
            return JSON.stringify({
              items: Array.from({ length: 8 }, (_, index) => ({
                full_name: `new/assistant-${index}`,
                description: "General assistant toolkit",
                topics: ["assistant"],
                stargazers_count: 200 - index,
              })),
            })
          }
          if (url.endsWith("/readme")) throw new Error("topics should resolve eligibility")
          return JSON.stringify({ topics: ["llm"] })
        } finally {
          inFlight--
        }
      },
    }

    const { results } = await runAllSources(sources, {
      http,
      perSourceTimeoutMs: 5,
      now: () => NOW,
    })

    assert.deepEqual(
      results.map((result) => result.status),
      ["ok", "ok", "ok", "ok"],
    )
    assert.ok(maxInFlight > 1)
    assert.ok(maxInFlight <= 6, `四榜全部 GitHub 请求共享闸，峰值不得超过 6，实际 ${maxInFlight}`)
  })
})
