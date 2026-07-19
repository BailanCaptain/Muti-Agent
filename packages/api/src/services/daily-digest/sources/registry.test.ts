import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { SafeHttpError } from "../../../net/safe-http-client"
import { buildNormalizedItem } from "../feed-parsers"
import type { SafeHttpClient, SourceFetchContext } from "../types"
import {
  JSON_SOURCES,
  RSS_SOURCES,
  buildAllSources,
  deriveOutboundAllowlist,
  makeJsonSource,
  makeRssSource,
  mapJsonItems,
} from "./registry"

const FIX = path.join(__dirname, "..", "__fixtures__")
const NOW = new Date("2026-07-03T00:00:00+08:00")

function ctxWith(http: SafeHttpClient): SourceFetchContext {
  return { http, signal: new AbortController().signal, now: () => NOW }
}

describe("registry 结构约束", () => {
  it("sourceId 无重复", () => {
    const ids = buildAllSources().map((s) => s.sourceId)
    assert.equal(new Set(ids).size, ids.length)
  })

  it("所有源 URL 的 host 都在推导出的白名单里", () => {
    const allow = new Set(deriveOutboundAllowlist(NOW))
    for (const def of [...RSS_SOURCES, ...JSON_SOURCES]) {
      for (const u of def.urls) {
        const url = typeof u === "function" ? u(NOW) : u
        assert.ok(allow.has(new URL(url).hostname.toLowerCase()), `${def.sourceId}: ${url}`)
      }
    }
  })

  it("常驻类目全覆盖（X/小红书/github 由 boot/job 层按开关注入；v2ex 落社区）", () => {
    const cats = new Set(buildAllSources().map((s) => s.category))
    for (const c of ["ai", "hot", "community"]) assert.ok(cats.has(c as never), c)
  })

  it("v2ex-hot keepIf 接科技词表（E2 社区聚焦：生活/职场贴不进社区板块）", () => {
    const def = JSON_SOURCES.find((d) => d.sourceId === "v2ex-hot")
    assert.ok(def?.keepIf, "v2ex-hot 必须挂 keepIf")
    const mk = (title: string) =>
      buildNormalizedItem("v2ex-hot", "community", title, "https://www.v2ex.com/t/1", null, "")
    assert.equal(def.keepIf?.(mk("大模型本地部署显卡怎么选")), true)
    assert.equal(def.keepIf?.(mk("30 岁裸辞去大理的生活")), false)
  })
})

describe("JSON source map（真实 fixture 逐源验证）", () => {
  const fixtureBySource: Record<string, string> = {
    "hf-daily-papers": "hf.dailypapers.json",
    "hn-ai": "hn.algolia.json",
    "zhihu-hot": "zhihu.hotlist.json",
    "baidu-hot": "baidu.board.json",
    "toutiao-hot": "toutiao.board.json",
    "ai-hot": "aihot.items.json",
    "v2ex-hot": "v2ex.hot.json",
  }

  for (const def of JSON_SOURCES) {
    it(`${def.sourceId} 从 fixture 映射出合法条目`, () => {
      const fixture = fixtureBySource[def.sourceId]
      assert.ok(fixture, `缺 fixture 映射: ${def.sourceId}`)
      const json = JSON.parse(fs.readFileSync(path.join(FIX, fixture), "utf8"))
      const items = mapJsonItems(def, json)
      assert.ok(items.length > 0, "应映射出至少 1 条")
      for (const item of items) {
        assert.ok(item.title.length > 0)
        assert.match(item.canonicalUrl, /^https?:\/\//)
        assert.equal(item.sourceId, def.sourceId)
        if (item.publishedAt !== null)
          assert.ok(!Number.isNaN(Date.parse(item.publishedAt)), item.publishedAt)
      }
    })
  }

  it("ai-hot 摘要带来源前缀；v2ex 链接是帖子页且摘要带回复数（主表 #20/#21）", () => {
    const aihot = JSON.parse(fs.readFileSync(path.join(FIX, "aihot.items.json"), "utf8"))
    const aihotItems = mapJsonItems(JSON_SOURCES.find((d) => d.sourceId === "ai-hot")!, aihot)
    assert.ok(aihotItems.length > 0)
    assert.match(aihotItems[0].rawSnippet, /^\[.+\]/)
    const v2ex = JSON.parse(fs.readFileSync(path.join(FIX, "v2ex.hot.json"), "utf8"))
    const v2exItems = mapJsonItems(JSON_SOURCES.find((d) => d.sourceId === "v2ex-hot")!, v2ex)
    assert.ok(v2exItems.length > 0)
    assert.match(v2exItems[0].canonicalUrl, /v2ex\.com\/t\/\d+/)
    assert.match(v2exItems[0].rawSnippet, /回复/)
    assert.equal(v2exItems[0].engagement, Number(v2ex[0].replies))
  })

  it("engagement 信号落字段（质量层 1：hn points / hf upvotes / 热榜热度 / ai-hot 策展分）", () => {
    const load = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"))
    const map = (id: string, json: unknown) =>
      mapJsonItems(JSON_SOURCES.find((d) => d.sourceId === id)!, json)
    const hn = load("hn.algolia.json")
    assert.equal(map("hn-ai", hn)[0]?.engagement, Number(hn.hits[0].points))
    const hf = load("hf.dailypapers.json")
    assert.ok((map("hf-daily-papers", hf)[0]?.engagement ?? 0) >= 0)
    const aihot = load("aihot.items.json")
    assert.equal(map("ai-hot", aihot)[0].engagement, Number(aihot.items[0].score))
    const baidu = load("baidu.board.json")
    assert.ok((map("baidu-hot", baidu)[0].engagement ?? 0) > 0)
    const toutiao = load("toutiao.board.json")
    assert.ok((map("toutiao-hot", toutiao)[0].engagement ?? 0) > 0)
  })

  it("zhihu 条目 URL 是 www.zhihu.com/question/{完整id}（防精度丢失）", () => {
    const json = JSON.parse(fs.readFileSync(path.join(FIX, "zhihu.hotlist.json"), "utf8"))
    const def = JSON_SOURCES.find((d) => d.sourceId === "zhihu-hot")
    const items = mapJsonItems(def!, json)
    assert.match(items[0].canonicalUrl, /^https:\/\/www\.zhihu\.com\/question\/\d{10,}$/)
    // 与原始 api url 里的 id 严格一致（未经 Number 转换）
    const apiId = String((json.data[0].target as { url: string }).url).match(
      /questions\/(\d+)/,
    )?.[1]
    assert.ok(items[0].canonicalUrl.endsWith(`/${apiId}`))
  })
})

describe("fallback 链", () => {
  it("smol-ai 使用源级 3 MiB 响应预算，普通 RSS 仍沿用共享默认", async () => {
    const rss = fs.readFileSync(path.join(FIX, "openai.rss.xml"), "utf8")
    const seen: Array<{ sourceId: string; maxBytes?: number }> = []
    const http: SafeHttpClient = {
      fetchText: async (_url, opts) => {
        seen.push({
          sourceId: seen.length === 0 ? "smol-ai" : "openai-news",
          maxBytes: opts?.maxBytes,
        })
        return rss
      },
    }

    await makeRssSource(RSS_SOURCES.find((d) => d.sourceId === "smol-ai")!).fetch(ctxWith(http))
    await makeRssSource(RSS_SOURCES.find((d) => d.sourceId === "openai-news")!).fetch(ctxWith(http))

    assert.deepEqual(seen, [
      { sourceId: "smol-ai", maxBytes: 3 * 1024 * 1024 },
      { sourceId: "openai-news", maxBytes: undefined },
    ])
  })

  it("第一个 URL 抛错时用第二个", async () => {
    const rss = fs.readFileSync(path.join(FIX, "openai.rss.xml"), "utf8")
    const calls: string[] = []
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        calls.push(url)
        if (calls.length === 1) throw new Error("instance down")
        return rss
      },
    }
    const src = makeRssSource({
      sourceId: "fallback-test",
      category: "ai",
      urls: ["https://a.com/x", "https://b.com/x"],
    })
    const items = await src.fetch(ctxWith(http))
    assert.equal(calls.length, 2)
    assert.ok(items.length > 0)
  })

  it("全链空/错 → 抛（orchestrator 记 failed）", async () => {
    const http: SafeHttpClient = { fetchText: async () => "not xml" }
    const src = makeRssSource({
      sourceId: "t",
      category: "ai",
      urls: ["https://a.com/1", "https://a.com/2"],
    })
    await assert.rejects(src.fetch(ctxWith(http)))
  })

  it("keepIf 过滤（sglang nightly 条目被滤掉）", async () => {
    const def = RSS_SOURCES.find((d) => d.sourceId === "sglang-releases")!
    const atom = fs.readFileSync(path.join(FIX, "sglang.releases.atom"), "utf8")
    const http: SafeHttpClient = { fetchText: async () => atom }
    const items = await makeRssSource(def)
      .fetch(ctxWith(http))
      .catch(() => [])
    for (const item of items) {
      assert.ok(def.keepIf!(item))
      assert.ok(!/nightly/i.test(item.title))
    }
  })
})

describe("#28 YouTube AI 频道（07-05 六频道 + 07-11 扩六=12，逐个 feed 实测 200+标题核对后入表）", () => {
  it("十二频道定义齐：ai 类目 + 官方 feed URL 形态 + 7 天时效窗（无日期保守留）", () => {
    const yt = RSS_SOURCES.filter((d) => d.sourceId.startsWith("yt-"))
    assert.equal(yt.length, 12)
    for (const d of yt) {
      assert.equal(d.category, "ai")
      assert.match(
        String(d.urls[0]),
        /^https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=UC/,
      )
      assert.ok(d.keepIf, `${d.sourceId} 必须带时效窗`)
      const fresh = buildNormalizedItem(
        d.sourceId,
        "ai",
        "新片",
        "https://www.youtube.com/watch?v=x",
        new Date(Date.now() - 3600_000).toISOString(),
        "",
      )
      assert.equal(d.keepIf(fresh), true)
      assert.equal(
        d.keepIf({
          ...fresh,
          publishedAt: new Date(Date.now() - 100 * 3600_000).toISOString(),
        }),
        true,
        "窗内（约 4 天）旧片仍是候选（重复由 shown 账本治）",
      )
      assert.equal(
        d.keepIf({
          ...fresh,
          publishedAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString(),
        }),
        false,
        "8 天旧片出窗不该回流",
      )
      assert.equal(d.keepIf({ ...fresh, publishedAt: null }), true)
    }
  })
})

describe("NPU 推理 release 源（07-06 小孙点名：vLLM 主仓 + 昇腾插件）", () => {
  it("两源定义齐：ai 类目 + releases.atom URL + 7 天时效窗（无日期保守留）", () => {
    for (const id of ["vllm-releases", "vllm-ascend-releases"]) {
      const d = RSS_SOURCES.find((s) => s.sourceId === id)
      assert.ok(d, `缺源定义: ${id}`)
      assert.equal(d.category, "ai")
      assert.match(
        String(d.urls[0]),
        /^https:\/\/github\.com\/vllm-project\/[a-z-]+\/releases\.atom$/,
      )
      assert.ok(d.keepIf, `${id} 必须带时效窗（release 数周一发，旧版不许每天回流）`)
      const fresh = buildNormalizedItem(
        id,
        "ai",
        "v0.9.1",
        "https://github.com/vllm-project/vllm/releases/tag/v0.9.1",
        new Date(Date.now() - 3600_000).toISOString(),
        "release notes",
      )
      assert.equal(d.keepIf(fresh), true)
      assert.equal(
        d.keepIf({ ...fresh, publishedAt: new Date(Date.now() - 100 * 3600_000).toISOString() }),
        true,
        "窗内（约 4 天）release 仍是候选——72h 旧窗曾让 vllm-ascend 发版永久漏报",
      )
      assert.equal(
        d.keepIf({ ...fresh, publishedAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() }),
        false,
        "8 天前的旧 release 出窗不该回流",
      )
      assert.equal(d.keepIf({ ...fresh, publishedAt: null }), true)
    }
  })
})

describe("#30 enrich 富化钩（makeJsonSource 合同）", () => {
  it("有 enrich：收到 keep 后 items + 原响应体，返回值即源产出；无 enrich 原样", async () => {
    const body = JSON.stringify({ rows: [{ t: "LLM 推理新进展", u: "https://a.com/1" }] })
    const http: SafeHttpClient = { fetchText: async () => body }
    let gotRaw = ""
    const src = makeJsonSource({
      sourceId: "fake-enrich",
      category: "ai",
      urls: ["https://a.com/api"],
      map: (json) =>
        ((json as { rows: Array<{ t: string; u: string }> }).rows ?? []).map((r) => ({
          title: r.t,
          url: r.u,
        })),
      enrich: async (items, rawBody) => {
        gotRaw = rawBody
        return items.map((i) => ({ ...i, rawSnippet: `${i.rawSnippet}｜热评：好` }))
      },
    })
    const items = await src.fetch(ctxWith(http))
    assert.equal(gotRaw, body)
    assert.ok(items[0].rawSnippet.includes("热评"))

    const plain = makeJsonSource({
      sourceId: "fake-plain",
      category: "ai",
      urls: ["https://a.com/api"],
      map: (json) =>
        ((json as { rows: Array<{ t: string; u: string }> }).rows ?? []).map((r) => ({
          title: r.t,
          url: r.u,
        })),
    })
    const plainItems = await plain.fetch(ctxWith(http))
    assert.equal(plainItems[0].rawSnippet.includes("热评"), false)
  })
})

describe("健康空 ≠ 失败（07-06 首跑纠偏：安静频道被时效窗滤空不许误报 failed）", () => {
  const ATOM_OLD = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>旧片</title><link href="https://www.youtube.com/watch?v=old"/>
    <published>2020-01-01T00:00:00Z</published></entry></feed>`

  it("feed 有条目但 keepIf 全滤 → 返回 []（ok），不抛不换跳", async () => {
    let calls = 0
    const http: SafeHttpClient = {
      fetchText: async () => {
        calls += 1
        return ATOM_OLD
      },
    }
    const src = makeRssSource({
      sourceId: "yt-test",
      category: "ai",
      urls: [
        "https://www.youtube.com/feeds/videos.xml?channel_id=UCx",
        "https://fallback.example/x",
      ],
      keepIf: () => false, // 模拟时效窗全滤
    })
    const items = await src.fetch(ctxWith(http))
    assert.deepEqual(items, [])
    assert.equal(calls, 1, "健康空不该再试 fallback URL")
  })

  it("body 解析不出任何条目 → 走链换跳，全链尽头才抛", async () => {
    const http: SafeHttpClient = { fetchText: async () => "<html>not a feed</html>" }
    const src = makeRssSource({
      sourceId: "yt-test2",
      category: "ai",
      urls: ["https://www.youtube.com/feeds/videos.xml?channel_id=UCy"],
    })
    await assert.rejects(() => src.fetch(ctxWith(http)), /no items parsed/)
  })

  it("JSON 源同口径：map 出条目但 keepIf 全滤 → []（ok）", async () => {
    const http: SafeHttpClient = {
      fetchText: async () => JSON.stringify({ rows: [{ t: "股市新闻", u: "https://a.com/1" }] }),
    }
    const src = makeJsonSource({
      sourceId: "json-quiet",
      category: "ai",
      urls: ["https://a.com/api"],
      map: (json) =>
        ((json as { rows: Array<{ t: string; u: string }> }).rows ?? []).map((r) => ({
          title: r.t,
          url: r.u,
        })),
      keepIf: () => false,
    })
    assert.deepEqual(await src.fetch(ctxWith(http)), [])
  })

  it("YouTube Feed 的瞬时 404 只重试一次，恢复后按正常源发布并透传 source abort signal", async () => {
    const rss = fs.readFileSync(path.join(FIX, "openai.rss.xml"), "utf8")
    const controller = new AbortController()
    const calls: Array<{ url: string; signal?: AbortSignal }> = []
    const transient404 = Object.assign(
      new SafeHttpError("http_status", "https://www.youtube.com/feeds/videos.xml", "status 404"),
      { status: 404 },
    )
    const http: SafeHttpClient = {
      fetchText: async (url, opts) => {
        calls.push({ url, signal: opts?.signal })
        if (calls.length === 1) throw transient404
        return rss
      },
    }
    const src = makeRssSource({
      sourceId: "yt-retry-test",
      category: "ai",
      urls: ["https://www.youtube.com/feeds/videos.xml?channel_id=UCtest"],
      retryPolicy: {
        maxAttempts: 2,
        delayMs: 0,
        retryHttpStatuses: [404, 408, 425, 429, 500, 502, 503, 504],
      },
    })

    const items = await src.fetch({ http, signal: controller.signal, now: () => NOW })

    assert.equal(calls.length, 2)
    assert.ok(items.length > 0)
    assert.ok(calls.every((call) => call.signal === controller.signal))
  })

  it("YouTube Feed 的永久 403 不重试，连续 500 也最多请求两次", async () => {
    const policy = {
      maxAttempts: 2 as const,
      delayMs: 0,
      retryHttpStatuses: [404, 408, 425, 429, 500, 502, 503, 504],
    }
    const makeError = (status: number) =>
      Object.assign(
        new SafeHttpError(
          "http_status",
          "https://www.youtube.com/feeds/videos.xml",
          `status ${status}`,
        ),
        { status },
      )
    for (const scenario of [
      { status: 403, expectedCalls: 1 },
      { status: 500, expectedCalls: 2 },
    ]) {
      let calls = 0
      const src = makeRssSource({
        sourceId: `yt-${scenario.status}`,
        category: "ai",
        urls: ["https://www.youtube.com/feeds/videos.xml?channel_id=UCtest"],
        retryPolicy: policy,
      })
      await assert.rejects(
        src.fetch(
          ctxWith({
            fetchText: async () => {
              calls += 1
              throw makeError(scenario.status)
            },
          }),
        ),
      )
      assert.equal(calls, scenario.expectedCalls)
    }
  })
})
