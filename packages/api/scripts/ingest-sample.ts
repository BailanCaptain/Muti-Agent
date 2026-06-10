#!/usr/bin/env tsx
/**
 * F027 B3 · ingest 质量样本脚本（小孙 2026-06-06 拍："worktree 先跑几篇我看看质量"）。
 *
 * 目的：用**生产编译链**（embedding + indexLoader + entityChecker + Opus 4.7 llmClient +
 * handbook 编译规则，与 server.ts:805-836 同构）对少量 docs 跑 `IngestPreviewService.preview()`，
 * 把真编译产物 `llmCompiledPreview`（= compiledMarkdown，含 cross_refs / canonical_owner /
 * type/state frontmatter）写到 out 目录，给小孙肉眼验质量。
 *
 * **只跑 preview（compile）**：不接 store / correlate / commit —— 不碰 DB / lease / 落盘 wiki。
 * 编译产物的内容质量与真跑（preview→commit）完全一致（commit 只负责持久化，不改内容）。
 * 完整 ingest-module（补 commit）留全量 55 篇真跑时建。
 *
 * 用法（worktree 根，注 WIKI_ROOT 指 worktree 的 .runtime/wiki）：
 *   pnpm --filter @multi-agent/api exec tsx scripts/ingest-sample.ts [--limit N] [--out <dir>]
 *
 *   --limit N   跑前 N 篇（默认：features / bugReport / lessons 各取第 1 篇 = 3 篇代表样本）
 *   --out <dir> 产物目录（默认 .runtime/ingest-samples）
 *
 * ⚠️ 真调 Opus 4.7（claude CLI），每篇一次，会花 API 配额。仅样本用途。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { IngestPreviewService } from "../src/routes/phase3/ingest-preview"
import { createOpusRunner, createHaikuRunner } from "../src/runtime/haiku-runner"
import { createRunnerWithFallback } from "../src/runtime/runner-with-fallback"
import { EmbeddingService } from "../src/services/embedding-service"
import { createProductionCompileLLMClient } from "../src/wiki/llm-compile/production-compile-llm-client"
import { createProductionEntityExistenceChecker } from "../src/wiki/llm-compile/entity-existence-checker"
import { createProductionIndexLiteLoader } from "../src/wiki/llm-compile/index-lite-loader"
import { enumerateDocsFiles, DEFAULT_DOCS_SUBDIRS } from "./backfill-docs"

interface SampleResult {
  file: string
  outPath: string
  ok: boolean
  fellBackToStub: boolean
  warnings: string[]
  bytes: number
  ms: number
}

/** 选样本：默认每个 docs 子目录取第 1 篇（保证 features/bugReport/lessons 代表性）；--limit 时取前 N 篇 flat。 */
async function selectSampleFiles(rootDir: string, limit: number | null): Promise<string[]> {
  const all = await enumerateDocsFiles(rootDir, DEFAULT_DOCS_SUBDIRS)
  if (limit !== null) return all.slice(0, limit)
  // 默认：按 bucket（docs/<bucket>/...）分组各取第 1 篇
  const seen = new Set<string>()
  const picked: string[] = []
  for (const abs of all) {
    const rel = path.relative(rootDir, abs).replace(/\\/g, "/")
    const bucket = rel.split("/")[1] ?? "unknown"
    if (seen.has(bucket)) continue
    seen.add(bucket)
    picked.push(abs)
  }
  return picked
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      limit: { type: "string" },
      out: { type: "string" },
      "root-dir": { type: "string" },
    },
    strict: true,
  })
  const rootDir = values["root-dir"] ?? process.cwd()
  const limit = values.limit ? Number.parseInt(values.limit, 10) : null
  const outDir = path.isAbsolute(values.out ?? "")
    ? (values.out as string)
    : path.join(rootDir, values.out ?? path.join(".runtime", "ingest-samples"))

  // 编译链（与 server.ts:805-836 同构）
  const wikiRoot = path.join(
    process.env.WIKI_ROOT || path.join(rootDir, ".runtime", "wiki"),
    "wiki",
  )
  const log = (msg: string) => console.error(`[ingest-sample] ${msg}`)

  let handbookCompileRules = ""
  try {
    const { loadHandbookSlices } = await import("../src/wiki/handbook-slicer")
    const handbookRoot = process.env.WIKI_HANDBOOK_ROOT || rootDir
    handbookCompileRules = (await loadHandbookSlices(handbookRoot)).compileRules
  } catch (err) {
    log(`handbook compileRules load failed (用空规则继续): ${err instanceof Error ? err.message : String(err)}`)
  }

  const preview = new IngestPreviewService({
    compile: {
      embedding: new EmbeddingService({}),
      indexLoader: createProductionIndexLiteLoader({ wikiRoot }),
      entityChecker: createProductionEntityExistenceChecker({ wikiRoot }),
      llmClient: createProductionCompileLLMClient({
        runner: createRunnerWithFallback({
          primary: createOpusRunner(),
          fallback: createHaikuRunner(),
        }),
        // F027 B3：batch backfill 不赶 interactive latency，编译超时放宽到 180s
        // （生产 IngestPreview 默认 60s 是为 IngestModal 交互体验；大文档如 45KB
        // lessons-learned.md 实测 60s 不够 → 退 stub。batch 场景可放长）。
        timeoutMs: 180_000,
        logger: log,
      }),
      handbookCompileRules,
      logger: log,
    },
  })

  const files = await selectSampleFiles(rootDir, limit)
  log(`wikiRoot=${wikiRoot}`)
  log(`handbookCompileRules=${handbookCompileRules ? `${handbookCompileRules.length} chars` : "(空)"}`)
  log(`选中 ${files.length} 篇样本，输出到 ${outDir}`)
  mkdirSync(outDir, { recursive: true })

  const results: SampleResult[] = []
  for (const abs of files) {
    const rel = path.relative(rootDir, abs).replace(/\\/g, "/")
    const content = readFileSync(abs, "utf-8")
    const started = Date.now()
    log(`编译中：${rel} (${content.length} bytes) …`)
    let res: Awaited<ReturnType<typeof preview.preview>>
    try {
      res = await preview.preview(
        { sourcePath: rel, content, mimeType: "text/markdown" },
        { provenance: "docs-watcher" },
      )
    } catch (err) {
      log(`✗ ${rel} preview 抛错：${err instanceof Error ? err.message : String(err)}`)
      results.push({
        file: rel,
        outPath: "",
        ok: false,
        fellBackToStub: false,
        warnings: [`preview threw: ${err instanceof Error ? err.message : String(err)}`],
        bytes: content.length,
        ms: Date.now() - started,
      })
      continue
    }
    const ms = Date.now() - started
    // 德彪 codex batch1 P2-1：blocked（sanitize 红线）≠ 编译失败 —— 原逻辑会写空预览文件
    // 还标 ok:true 假成功。直报 sanitize_blocked 不写文件。
    if (res.blocked) {
      const reasons = res.warnings.map((w) => w.subkind ?? w.kind).join(", ")
      log(`🚫 ${rel} sanitize_blocked (${reasons})，跳过`)
      results.push({
        file: rel,
        outPath: "",
        ok: false,
        fellBackToStub: false,
        warnings: [`sanitize_blocked: ${reasons}`],
        bytes: content.length,
        ms,
      })
      continue
    }
    const compileFailed = res.warnings.some((w) => w.kind === "compile_failed")
    const outName = `${rel.replace(/[\\/]/g, "__")}`
    const outPath = path.join(outDir, outName)
    const header = [
      "<!-- F027 B3 ingest 样本 -->",
      `<!-- 源文件: ${rel} -->`,
      "<!-- 编译模型: Opus 4.7 primary + Haiku 4.5 fallback -->",
      `<!-- 编译耗时: ${ms}ms${compileFailed ? " · ⚠️ 真编译失败已退回 stub 预览" : ""} -->`,
      res.warnings.length ? `<!-- warnings: ${res.warnings.map((w) => `${w.kind}/${w.subkind ?? ""}`).join(", ")} -->` : "",
      "",
    ].filter(Boolean).join("\n")
    writeFileSync(outPath, `${header}\n${res.llmCompiledPreview}\n`, "utf-8")
    log(
      `${compileFailed ? "⚠️ stub" : "✓ 真编译"} ${rel} → ${outName} (${ms}ms)`,
    )
    results.push({
      file: rel,
      outPath,
      ok: !compileFailed,
      fellBackToStub: compileFailed,
      warnings: res.warnings.map((w) => `${w.kind}/${w.subkind ?? ""}`),
      bytes: content.length,
      ms,
    })
  }

  // 汇总
  console.log(
    JSON.stringify(
      {
        outDir,
        total: results.length,
        trueCompiled: results.filter((r) => r.ok).length,
        stubFallback: results.filter((r) => r.fellBackToStub).length,
        results,
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
