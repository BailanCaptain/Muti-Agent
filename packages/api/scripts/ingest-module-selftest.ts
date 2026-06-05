#!/usr/bin/env tsx
/**
 * F027 B3 · ingest-module 临时实例自测（Iron Law：临时 sqlite + 临时 wikiRoot，不碰 live DB）。
 * 跑 1 篇真 doc 过 preview→commit，断言 entity 文件落 `<wikiRoot>/wiki/concepts/draft/_auto/`。
 * 真调 Opus 一次（~30-90s）。用法：tsx packages/api/scripts/ingest-module-selftest.ts
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createIngestModule } from "./ingest-module"

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "f027-ingest-mod-"))
  const sqlitePath = path.join(tmp, "test.sqlite")
  const wikiRoot = path.join(tmp, "wiki")
  const mod = createIngestModule({ sqlitePath, wikiRoot, logger: (m) => console.error(`[mod] ${m}`) })
  try {
    const src = "docs/bugReport/B001-ws-emit-silent-failure.md"
    const abs = path.resolve(src)
    console.error(`[selftest] ingest ${src} → tmp wikiRoot=${wikiRoot}`)
    const res = await mod.ingest(abs, src)
    console.log("INGEST_RESULT:", JSON.stringify(res))
    const draftDir = path.join(wikiRoot, "wiki", "concepts", "draft", "_auto")
    if (!existsSync(draftDir)) {
      console.log("RESULT: FAIL — draft dir 不存在（commit 没落盘到预期 root）")
      process.exit(1)
    }
    const files = readdirSync(draftDir)
    console.log("DRAFT_FILES:", files.join(","))
    if (files.length === 0) {
      console.log("RESULT: FAIL — draft dir 空")
      process.exit(1)
    }
    const body = readFileSync(path.join(draftDir, files[0]), "utf-8")
    const hasFrontmatter = body.startsWith("---") && body.includes("canonical_owner_path")
    console.log(`ENTITY_FRONTMATTER_OK: ${hasFrontmatter}`)
    console.log(`RESULT: ${hasFrontmatter ? "PASS — preview→commit 落盘正确 root + frontmatter 完整" : "PARTIAL — 落盘了但 frontmatter 缺 canonical_owner_path"}`)
  } finally {
    mod.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error("SELFTEST_FAIL:", e instanceof Error ? e.stack : e)
  process.exit(1)
})
