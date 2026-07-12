import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import type { SafeHttpClient, SourceFetchContext } from "../types"
import {
  aiWeight,
  makeGithubDailySource,
  makeGithubMonthlySource,
  makeGithubNewcomersSource,
  makeGithubWeeklySource,
  parseTrendingHtml,
} from "./github-trending"

const FIX = path.join(__dirname, "..", "__fixtures__")
const trendingHtml = fs.readFileSync(path.join(FIX, "trending.weekly.html"), "utf8")
const NOW = new Date("2026-07-06T08:00:00+08:00")

function ctxWith(http: SafeHttpClient): SourceFetchContext {
  return { http, signal: new AbortController().signal, now: () => NOW }
}

describe("parseTrendingHtml（真实 fixture）", () => {
  it("解析出 repo/desc/周增星/总星", () => {
    const repos = parseTrendingHtml(trendingHtml)
    assert.ok(repos.length >= 5)
    for (const r of repos) {
      assert.match(r.repo, /^[^/]+\/[^/]+$/)
      assert.ok(r.weeklyStars > 0, `${r.repo} weeklyStars`)
      assert.ok(r.totalStars >= r.weeklyStars * 0, `${r.repo} totalStars`)
    }
  })
  it("页面改版（空 HTML）→ 0 repos", () => {
    assert.equal(parseTrendingHtml("<html><body>changed</body></html>").length, 0)
  })
})

describe("aiWeight 加权", () => {
  const base = {
    repo: "a/b",
    description: "a plain tool",
    weeklyStars: 100,
    language: "",
    totalStars: 100,
  }
  it("topic 命中 > desc 命中 > 无命中", () => {
    const none = aiWeight(base)
    const desc = aiWeight({ ...base, description: "an LLM agent framework" })
    const topic = aiWeight(base, ["mcp"])
    assert.ok(topic > desc && desc > none)
  })
})

describe("makeGithubWeeklySource", () => {
  it("无 PAT：按 desc 加权排序，AI 项目靠前；snippet 含周增数", async () => {
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
})

describe("makeGithubNewcomersSource", () => {
  it("search API JSON → 新贵条目（created:>7 天前）", async () => {
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
    // 德彪 DE-r2 P2：四路 GH 榜 publishedAt 必须同为 null——跨榜同 repo 的 dedupe
    // 才是「先到者赢」（源数组顺序 daily 优先）；带 created_at 会让新秀项顶掉 daily 项
    assert.equal(items[0].publishedAt, null)
  })
})
