import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { injectSeriesIdIntoFrontmatter } from "./ingest-commit"

/**
 * F027 P4 Day 10 AC-P4-3 e · injectSeriesIdIntoFrontmatter 单测
 *
 * 锁定 2 种情形 + 边界:
 *   (1) 无 frontmatter → prepend minimal ---\nseries_id: <id>\n---\n
 *   (2) 已有 frontmatter → 闭合 --- 前插一行 series_id
 *   (3) 闭合 --- 距离 > 5KB → 当作无 frontmatter (defensive)
 *   (4) 不破坏 body 原 hierarchy (frontmatter 前后空行 / 多 --- 句法保留)
 */

describe("injectSeriesIdIntoFrontmatter", () => {
  it("(1) 无 frontmatter → prepend minimal", () => {
    const r = injectSeriesIdIntoFrontmatter("# Hello\n\nbody", "rag-paper-v1")
    assert.equal(r, "---\nseries_id: rag-paper-v1\n---\n# Hello\n\nbody")
  })

  it("(2) 已有 frontmatter → 闭合 --- 前插 series_id 行", () => {
    const before = "---\ntype: concept\ntitle: RAG\n---\n# body"
    const r = injectSeriesIdIntoFrontmatter(before, "rag-paper-v1")
    assert.match(r, /^---\ntype: concept\ntitle: RAG\nseries_id: rag-paper-v1\n---\n# body$/)
  })

  it("(3) 闭合 --- 距离超 5KB → defensive prepend (不 patch in)", () => {
    const longBody = "x".repeat(6 * 1024)
    const before = `---\ntype: concept\n${longBody}\n---\nactual body`
    const r = injectSeriesIdIntoFrontmatter(before, "rag-paper-v1")
    // prepend 模式 (新 frontmatter 包旧 content)
    assert.ok(r.startsWith("---\nseries_id: rag-paper-v1\n---\n"))
    assert.ok(r.includes(longBody))
  })

  it("(4) body 含 H1 + frontmatter — 不损坏文本结构", () => {
    const before = "---\ntype: concept\n---\n\n# Hello world\n\nparagraph 1"
    const r = injectSeriesIdIntoFrontmatter(before, "series-001")
    assert.equal(
      r,
      "---\ntype: concept\nseries_id: series-001\n---\n\n# Hello world\n\nparagraph 1",
    )
  })

  it("(5) 空 body → 仍 prepend minimal", () => {
    const r = injectSeriesIdIntoFrontmatter("", "s-1")
    assert.equal(r, "---\nseries_id: s-1\n---\n")
  })

  it("(6) seriesId 含 underscore + hyphen + 数字 → 字面落 frontmatter", () => {
    const r = injectSeriesIdIntoFrontmatter("body", "series_test-001")
    assert.match(r, /series_id: series_test-001/)
  })
})
