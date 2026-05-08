import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildForwardExtractSnippet,
  buildReturnPathExtractSnippet,
  buildReturnPathPayload,
} from "./return-path-payload"

describe("buildReturnPathPayload", () => {
  it("returns content as-is when within budget", () => {
    const r = buildReturnPathPayload("hello world", { maxTokens: 16384 })
    assert.equal(r.text, "hello world")
    assert.equal(r.truncated, false)
    assert.equal(r.omittedChars, 0)
  })

  it("truncates head+tail when over budget and embeds msg_id reference", () => {
    const long = "x".repeat(80_000)
    const r = buildReturnPathPayload(long, { maxTokens: 4096, dbMsgId: "abc123" })
    assert.equal(r.truncated, true)
    assert.ok(r.omittedChars > 0)
    assert.match(r.text, /msg_id=abc123/)
    assert.match(r.text, /省略\s*\d+\s*字/)
  })

  it("preserves both head and tail content (not just head)", () => {
    const head = "HEAD_MARKER_" + "a".repeat(20_000)
    const tail = "b".repeat(20_000) + "_TAIL_MARKER"
    const r = buildReturnPathPayload(head + tail, { maxTokens: 4096 })
    assert.match(r.text, /HEAD_MARKER_/)
    assert.match(r.text, /_TAIL_MARKER/)
    assert.equal(r.truncated, true)
  })
})

describe("buildForwardExtractSnippet (forward dispatch · 任务一句话)", () => {
  it("falls through to extractTaskSnippet semantics — extracts sentence containing @alias", () => {
    const fn = buildForwardExtractSnippet()
    const content = "前面闲扯。@范德彪 帮我 review 一下这段代码。后面还有别的话。"
    const r = fn(content, "范德彪")
    assert.match(r, /@范德彪/)
    assert.match(r, /review/)
  })

  it("caps at ≤500 chars even without @alias match", () => {
    const fn = buildForwardExtractSnippet()
    const content = "x".repeat(2000)
    const r = fn(content, "桂芬")
    assert.ok(r.length <= 500, `expected ≤500, got ${r.length}`)
  })
})

describe("buildReturnPathExtractSnippet (return-path · 完整保真)", () => {
  it("returns full content as-is when within env budget (default 16k tokens = 64k chars)", () => {
    const fn = buildReturnPathExtractSnippet("msg_abc")
    const content = "x".repeat(50_000)
    const r = fn(content, "范德彪")
    assert.equal(r, content)
  })

  it("truncates head+tail with msg_id reference when over budget", () => {
    const prev = process.env.A2A_PAYLOAD_MAX_TOKENS
    process.env.A2A_PAYLOAD_MAX_TOKENS = "4096"
    try {
      const fn = buildReturnPathExtractSnippet("msg_xyz")
      const content = "HEAD_M_" + "a".repeat(40_000) + "b".repeat(40_000) + "_TAIL_M"
      const r = fn(content, "范德彪")
      assert.match(r, /HEAD_M_/)
      assert.match(r, /_TAIL_M/)
      assert.match(r, /msg_id=msg_xyz/)
    } finally {
      if (prev === undefined) delete process.env.A2A_PAYLOAD_MAX_TOKENS
      else process.env.A2A_PAYLOAD_MAX_TOKENS = prev
    }
  })
})
