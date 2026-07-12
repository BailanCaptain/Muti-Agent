import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import type { SafeHttpClient, SourceFetchContext } from "../types"
import { REDDIT_AI_SUBS, makeRedditAiSource, parseShredditPosts } from "./reddit-shreddit"

const FIX = path.join(__dirname, "..", "__fixtures__")
const shredditHtml = fs.readFileSync(path.join(FIX, "reddit.shreddit.html"), "utf8")
const NOW = new Date("2026-07-05T12:00:00Z")
const NO_PACING = { delayMs: 0, jitterMs: 0 }

function ctxWith(http: SafeHttpClient): SourceFetchContext {
  return { http, signal: new AbortController().signal, now: () => NOW }
}

describe("parseShredditPosts（07-05 真实 fixture）", () => {
  it("属性提取：标题/永链/真实赞数/评论数/ISO 日期/子版名", () => {
    const posts = parseShredditPosts(shredditHtml)
    assert.equal(posts.length, 3)
    for (const p of posts) {
      assert.ok(p.title.length > 0)
      assert.match(p.permalink, /^\/r\/LocalLLaMA\/comments\//)
      assert.ok(p.score > 0, `score=${p.score}`)
      assert.ok(p.comments >= 0)
      assert.equal(p.subreddit, "LocalLLaMA")
      if (p.createdAt !== null) {
        // 源格式 +0000 已归一为标准 ISO
        assert.ok(!Number.isNaN(Date.parse(p.createdAt)))
        assert.ok(p.createdAt.endsWith("Z"))
      }
    }
  })

  it("HTML 实体解码（&amp;/&#39;）+ 缺 title/permalink 的标签丢弃", () => {
    const html =
      '<shreddit-post permalink="/r/test/comments/abc/x/" post-title="A &amp; B&#39;s &quot;quote&quot;" score="5" comment-count="2" subreddit-prefixed-name="r/test"></shreddit-post>' +
      '<shreddit-post permalink="/r/test/comments/def/y/" score="9"></shreddit-post>' +
      '<shreddit-post post-title="no permalink" score="9"></shreddit-post>'
    const posts = parseShredditPosts(html)
    assert.equal(posts.length, 1)
    assert.equal(posts[0].title, 'A & B\'s "quote"')
  })

  it("反爬变脸（纯 HTML 无 shreddit-post）→ 0 帖", () => {
    assert.equal(parseShredditPosts("<html><body>blocked</body></html>").length, 0)
  })

  it("越界 numeric entity（>0x10FFFF）→ U+FFFD 不抛（德彪 batchA-r1 P2）", () => {
    const html =
      '<shreddit-post permalink="/r/test/comments/abc/x/" post-title="bad &#1114112; &#x110000; ok &#65;" score="5" comment-count="2" subreddit-prefixed-name="r/test"></shreddit-post>'
    const posts = parseShredditPosts(html)
    assert.equal(posts.length, 1)
    assert.equal(posts[0].title, "bad � � ok A")
  })
})

describe("makeRedditAiSource（#22 主表 v2.1）", () => {
  it("逐子版抓取 + score 排序截断 + 互动量前置 snippet + Accept-Language 头", async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = []
    const http: SafeHttpClient = {
      fetchText: async (url, opts) => {
        seen.push({ url, headers: opts?.headers })
        return shredditHtml
      },
    }
    const src = makeRedditAiSource({
      subreddits: ["LocalLLaMA", "OpenAI"],
      perSub: 2,
      pacing: NO_PACING,
    })
    const items = await src.fetch(ctxWith(http))
    assert.equal(seen.length, 2)
    assert.match(seen[0].url, /community-more-posts\/top\/\?name=LocalLLaMA&t=day$/)
    assert.equal(seen[0].headers?.["accept-language"], "en-US,en;q=0.9")
    assert.equal(items.length, 4) // 2 子版 × perSub 2
    assert.match(items[0].rawSnippet, /^\[▲\d+ · \d+ 评论/)
    assert.match(items[0].canonicalUrl, /^https:\/\/www\.reddit\.com\/r\//)
    assert.equal(items[0].category, "community") // 07-06 社区改版
    assert.equal(items[0].category, src.category) // 德彪批次D r1 P1 契约：item 与源声明一致
    assert.equal(items[0].sourceId, "reddit-ai")
    // perSub=2 时取的是 score 最高的两条；engagement=真实赞数（质量层 1）
    const scores = parseShredditPosts(shredditHtml).map((p) => p.score)
    const top2 = [...scores].sort((a, b) => b - a).slice(0, 2)
    assert.match(items[0].rawSnippet, new RegExp(`▲${top2[0]} `))
    assert.equal(items[0].engagement, top2[0])
  })

  it("单子版失败跳过不炸整源；全空 → 抛（orchestrator 记 failed）", async () => {
    let call = 0
    const http: SafeHttpClient = {
      fetchText: async () => {
        call += 1
        if (call === 1) throw new Error("403")
        return shredditHtml
      },
    }
    const src = makeRedditAiSource({ subreddits: ["a", "b"], pacing: NO_PACING })
    const items = await src.fetch(ctxWith(http))
    assert.ok(items.length > 0)
    const dead: SafeHttpClient = {
      fetchText: async () => {
        throw new Error("403")
      },
    }
    await assert.rejects(
      makeRedditAiSource({ subreddits: ["a"], pacing: NO_PACING }).fetch(ctxWith(dead)),
      /0 posts/,
    )
  })

  it("默认子版清单 = 主表锁定 5 个 AI 子版；源预算覆盖 45s 默认", () => {
    assert.deepEqual(REDDIT_AI_SUBS, [
      "LocalLLaMA",
      "MachineLearning",
      "OpenAI",
      "ClaudeAI",
      "singularity",
    ])
    const src = makeRedditAiSource()
    assert.equal(src.timeoutBudgetMs, 180_000) // 120s 预算 + 60s 余量
  })
})
