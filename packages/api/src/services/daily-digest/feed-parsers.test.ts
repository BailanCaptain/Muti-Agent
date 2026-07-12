import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { parseRssOrAtom, stripHtml } from "./feed-parsers"

const FIX = path.join(__dirname, "__fixtures__")
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8")

describe("stripHtml", () => {
  it("去标签 + 解常用实体 + 压空白", () => {
    assert.equal(stripHtml("<p>A &amp; B&nbsp;&lt;ok&gt;</p>\n<div>C</div>"), "A & B <ok> C")
  })
})

describe("parseRssOrAtom（真实 fixture）", () => {
  it("RSS 2.0（OpenAI news）解析出全字段条目", () => {
    const items = parseRssOrAtom(read("openai.rss.xml"), "openai-news", "ai")
    assert.ok(items.length > 0)
    for (const it2 of items) {
      assert.ok(it2.title.length > 0)
      assert.match(it2.canonicalUrl, /^https?:\/\//)
      assert.equal(it2.sourceId, "openai-news")
      assert.equal(it2.category, "ai")
      assert.ok(!it2.rawSnippet.includes("<"))
      assert.match(it2.id, /^[0-9a-f]{16}$/)
      if (it2.publishedAt !== null) assert.ok(!Number.isNaN(Date.parse(it2.publishedAt)))
    }
  })

  it("Atom（SGLang releases）解析 entry + link href", () => {
    const items = parseRssOrAtom(read("sglang.releases.atom"), "sglang-releases", "ai")
    assert.ok(items.length > 0)
    assert.match(items[0].canonicalUrl, /github\.com\/sgl-project\/sglang/)
  })

  it("RSS with content:encoded（smol.ai）snippet 截断 ≤2000 无 HTML", () => {
    const items = parseRssOrAtom(read("smolai.rss.xml"), "smol-ai", "ai")
    assert.ok(items.length > 0)
    for (const it2 of items) {
      assert.ok(it2.rawSnippet.length <= 2000)
      assert.ok(!it2.rawSnippet.includes("<p>"))
    }
  })

  it("中文 RSS（BBC 中文）标题保留中文", () => {
    const items = parseRssOrAtom(read("bbc-zhongwen.rss.xml"), "bbc-zhongwen", "hot")
    assert.ok(items.length > 0)
    assert.ok(items.some((x) => /[一-鿿]/.test(x.title)))
  })

  it("无效 XML 返回 []（fetcher 不抛业务错误）", () => {
    assert.deepEqual(parseRssOrAtom("not xml at all", "x", "ai"), [])
  })

  it("无效 pubDate → publishedAt=null（虎扑 Invalid Date 教训）", () => {
    const xml =
      "<rss><channel><item><title>t</title><link>https://a.com/1</link><pubDate>Invalid Date</pubDate></item></channel></rss>"
    const items = parseRssOrAtom(xml, "x", "hot")
    assert.equal(items.length, 1)
    assert.equal(items[0].publishedAt, null)
  })
})
