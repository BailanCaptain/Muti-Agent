/**
 * F027 Phase 3 P20 · frontmatter parser tests — Week 1 Day 3
 */

import assert from "node:assert/strict"
import test from "node:test"
import { FrontmatterParseError, parseFrontmatter } from "./frontmatter"

test("Day 3 · frontmatter · 合法 yaml block 解析", () => {
  const raw = "---\ntitle: hello\ntype: feature\n---\nbody text"
  const r = parseFrontmatter<{ title: string; type: string }>(raw)
  assert.deepEqual(r.frontmatter, { title: "hello", type: "feature" })
  assert.equal(r.body, "body text")
})

test("Day 3 · frontmatter · 无 frontmatter 返 null + body 原样", () => {
  const raw = "# Hello\n\nno frontmatter here"
  const r = parseFrontmatter(raw)
  assert.equal(r.frontmatter, null)
  assert.equal(r.body, raw)
})

test("Day 3 · frontmatter · 空 body 也接受", () => {
  const raw = "---\nfoo: bar\n---\n"
  const r = parseFrontmatter<{ foo: string }>(raw)
  assert.deepEqual(r.frontmatter, { foo: "bar" })
  assert.equal(r.body, "")
})

test("Day 3 · frontmatter · CRLF 行结尾兼容", () => {
  const raw = "---\r\ntitle: x\r\n---\r\nbody"
  const r = parseFrontmatter<{ title: string }>(raw)
  assert.equal(r.frontmatter?.title, "x")
  assert.equal(r.body, "body")
})

test("Day 3 · frontmatter · 损坏 yaml 抛 FrontmatterParseError", () => {
  const raw = "---\nfoo: : bad\n---\n"
  assert.throws(() => parseFrontmatter(raw), FrontmatterParseError)
})

test("Day 3 · frontmatter · 顶层非 object（array）→ null 而非抛", () => {
  const raw = "---\n- a\n- b\n---\nbody"
  const r = parseFrontmatter(raw)
  assert.equal(r.frontmatter, null)
  assert.equal(r.body, "body")
})
