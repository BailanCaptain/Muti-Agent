import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { buildNormalizedItem } from "../feed-parsers"
import type { SafeHttpClient, SourceFetchContext } from "../types"
import { enrichHnComments, hnIdByUrl, stripCommentHtml, topCommentTexts } from "./hn-comments"

const FIX = path.join(__dirname, "..", "__fixtures__")
const listBody = fs.readFileSync(path.join(FIX, "hn.algolia.json"), "utf8")
const NO_PACING = { delayMs: 0, jitterMs: 0 }

function ctxWith(http: SafeHttpClient): SourceFetchContext {
  return { http, signal: new AbortController().signal, now: () => new Date() }
}

const itemJson = (comments: string[]) =>
  JSON.stringify({
    id: 1,
    children: comments.map((text, i) => ({ id: i, text, author: `u${i}` })),
  })

describe("hn-comments 解析件（#30）", () => {
  it("hnIdByUrl：外链 + item 兜底链接双向可查", () => {
    const map = hnIdByUrl(listBody)
    assert.equal(map.get("https://joeyh.name/blog/entry/no_LLM_code_in_dependencies/"), "48762008")
    assert.equal(map.get("https://news.ycombinator.com/item?id=48762008"), "48762008")
    assert.equal(hnIdByUrl("not json").size, 0)
  })

  it("stripCommentHtml：剥标签/解实体/压空白", () => {
    assert.equal(
      stripCommentHtml("<p>vLLM &quot;wins&quot; &amp; it&#x27;s   fast</p>"),
      'vLLM "wins" & it\'s fast',
    )
  })

  it("topCommentTexts：跳过短评/空评，按 n 截断", () => {
    const texts = topCommentTexts(
      JSON.parse(
        itemJson([
          "+1",
          "这是一条足够长的高质量评论，有具体的技术观点在里面",
          "第二条也足够长的评论，包含实测数据与反例分析",
          "第三条不该出现",
        ]),
      ),
      2,
      160,
    )
    assert.equal(texts.length, 2)
    assert.match(texts[0], /^这是一条/)
  })
})

describe("enrichHnComments（fail-open 合同）", () => {
  const mk = (url: string, points: number) => ({
    ...buildNormalizedItem(
      "hn-ai",
      "ai",
      `t-${points}`,
      url,
      null,
      `${points} points on Hacker News`,
    ),
    engagement: points,
  })

  it("互动量前 N 富化 snippet，其余原样；快照上限 2000 不破", async () => {
    const top = mk(
      "https://semgrep.dev/blog/2026/we-have-mythos-at-home-glm-52-beats-claude-in-our-cyber-benchmarks/",
      1105,
    )
    const mid = mk("https://zcode.z.ai/en", 498)
    const low = mk("https://joeyh.name/blog/entry/no_LLM_code_in_dependencies/", 115)
    const fetched: string[] = []
    const http: SafeHttpClient = {
      fetchText: async (url) => {
        fetched.push(url)
        return itemJson([
          "这是一条足够长的高质量评论，有具体的技术观点在里面",
          "第二条也足够长的评论，包含实测数据与反例分析",
        ])
      },
    }
    const out = await enrichHnComments([low, top, mid], listBody, ctxWith(http), {
      enrichTop: 2,
      pacing: NO_PACING,
    })
    assert.equal(fetched.length, 2)
    assert.ok(fetched[0].endsWith("/items/48709670")) // 1105 分第一
    const enrichedTop = out.find((i) => i.id === top.id)
    assert.ok(enrichedTop?.rawSnippet.includes("热评："))
    assert.ok(enrichedTop?.rawSnippet.includes("「这是一条"))
    const untouched = out.find((i) => i.id === low.id)
    assert.equal(untouched?.rawSnippet.includes("热评"), false)
    for (const i of out) assert.ok(i.rawSnippet.length <= 2000)
  })

  it("items/{id} 全挂 → 原 items 原样返回（绝不打挂主链）", async () => {
    const items = [mk("https://zcode.z.ai/en", 498)]
    const http: SafeHttpClient = {
      fetchText: async () => {
        throw new Error("too_large")
      },
    }
    const out = await enrichHnComments(items, listBody, ctxWith(http), { pacing: NO_PACING })
    assert.deepEqual(out, items)
  })

  it("rawBody 不是 JSON / 无匹配 id → 直接原样返回（零请求）", async () => {
    const items = [mk("https://nowhere.example/x", 10)]
    let calls = 0
    const http: SafeHttpClient = {
      fetchText: async () => {
        calls += 1
        return "{}"
      },
    }
    assert.deepEqual(await enrichHnComments(items, "junk", ctxWith(http)), items)
    assert.deepEqual(await enrichHnComments(items, listBody, ctxWith(http)), items)
    assert.equal(calls, 0)
  })
})
