import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isDefaultTitle } from "./default-title"

describe("isDefaultTitle", () => {
  it("matches '新会话 YYYY-MM-DD HH:mm:ss' (Phase 1 default)", () => {
    assert.equal(isDefaultTitle("新会话 2026-04-20 14:30:00"), true)
  })

  it("matches '新会话 YYYY-MM-DD' (AC-08 fallback)", () => {
    assert.equal(isDefaultTitle("新会话 2026-04-20"), true)
  })

  it("matches 'YYYY-MM-DD · 未命名' (spec legacy)", () => {
    assert.equal(isDefaultTitle("2026-04-20 · 未命名"), true)
  })

  it("trims surrounding whitespace before matching", () => {
    assert.equal(isDefaultTitle("  新会话 2026-04-20  "), true)
  })

  it("rejects user-edited titles", () => {
    assert.equal(isDefaultTitle("F022 讨论"), false)
  })

  it("rejects Haiku-generated titles", () => {
    assert.equal(isDefaultTitle("修 B017 session"), false)
  })

  it("rejects empty string", () => {
    assert.equal(isDefaultTitle(""), false)
  })

  it("rejects whitespace-only string", () => {
    assert.equal(isDefaultTitle("   "), false)
  })

  it("rejects '新会话 ' prefix with non-date suffix", () => {
    assert.equal(isDefaultTitle("新会话 abc"), false)
  })

  it("rejects partial date like '新会话 2026-04' (not full YYYY-MM-DD)", () => {
    assert.equal(isDefaultTitle("新会话 2026-04"), false)
  })

  it("AC-14d: matches 'D-新会话 YYYY-MM-DD' (new prefixed fallback)", () => {
    assert.equal(isDefaultTitle("D-新会话 2026-04-20"), true)
  })

  it("AC-14d: matches F-/B-/Q- variants of the new fallback", () => {
    assert.equal(isDefaultTitle("F-新会话 2026-04-20"), true)
    assert.equal(isDefaultTitle("B-新会话 2026-04-20"), true)
    assert.equal(isDefaultTitle("Q-新会话 2026-04-20"), true)
  })

  it("AC-14d: rejects invalid prefix letter (X-新会话 ...)", () => {
    assert.equal(isDefaultTitle("X-新会话 2026-04-20"), false)
  })
})
