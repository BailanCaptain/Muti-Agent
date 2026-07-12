import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { makeDedupeKey, makeItemId, truncateSnippet } from "./item-identity"

describe("daily-digest item-identity", () => {
  it("makeItemId 对同输入稳定、对不同输入不同、16 位 hex", () => {
    const a = makeItemId("espn-nba", "https://espn.com/story/1")
    const b = makeItemId("espn-nba", "https://espn.com/story/1")
    const c = makeItemId("yahoo-nba", "https://espn.com/story/1")
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.match(a, /^[0-9a-f]{16}$/)
  })

  it("makeDedupeKey 去 utm_* 参数 / fragment / 尾斜杠，host 小写", () => {
    assert.equal(
      makeDedupeKey("https://ESPN.com/story/1/?utm_source=rss&utm_medium=feed#frag"),
      makeDedupeKey("https://espn.com/story/1"),
    )
  })

  it("makeDedupeKey 保留非 utm 查询参数（不同内容不误合）", () => {
    assert.notEqual(
      makeDedupeKey("https://example.com/a?id=1"),
      makeDedupeKey("https://example.com/a?id=2"),
    )
  })

  it("makeDedupeKey 对无效 URL 回退为原串 trim 小写（不抛）", () => {
    assert.equal(makeDedupeKey("  Not A Url  "), "not a url")
  })

  it("truncateSnippet 压空白 + 截 2000 字符", () => {
    const long = "x".repeat(3000)
    assert.equal(truncateSnippet(long).length, 2000)
    assert.equal(truncateSnippet("  a \n\n  b  "), "a b")
  })
})
