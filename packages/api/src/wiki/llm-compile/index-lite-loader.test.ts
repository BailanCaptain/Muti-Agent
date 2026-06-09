/**
 * F027 v3 G11 · 生产 IndexLiteLoader 单测（node:test, temp 真目录）
 * 覆盖：load(["concepts","rules"]) 读 frontmatter / name=basename / summary 回退 /
 *       排除 draft 子目录 / 缺目录 fail-soft / methods scope / 忽略非 .md。
 */

import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"
import { createProductionIndexLiteLoader } from "./index-lite-loader"

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "g11-index-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function writeMd(rel: string, content: string): Promise<void> {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, "utf-8")
}

describe("createProductionIndexLiteLoader", () => {
  it("读 concepts/rules 顶层 .md → name=basename, summary=frontmatter.summary", async () => {
    await writeMd(
      "concepts/f018-context-resume.md",
      "---\ntitle: F018 Context Resume\nsummary: 上下文续传机制\n---\n正文",
    )
    await writeMd("rules/r-198-measure-first.md", "---\ntitle: R198\nsummary: 实测优先\n---\nbody")

    const loader = createProductionIndexLiteLoader({ wikiRoot: root })
    const out = await loader.load(["concepts", "rules"])

    assert.deepEqual(out.concepts, [{ name: "f018-context-resume", summary: "上下文续传机制" }])
    assert.deepEqual(out.rules, [{ name: "r-198-measure-first", summary: "实测优先" }])
  })

  it("排除 draft/ 子目录（draft 非已发布 entity）", async () => {
    await writeMd("concepts/live.md", "---\nsummary: 已发布\n---\nx")
    await writeMd("concepts/draft/_auto/wip.md", "---\nsummary: 草稿\n---\nx")

    const loader = createProductionIndexLiteLoader({ wikiRoot: root })
    const out = await loader.load(["concepts"])

    assert.deepEqual(
      out.concepts.map((e) => e.name),
      ["live"],
    )
  })

  it("缺 summary → 回退 body 首个非标题非空行", async () => {
    await writeMd("concepts/nosum.md", "---\ntitle: NoSum\n---\n# 标题\n\n这是首段内容")

    const loader = createProductionIndexLiteLoader({ wikiRoot: root })
    const out = await loader.load(["concepts"])
    assert.deepEqual(out.concepts[0], { name: "nosum", summary: "这是首段内容" })
  })

  it("缺目录 → fail-soft 返空数组", async () => {
    const loader = createProductionIndexLiteLoader({ wikiRoot: root })
    const out = await loader.load(["concepts", "rules"])
    assert.deepEqual(out, { concepts: [], rules: [] })
  })

  it("methods scope 支持", async () => {
    await writeMd("methods/m1.md", "---\nsummary: 方法一\n---\nx")
    const loader = createProductionIndexLiteLoader({ wikiRoot: root })
    const out = await loader.load(["concepts", "rules", "methods"])
    assert.deepEqual(out.methods, [{ name: "m1", summary: "方法一" }])
  })

  it("忽略非 .md 文件", async () => {
    await writeMd("concepts/real.md", "---\nsummary: s\n---\nx")
    await writeMd("concepts/README.txt", "not markdown")
    const loader = createProductionIndexLiteLoader({ wikiRoot: root })
    const out = await loader.load(["concepts"])
    assert.deepEqual(
      out.concepts.map((e) => e.name),
      ["real"],
    )
  })
})
