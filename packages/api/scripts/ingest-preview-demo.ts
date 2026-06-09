#!/usr/bin/env tsx
/**
 * F027 B3 · 一次性 demo runner —— 用 ingest-module 把 N 篇 docs 持久化进 **worktree preview 库**，
 * 让小孙在 KB tab 看真编译实体。非生产入口（生产走 backfill-docs.ts --ingest-module）。
 *
 * 目标库（worktree preview，非主库）：
 *   SQLITE_PATH = .runtime/worktree-preview/data/multi-agent.sqlite
 *   WIKI_ROOT   = .runtime/wiki
 * 默认 1 篇/桶（features/bugReport/lessons = 3 篇）；--limit N 取前 N 篇 flat。
 */
import path from "node:path"
import { DEFAULT_DOCS_SUBDIRS, enumerateDocsFiles } from "./backfill-docs"
import { createIngestModule } from "./ingest-module"

async function main() {
  const rootDir = process.cwd()
  const limitArg = process.argv.indexOf("--limit")
  const limit = limitArg >= 0 ? Number.parseInt(process.argv[limitArg + 1], 10) : null
  const sqlitePath = path.join(rootDir, ".runtime", "worktree-preview", "data", "multi-agent.sqlite")
  const wikiRoot = path.join(rootDir, ".runtime", "wiki")

  let handbookCompileRules = ""
  try {
    const { loadHandbookSlices } = await import("../src/wiki/handbook-slicer")
    handbookCompileRules = (await loadHandbookSlices(rootDir)).compileRules
  } catch (err) {
    console.error(`[demo] handbook 加载失败（空规则继续）：${err instanceof Error ? err.message : String(err)}`)
  }

  const mod = createIngestModule({
    sqlitePath,
    wikiRoot,
    handbookCompileRules,
    logger: (m) => console.error(`[demo] ${m}`),
  })
  console.error(`[demo] preview DB=${sqlitePath}`)
  console.error(`[demo] wikiRoot=${wikiRoot}（commit 落 <wikiRoot>/wiki/concepts/draft/_auto/）`)

  try {
    const all = await enumerateDocsFiles(rootDir, DEFAULT_DOCS_SUBDIRS)
    let picked: string[]
    if (limit !== null) {
      picked = all.slice(0, limit)
    } else {
      const seen = new Set<string>()
      picked = []
      for (const abs of all) {
        const rel = path.relative(rootDir, abs).replace(/\\/g, "/")
        const bucket = rel.split("/")[1] ?? "x"
        if (seen.has(bucket)) continue
        seen.add(bucket)
        picked.push(abs)
      }
    }
    console.error(`[demo] 选中 ${picked.length} 篇`)
    const results: Array<{ file: string; ok: boolean; eventId?: string; error?: string }> = []
    for (const abs of picked) {
      const rel = path.relative(rootDir, abs).replace(/\\/g, "/")
      console.error(`[demo] ingest ${rel} …`)
      try {
        const res = await mod.ingest(abs, rel)
        console.error(`[demo] ✓ ${rel} → eventId=${res.ingestEventId} crossRefs=${res.crossRefs}`)
        results.push({ file: rel, ok: true, eventId: res.ingestEventId })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.error(`[demo] ✗ ${rel} → ${error}`)
        results.push({ file: rel, ok: false, error })
      }
    }
    console.log(
      JSON.stringify(
        {
          ok: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        },
        null,
        2,
      ),
    )
  } finally {
    mod.close()
  }
}

main().catch((e) => {
  console.error("DEMO_FAIL:", e instanceof Error ? e.stack : e)
  process.exit(1)
})
