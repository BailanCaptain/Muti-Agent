import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { SafeHttpError } from "../../../net/safe-http-client"
import { runAllSources } from "../orchestrator"
import type { SafeHttpClient, SourceFetchContext } from "../types"
import { extractRscPayload, makeDiggAiSource, parseDiggStories, scanJsonValue } from "./digg-ai"

const FIX = path.join(__dirname, "..", "__fixtures__")
const diggHtml = fs.readFileSync(path.join(FIX, "digg.rsc.html"), "utf8")
const NOW = new Date("2026-07-05T12:00:00Z")

function ctxWith(http: SafeHttpClient): SourceFetchContext {
  return { http, signal: new AbortController().signal, now: () => NOW }
}

describe("RSC 提取原语", () => {
  it("extractRscPayload：跨 <script> 分片拼接（fixture 特意把 JSON 切在两片）", () => {
    const payload = extractRscPayload(diggHtml)
    assert.ok(payload.includes('"storiesByFilter"'))
    assert.ok(payload.includes('"clusterUrlId"'))
    // 单片内不完整、拼接后完整 —— 证明必须先拼接再解析
    const chunks = [...diggHtml.matchAll(/self\.__next_f\.push\(\[1,"/g)]
    assert.equal(chunks.length, 2)
  })

  it("scanJsonValue：字符串内括号/转义不干扰平衡扫描", () => {
    const s = 'x:{"a":"has ] and } inside","b":[1,{"c":"\\" escaped"}]}rest'
    const v = scanJsonValue(s, 2)
    assert.ok(v)
    const parsed = JSON.parse(v as string) as { a: string; b: unknown[] }
    assert.equal(parsed.a, "has ] and } inside")
    assert.equal(parsed.b.length, 2)
  })
})

describe("parseDiggStories（07-05 真实 fixture，schema 已演化过一次 label→title）", () => {
  it("storiesByFilter.top.items → title/tldr/clusterUrlId/rank/postCount/ISO 日期", () => {
    const stories = parseDiggStories(diggHtml)
    assert.equal(stories.length, 3)
    assert.equal(stories[0].rank, 1)
    assert.equal(stories[0].clusterUrlId, "f3hapn0c")
    assert.ok(stories[0].title.length > 10)
    assert.ok(stories[0].tldr.length > 0)
    assert.ok(stories[0].postCount > 0)
    assert.ok(stories[0].createdAt?.endsWith("Z"))
  })

  it("storiesByFilter.top.posts → 兼容 07-18 上游集合键改版", () => {
    const post = {
      title: "Digg current posts schema regression",
      tldr: "Current RSC payload uses posts instead of items",
      clusterUrlId: "posts20260718",
      rank: 1,
      postCount: 8,
      createdAt: "2026-07-17T23:00:00.000Z",
    }
    const payload = JSON.stringify({
      storiesByFilter: { top: { posts: [post] } },
      unrelated: { items: [] },
    })
    const postsHtml = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`

    const stories = parseDiggStories(postsHtml)

    assert.deepEqual(stories, [post])
  })

  it("storiesByFilter.top.posts[].summary → 兼容 07-23 标题与摘要嵌套改版", () => {
    const post = {
      summary: {
        title: "Digg nested summary schema regression",
        description: "Current RSC payload nests story copy under summary",
      },
      clusterUrlId: "summary20260723",
      rank: 1,
      postCount: 11,
      createdAt: "2026-07-23T00:30:00.000Z",
    }
    const payload = JSON.stringify({
      storiesByFilter: { top: { posts: [post] } },
    })
    const postsHtml = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`

    const stories = parseDiggStories(postsHtml)

    assert.deepEqual(stories, [
      {
        title: post.summary.title,
        tldr: post.summary.description,
        clusterUrlId: post.clusterUrlId,
        rank: post.rank,
        postCount: post.postCount,
        createdAt: post.createdAt,
      },
    ])
  })

  it("根级字段优先、title/tldr 逐字段回退，空字符串保持旧语义", () => {
    const posts = [
      {
        title: "Root title",
        tldr: "Root tldr",
        summary: { title: "Nested title 1", description: "Nested description 1" },
        clusterUrlId: "rootwins",
      },
      {
        title: "Root title only",
        summary: { title: "Nested title 2", description: "Nested description 2" },
        clusterUrlId: "mixedtitle",
      },
      {
        tldr: "Root tldr only",
        summary: { title: "Nested title 3", description: "Nested description 3" },
        clusterUrlId: "mixedtldr",
      },
      {
        title: "",
        summary: { title: "Must not revive empty root title", description: "Nested description 4" },
        clusterUrlId: "emptytitle",
      },
      {
        title: "Keep empty root tldr",
        tldr: "",
        summary: { title: "Nested title 5", description: "Must not replace empty root tldr" },
        clusterUrlId: "emptytldr",
      },
    ]
    const payload = JSON.stringify({ storiesByFilter: { top: { posts } } })
    const postsHtml = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`

    assert.deepEqual(parseDiggStories(postsHtml), [
      {
        title: "Root title",
        tldr: "Root tldr",
        clusterUrlId: "rootwins",
        rank: 999,
        postCount: 0,
        createdAt: null,
      },
      {
        title: "Root title only",
        tldr: "Nested description 2",
        clusterUrlId: "mixedtitle",
        rank: 999,
        postCount: 0,
        createdAt: null,
      },
      {
        title: "Nested title 3",
        tldr: "Root tldr only",
        clusterUrlId: "mixedtldr",
        rank: 999,
        postCount: 0,
        createdAt: null,
      },
      {
        title: "Keep empty root tldr",
        tldr: "",
        clusterUrlId: "emptytldr",
        rank: 999,
        postCount: 0,
        createdAt: null,
      },
    ])
  })

  it("summary.title 错型 → 丢弃，不把 object/array/boolean 刊成垃圾标题", () => {
    const posts = [
      { summary: { title: { text: "object" } }, clusterUrlId: "objecttitle" },
      { summary: { title: ["array"] }, clusterUrlId: "arraytitle" },
      { summary: { title: true }, clusterUrlId: "booleantitle" },
    ]
    const payload = JSON.stringify({ storiesByFilter: { top: { posts } } })
    const postsHtml = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`

    assert.deepEqual(parseDiggStories(postsHtml), [])
  })

  it("summary.description 错型 → 摘要留空，不强转 object/array/boolean", () => {
    const posts = [
      {
        summary: { title: "Object description", description: { text: "object" } },
        clusterUrlId: "objectdescription",
      },
      {
        summary: { title: "Array description", description: ["array"] },
        clusterUrlId: "arraydescription",
      },
      {
        summary: { title: "Boolean description", description: true },
        clusterUrlId: "booleandescription",
      },
    ]
    const payload = JSON.stringify({ storiesByFilter: { top: { posts } } })
    const postsHtml = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`

    assert.deepEqual(
      parseDiggStories(postsHtml).map(({ title, tldr }) => ({ title, tldr })),
      [
        { title: "Object description", tldr: "" },
        { title: "Array description", tldr: "" },
        { title: "Boolean description", tldr: "" },
      ],
    )
  })

  it("RSC 结构改版（无 storiesByFilter）→ 0 story", () => {
    assert.equal(parseDiggStories("<html><body>redesigned</body></html>").length, 0)
    assert.equal(
      parseDiggStories('<script>self.__next_f.push([1,"no data here"])</script>').length,
      0,
    )
  })
})

describe("makeDiggAiSource（#23 主表 v2.3）", () => {
  it("rank 排序 + 集群页 /tech/{id} 链接 + 帖聚合数前置 snippet", async () => {
    const http: SafeHttpClient = { fetchText: async () => diggHtml }
    const items = await makeDiggAiSource().fetch(ctxWith(http))
    assert.equal(items.length, 3)
    assert.equal(items[0].canonicalUrl, "https://digg.com/tech/f3hapn0c")
    assert.match(items[0].rawSnippet, /^\[#1 · \d+ 帖聚合\]/)
    assert.equal(items[0].category, "community") // 07-06 社区改版
    assert.equal(items[0].category, makeDiggAiSource().category) // 德彪批次D r1 P1 契约：item 与源声明一致
    assert.equal(items[0].sourceId, "digg-ai")
    assert.ok((items[0].engagement ?? 0) > 0) // 聚合帖数 = 交叉印证强度（质量层 1）
  })

  it("maxStories 截断", async () => {
    const http: SafeHttpClient = { fetchText: async () => diggHtml }
    const items = await makeDiggAiSource({ maxStories: 2 }).fetch(ctxWith(http))
    assert.equal(items.length, 2)
  })

  it("首 URL 失败落 fallback；全废 → 抛（orchestrator 记 failed）", async () => {
    const calls: string[] = []
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        calls.push(url)
        if (calls.length === 1) throw new Error("503")
        return diggHtml
      },
    }
    const items = await makeDiggAiSource().fetch(ctxWith(http))
    assert.equal(calls.length, 2)
    assert.match(calls[0], /digg\.com\/tech\/$/)
    assert.match(calls[1], /digg\.com\/ai$/)
    assert.equal(items.length, 3)
    const dead: SafeHttpClient = { fetchText: async () => "<html>blocked</html>" }
    await assert.rejects(makeDiggAiSource().fetch(ctxWith(dead)), /no stories parsed/)
  })

  it("canonical fetch 成功但解析为 0 时 fail-closed，不得被后续网络错误覆盖", async () => {
    const calls: string[] = []
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        calls.push(url)
        if (url.endsWith("/tech/")) return "<html>RSC schema changed</html>"
        throw new Error("network unavailable")
      },
    }

    await assert.rejects(
      makeDiggAiSource().fetch(ctxWith(http)),
      /no stories parsed from https:\/\/digg\.com\/tech\//,
    )
    assert.deepEqual(calls, ["https://digg.com/tech/"])
  })

  it("B044：Digg 首次 429 只重试一次 canonical GET，恢复后不落 fallback", async () => {
    const calls: string[] = []
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        calls.push(url)
        if (calls.length === 1) {
          throw new SafeHttpError("http_status", url, "status 429", 429)
        }
        return diggHtml
      },
    }

    const source = makeDiggAiSource()
    source.transientGetRetry = { ...source.transientGetRetry!, delayMs: 0 }
    const run = await runAllSources([source], {
      http,
      now: () => NOW,
      transportRetryDelayMs: 0,
    })

    assert.equal(run.results[0].status, "ok")
    assert.equal(run.items.length, 3)
    assert.deepEqual(calls, ["https://digg.com/tech/", "https://digg.com/tech/"])
  })
})
