import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { SafeHttpClient, SafeHttpFetchOptions } from "../types"
import {
  extractMcpPayload,
  makeXiaohongshuSource,
  parseCnCount,
  parseXhsNotes,
} from "./xiaohongshu"

const NOW = new Date("2026-07-05T12:00:00Z")
const NO_PACING = { delayMs: 0, jitterMs: 0 }

/** 未活测契约 fixture（README 钉过 feed_id/xsec_token；内层形状按防御候选，激活日真响应校正） */
const FEEDS_PAYLOAD = {
  feeds: [
    {
      feed_id: "note123",
      xsec_token: "TOK+abc",
      note_card: { display_title: "Claude Code 实战心得", interact_info: { liked_count: "1.2万" } },
    },
    {
      feed_id: "note456",
      xsec_token: "TOK2",
      title: "AI 编程入门",
      liked_count: 345,
    },
    { feed_id: "", title: "缺 id 应被跳过" },
  ],
}

const envelope = (payload: unknown) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  })

describe("parseCnCount（中文计数）", () => {
  it("数字/字符串/万/k 全解析；垃圾返回 undefined", () => {
    assert.equal(parseCnCount(345), 345)
    assert.equal(parseCnCount("3456"), 3456)
    assert.equal(parseCnCount("1.2万"), 12_000)
    assert.equal(parseCnCount("3.5w"), 35_000)
    assert.equal(parseCnCount("2k"), 2000)
    assert.equal(parseCnCount("赞"), undefined)
    assert.equal(parseCnCount(0), undefined)
    assert.equal(parseCnCount(null), undefined)
  })
})

describe("extractMcpPayload（MCP 信封三形态）", () => {
  it("JSON-RPC content[].text 内层 JSON", () => {
    const p = extractMcpPayload(envelope(FEEDS_PAYLOAD)) as { feeds: unknown[] }
    assert.equal(p.feeds.length, 3)
  })

  it("SSE 帧（event/data 行）拼接后解析", () => {
    const sse = `event: message\ndata: ${envelope(FEEDS_PAYLOAD)}\n\n`
    const p = extractMcpPayload(sse) as { feeds: unknown[] }
    assert.equal(p.feeds.length, 3)
  })

  it("structuredContent 直出优先", () => {
    const body = JSON.stringify({ result: { structuredContent: { feeds: [1] } } })
    assert.deepEqual(extractMcpPayload(body), { feeds: [1] })
  })

  it("error 信封抛明确错误（握手/未登录可观测）", () => {
    const body = JSON.stringify({ error: { code: -32000, message: "session not initialized" } })
    assert.throws(() => extractMcpPayload(body), /session not initialized/)
  })

  it("非 JSON 抛错带片段", () => {
    assert.throws(() => extractMcpPayload("<html>登录页</html>"), /不是 JSON/)
  })
})

describe("parseXhsNotes（多形状防御提取）", () => {
  it("note_card 嵌套/扁平字段/缺 id 跳过 + 中文计数", () => {
    const notes = parseXhsNotes(FEEDS_PAYLOAD)
    assert.equal(notes.length, 2)
    assert.deepEqual(notes[0], {
      feedId: "note123",
      xsecToken: "TOK+abc",
      title: "Claude Code 实战心得",
      likes: 12_000,
    })
    assert.equal(notes[1].likes, 345)
  })

  it("data.feeds / 顶层数组两形状", () => {
    assert.equal(parseXhsNotes({ data: { feeds: FEEDS_PAYLOAD.feeds } }).length, 2)
    assert.equal(parseXhsNotes(FEEDS_PAYLOAD.feeds).length, 2)
    assert.equal(parseXhsNotes({ unexpected: true }).length, 0)
  })
})

describe("makeXiaohongshuSource（sidecar MCP 调用）", () => {
  function httpRecording(bodyByKeyword: (kw: string) => string) {
    const calls: Array<{ url: string; opts?: SafeHttpFetchOptions }> = []
    const http: SafeHttpClient & { calls: typeof calls } = {
      calls,
      async fetchText(url, opts) {
        calls.push({ url, opts })
        const req = JSON.parse(opts?.body ?? "{}") as {
          params?: { name?: string; arguments?: { keyword?: string } }
        }
        return bodyByKeyword(req.params?.arguments?.keyword ?? "")
      },
    }
    return http
  }
  const ctx = (http: SafeHttpClient) => ({
    http,
    signal: new AbortController().signal,
    now: () => NOW,
  })

  it("POST /mcp tools/call search_feeds；xsec_token 进链接；关键词间去重；engagement=赞数", async () => {
    const http = httpRecording(() => envelope(FEEDS_PAYLOAD))
    const src = makeXiaohongshuSource({
      mcpBase: "http://localhost:18060/",
      keywords: ["AI", "Claude"],
      pacing: NO_PACING,
    })
    const items = await src.fetch(ctx(http))
    assert.equal(http.calls[0].url, "http://localhost:18060/mcp")
    assert.equal(http.calls[0].opts?.method, "POST")
    const req = JSON.parse(http.calls[0].opts?.body ?? "{}") as {
      method: string
      params: { name: string; arguments: { keyword: string } }
    }
    assert.equal(req.method, "tools/call")
    assert.equal(req.params.name, "search_feeds")
    assert.equal(req.params.arguments.keyword, "AI")
    // 两关键词同一批 fixture → feedId 去重后仍是 2 条
    assert.equal(items.length, 2)
    assert.equal(
      items[0].canonicalUrl,
      "https://www.xiaohongshu.com/explore/note123?xsec_token=TOK%2Babc&xsec_source=pc_search",
    )
    assert.equal(items[0].sourceId, "xiaohongshu")
    assert.equal(items[0].category, "community") // 07-06 社区改版默认
    assert.equal(items[0].engagement, 12_000)
    assert.match(items[0].rawSnippet, /^\[AI\] ▲12000 赞/)
  })

  it("单关键词失败隔离；全灭抛明确错误带首个错因", async () => {
    let call = 0
    const http = httpRecording(() => {
      call += 1
      if (call === 1) throw new Error("ECONNREFUSED sidecar down")
      return envelope(FEEDS_PAYLOAD)
    })
    const src = makeXiaohongshuSource({
      mcpBase: "http://localhost:18060",
      keywords: ["a", "b"],
      pacing: NO_PACING,
    })
    const items = await src.fetch(ctx(http))
    assert.equal(items.length, 2) // b 关键词成功

    const httpDead = httpRecording(() => {
      throw new Error("ECONNREFUSED sidecar down")
    })
    await assert.rejects(
      makeXiaohongshuSource({
        mcpBase: "http://localhost:18060",
        keywords: ["a"],
        pacing: NO_PACING,
      }).fetch(ctx(httpDead)),
      /0 notes fetched.*ECONNREFUSED/,
    )
  })

  it("整源预算 = pacing.maxTotalMs + 60s；无关键词直接抛", async () => {
    const src = makeXiaohongshuSource({ mcpBase: "http://x", keywords: [] })
    assert.equal(src.timeoutBudgetMs, 180_000)
    await assert.rejects(src.fetch(ctx(httpRecording(() => ""))), /no keywords/)
  })
})
