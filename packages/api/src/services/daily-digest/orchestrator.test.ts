import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildNormalizedItem } from "./feed-parsers"
import { dedupeItems, runAllSources } from "./orchestrator"
import type { DigestSource, SafeHttpClient, SourceFetchResult } from "./types"

const http: SafeHttpClient = { fetchText: async () => "" }

function src(sourceId: string, fetch: DigestSource["fetch"]): DigestSource {
  return { sourceId, category: "ai", fetch }
}

const item = (source: string, url: string, publishedAt: string | null = null) =>
  buildNormalizedItem(source, "ai", `t-${url}`, url, publishedAt, "s")

describe("runAllSources（AC8 单源隔离）", () => {
  it("一源抛错、一源超时、一源正常 → 三种 status，正常源条目保留", async () => {
    const sources = [
      src("ok-src", async () => [item("ok-src", "https://a.com/1")]),
      src("boom-src", async () => {
        throw new Error("boom")
      }),
      src("slow-src", () => new Promise(() => {})),
    ]
    const { results, items } = await runAllSources(sources, { http, perSourceTimeoutMs: 100 })
    const by = new Map(results.map((r) => [r.sourceId, r]))
    assert.equal(by.get("ok-src")?.status, "ok")
    assert.equal(by.get("boom-src")?.status, "failed")
    assert.match(by.get("boom-src")?.errors[0] ?? "", /boom/)
    assert.equal(by.get("slow-src")?.status, "timeout")
    assert.equal(items.length, 1)
  })

  it("源自带 timeoutBudgetMs 覆盖默认单源超时（X 限速长跑源不被 45s 掐死）", async () => {
    const slowButBudgeted: DigestSource = {
      sourceId: "x-firsthand",
      category: "community",
      timeoutBudgetMs: 500,
      fetch: () =>
        new Promise((r) => setTimeout(() => r([item("x-firsthand", "https://x.com/a/1")]), 60)),
    }
    const { results } = await runAllSources([slowButBudgeted], { http, perSourceTimeoutMs: 10 })
    assert.equal(results[0].status, "ok")
    assert.equal(results[0].items.length, 1)
  })

  it("健康结果落 store", async () => {
    const recorded: Array<{ date: string; results: SourceFetchResult[] }> = []
    await runAllSources([src("s1", async () => [item("s1", "https://a.com/1")])], {
      http,
      health: {
        record: (date, results) => recorded.push({ date, results }),
        consecutiveFailures: () => 0,
      },
      healthDate: "2026-07-03",
    })
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].date, "2026-07-03")
    assert.equal(recorded[0].results[0].sourceId, "s1")
  })
})

describe("dedupeItems 跨源去重", () => {
  it("同 dedupeKey 保留 publishedAt 较新者", () => {
    const older = item("src-a", "https://espn.com/story/1?utm_source=rss", "2026-07-01T00:00:00Z")
    const newer = item("src-b", "https://ESPN.com/story/1/", "2026-07-02T00:00:00Z")
    assert.equal(older.dedupeKey, newer.dedupeKey)
    const out = dedupeItems([older, newer])
    assert.equal(out.length, 1)
    assert.equal(out[0].sourceId, "src-b")
  })
  it("publishedAt null 视为最旧", () => {
    const noDate = item("src-a", "https://a.com/x", null)
    const dated = item("src-b", "https://a.com/x", "2026-07-01T00:00:00Z")
    assert.equal(dedupeItems([dated, noDate])[0].sourceId, "src-b")
  })
})
