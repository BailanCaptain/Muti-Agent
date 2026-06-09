/**
 * F027 B2/B1-c · createWikiIndexRecompiler 集成测试。
 *
 * 用 temp wikiRoot 真跑 compileWiki，断言索引文件真产出（liveness 实证：文件源 → 全局索引）。
 * 不 mock compileWiki —— 验「scanEntities → buildWikiMemoriesFromEntities → compileWiki 写盘」整链。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import type { ScannedWikiEntity } from "./wiki-memory-from-files"
import { createWikiIndexRecompiler } from "./wiki-index-recompile"

function mktmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "f027-wiki-index-"))
}

test("B2 · 带 marker 实体 → compileWiki 真写 index.md + v-XXX/concepts.md（含实体名）", async () => {
  const dir = mktmp()
  try {
    const entities: ScannedWikiEntity[] = [
      {
        path: "wiki/concepts/F027.md",
        frontmatter: {
          canonical_owner_path: "wiki/concepts/F027.md",
          state: "canonical",
          type: "project",
          name: "F027统一记忆架构",
        },
        body: "F027 body 内容",
      },
    ]
    const recompile = createWikiIndexRecompiler({
      wikiRoot: dir,
      scanEntities: async () => entities,
      version: () => "2026060501",
    })
    await recompile()

    const indexMd = path.join(dir, "index.md")
    assert.ok(fs.existsSync(indexMd), "顶层 index.md 应产出（KB tab / prompt 注入入口）")
    assert.match(fs.readFileSync(indexMd, "utf-8"), /F027统一记忆架构/, "index.md 含 canonical 实体名")

    const conceptsMd = path.join(dir, "index", "v-2026060501", "concepts.md")
    assert.ok(fs.existsSync(conceptsMd), "v-XXX/concepts.md 应产出（canonical_owner_path 含 /concepts/）")
    assert.match(fs.readFileSync(conceptsMd, "utf-8"), /F027统一记忆架构/)

    assert.ok(fs.existsSync(path.join(dir, "index", "manifest.json")), "manifest.json 应产出")

    // reader 对齐（命门）：GET /api/wiki/index 扫 flat index/*.md（非递归）——必须有平铺副本，
    // 否则 KB tab 读不到 v-XXX/ 子目录里的文件。
    const flatConcepts = path.join(dir, "index", "concepts.md")
    assert.ok(fs.existsSync(flatConcepts), "flat index/concepts.md 必须有（reader 非递归扫 index/）")
    assert.match(fs.readFileSync(flatConcepts, "utf-8"), /F027统一记忆架构/, "平铺副本含实体 → KB tab 可见")

    // 德彪 codex P3-1：sources.md / log.md 是运营视图，不平铺进 KB 列表（但 v-XXX/ 里仍有作历史）
    assert.ok(!fs.existsSync(path.join(dir, "index", "sources.md")), "sources.md 不该平铺（运营视图非知识桶）")
    assert.ok(!fs.existsSync(path.join(dir, "index", "log.md")), "log.md 不该平铺（事件审计非知识桶）")
    assert.ok(
      fs.existsSync(path.join(dir, "index", "v-2026060501", "sources.md")),
      "但 v-XXX/sources.md 仍在（历史快照保留）",
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("B2 · 全无 marker（派生视图/未编译）→ index 产出但 0 canonical（不污染）", async () => {
  const dir = mktmp()
  try {
    const recompile = createWikiIndexRecompiler({
      wikiRoot: dir,
      scanEntities: async () => [
        { path: "wiki/rooms/R-201/viewfinder.md", frontmatter: {}, body: "派生视图" },
        { path: "wiki/index/v-old/index.md", frontmatter: {}, body: "旧索引" },
      ],
      version: () => "2026060501",
    })
    await recompile()
    const indexMd = path.join(dir, "index.md")
    assert.ok(fs.existsSync(indexMd), "index.md 仍产出（空壳，等 B3 backfill）")
    // 派生视图/旧索引内容不该作为 canonical 实体出现在 concepts 列表
    const conceptsMd = fs.readFileSync(path.join(dir, "index", "v-2026060501", "concepts.md"), "utf-8")
    assert.ok(!conceptsMd.includes("派生视图"), "派生视图不进 canonical 索引")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("B2 · scanEntities 抛错 → fail-soft 不抛（debounce.fire 不崩）", async () => {
  let logged = false
  const recompile = createWikiIndexRecompiler({
    wikiRoot: path.join(os.tmpdir(), "f027-nonexist"),
    scanEntities: async () => {
      throw new Error("simulated scan crash")
    },
    logger: { error: () => { logged = true }, warn: () => {} },
  })
  await recompile() // 不该抛
  assert.equal(logged, true, "失败应 log（不静默）")
})
