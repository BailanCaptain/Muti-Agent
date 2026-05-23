/**
 * F027 P19.7.5 · backfill-docs.ts 测试 — AC-P2-8/9 (v2a F4)
 *
 * 覆盖：
 *   - parseBackfillArgs CLI parsing
 *   - enumerateDocsFiles：递归 walk + 跳 dotfiles + 只取 *.md
 *   - readBackfillState / appendBackfillState 进度文件读写
 *   - 损坏行（kill -9 中途半行）跳过不打断
 *   - analyzeDocFile：bucket / crossRefs / failed
 *   - buildDryRunReport / renderDryRunReport：类型分布 + top crossRefs + failed
 *   - **AC-P2-8 dry-run：写报告，不调 ingest，不写 state**
 *   - **AC-P2-9 真跑 + resume：跳 committed 文件 + 不重跑成功的**
 *   - **AC-P2-9 v2a F4 marker 双源**：state.jsonl 优先；缺失 fallback
 *     扫 frontmatter（注：本测覆盖 state 优先路径；frontmatter fallback
 *     由 ingest pipeline post-compile.ts:83-87 已落地，本脚本不重写）
 *   - 失败文件落 status='failed' + error 字段
 *   - **不新增 DB schema**（本脚本不动 DB；通过不依赖任何 DB import 验证）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import {
  type BackfillStateEntry,
  type IngestFn,
  analyzeDocFile,
  appendBackfillState,
  buildDryRunReport,
  enumerateDocsFiles,
  extractSourcePathFromFrontmatter,
  parseBackfillArgs,
  readBackfillState,
  renderDryRunReport,
  runBackfill,
  runBackfillFromCli,
  scanFrontmatterCommittedSources,
} from "./backfill-docs"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}
function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

function setupDocsTree(tempDir: string): { rootDir: string } {
  const docsDir = path.join(tempDir, "docs")
  fs.mkdirSync(path.join(docsDir, "features"), { recursive: true })
  fs.mkdirSync(path.join(docsDir, "bugReport"), { recursive: true })
  fs.mkdirSync(path.join(docsDir, "lessons"), { recursive: true })
  fs.writeFileSync(
    path.join(docsDir, "features", "F999.md"),
    "# F999\n\n[[wiki/concepts/test]]\n[[wiki/concepts/another]]\n([../bugReport/B001.md](../bugReport/B001.md))\n",
  )
  fs.writeFileSync(
    path.join(docsDir, "features", "F998.md"),
    "# F998\n\nNo links here.\n",
  )
  fs.writeFileSync(
    path.join(docsDir, "bugReport", "B999.md"),
    "# B999\n\n[[wiki/concepts/bug]]\n",
  )
  fs.writeFileSync(
    path.join(docsDir, "lessons", "L001.md"),
    "# Lesson 1\n",
  )
  // 应跳过的非 .md 文件
  fs.writeFileSync(path.join(docsDir, "features", "README.txt"), "ignore me\n")
  // 应跳过的 dotfile
  fs.writeFileSync(path.join(docsDir, "features", ".DS_Store"), "")
  return { rootDir: tempDir }
}

// ── parseBackfillArgs ───────────────────────────────────────────────────

test("backfill-docs · parseBackfillArgs default 全 false", () => {
  const args = parseBackfillArgs([])
  assert.equal(args.dryRun, false)
  assert.equal(args.resume, false)
  assert.equal(args.ingestModule, null)
})

test("backfill-docs · parseBackfillArgs --dry-run + --resume + --root-dir", () => {
  const args = parseBackfillArgs([
    "--dry-run",
    "--resume",
    "--root-dir",
    "/tmp/test",
    "--ingest-module",
    "./my-ingest.js",
  ])
  assert.equal(args.dryRun, true)
  assert.equal(args.resume, true)
  assert.equal(args.rootDir, "/tmp/test")
  assert.equal(args.ingestModule, "./my-ingest.js")
})

// ── enumerateDocsFiles ──────────────────────────────────────────────────

test("backfill-docs · enumerateDocsFiles 递归 walk + 只取 *.md + 跳 dotfile", async () => {
  const tempDir = safeTempDir("backfill-enum-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const files = await enumerateDocsFiles(rootDir, [
      "docs/features",
      "docs/bugReport",
      "docs/lessons",
    ])
    const rels = files.map((f) => path.relative(rootDir, f).replace(/\\/g, "/"))
    assert.deepEqual(
      rels.sort(),
      [
        "docs/bugReport/B999.md",
        "docs/features/F998.md",
        "docs/features/F999.md",
        "docs/lessons/L001.md",
      ],
    )
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · enumerateDocsFiles 子目录不存在 → 跳过不抛", async () => {
  const tempDir = safeTempDir("backfill-missing-")
  try {
    fs.mkdirSync(path.join(tempDir, "docs", "features"), { recursive: true })
    fs.writeFileSync(path.join(tempDir, "docs", "features", "x.md"), "x")
    const files = await enumerateDocsFiles(tempDir, [
      "docs/features",
      "docs/bugReport", // 不存在
    ])
    assert.equal(files.length, 1)
  } finally {
    safeCleanup(tempDir)
  }
})

// ── State file ──────────────────────────────────────────────────────────

test("backfill-docs · readBackfillState 文件不存在返空 Map", () => {
  const map = readBackfillState("/non/existent/path/state.jsonl")
  assert.equal(map.size, 0)
})

test("backfill-docs · appendBackfillState 写 + readBackfillState 读 roundtrip", () => {
  const tempDir = safeTempDir("backfill-state-")
  try {
    const stateFile = path.join(tempDir, ".runtime", "backfill-state.jsonl")
    const e1: BackfillStateEntry = {
      file: "docs/features/F999.md",
      status: "committed",
      ingestEventId: "evt-1",
      ts: "2026-05-15T00:00:00.000Z",
    }
    const e2: BackfillStateEntry = {
      file: "docs/features/F998.md",
      status: "failed",
      ingestEventId: null,
      ts: "2026-05-15T00:00:01.000Z",
      error: "LLM timeout",
    }
    appendBackfillState(stateFile, e1)
    appendBackfillState(stateFile, e2)
    const map = readBackfillState(stateFile)
    assert.equal(map.size, 2)
    assert.equal(map.get("docs/features/F999.md")?.status, "committed")
    assert.equal(map.get("docs/features/F998.md")?.error, "LLM timeout")
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · readBackfillState 损坏行（半行）跳过不打断（kill -9 容错）", () => {
  const tempDir = safeTempDir("backfill-state-corrupt-")
  try {
    const stateFile = path.join(tempDir, "state.jsonl")
    // 第二行是 kill -9 中途半行的模拟
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({ file: "a.md", status: "committed", ingestEventId: "1", ts: "t1" })}\n` +
        '{"file":"b.md","status":"comm\n' + // 半行损坏
        `${JSON.stringify({ file: "c.md", status: "committed", ingestEventId: "3", ts: "t3" })}\n`,
      "utf-8",
    )
    const map = readBackfillState(stateFile)
    assert.equal(map.size, 2, "损坏行被跳过；a.md + c.md 保留")
    assert.ok(map.has("a.md"))
    assert.ok(map.has("c.md"))
    assert.ok(!map.has("b.md"))
  } finally {
    safeCleanup(tempDir)
  }
})

// ── analyzeDocFile + buildDryRunReport ──────────────────────────────────

test("backfill-docs · analyzeDocFile bucket + crossRefs 计数", () => {
  const tempDir = safeTempDir("backfill-analyze-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const f999 = path.join(rootDir, "docs", "features", "F999.md")
    const stat = analyzeDocFile(f999, rootDir)
    assert.equal(stat.bucket, "features")
    assert.equal(stat.failed, false)
    assert.equal(stat.crossRefs, 3, "2 wikilinks + 1 rellink")
    assert.ok(stat.size > 0)
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · analyzeDocFile 文件不存在 → failed=true", () => {
  const stat = analyzeDocFile("/non/existent.md", "/tmp")
  assert.equal(stat.failed, true)
  assert.ok(stat.error)
})

test("backfill-docs · buildDryRunReport 类型分布 + top crossRefs + failed", () => {
  const tempDir = safeTempDir("backfill-report-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const stats = [
      analyzeDocFile(path.join(rootDir, "docs", "features", "F999.md"), rootDir),
      analyzeDocFile(path.join(rootDir, "docs", "features", "F998.md"), rootDir),
      analyzeDocFile(path.join(rootDir, "docs", "bugReport", "B999.md"), rootDir),
      analyzeDocFile(path.join(rootDir, "docs", "lessons", "L001.md"), rootDir),
    ]
    const committed = new Set(["docs/features/F998.md"])
    const report = buildDryRunReport(stats, committed)

    assert.equal(report.totalFiles, 4)
    assert.equal(report.alreadyCommitted, 1)
    assert.equal(report.toProcess, 3)
    assert.deepEqual(report.byBucket, { features: 2, bugReport: 1, lessons: 1 })
    assert.equal(report.topCrossRefs[0].file.replace(/\\/g, "/"), "docs/features/F999.md")
    assert.equal(report.topCrossRefs[0].crossRefs, 3)
    assert.equal(report.failedFiles.length, 0)
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · renderDryRunReport markdown 输出含关键 section", () => {
  const report = {
    generatedAt: "2026-05-15T00:00:00.000Z",
    totalFiles: 10,
    alreadyCommitted: 2,
    toProcess: 8,
    byBucket: { features: 5, bugReport: 3, lessons: 2 },
    topCrossRefs: [
      { file: "docs/features/A.md", bucket: "features", crossRefs: 12, size: 1024, failed: false },
    ],
    failedFiles: [
      { file: "docs/features/B.md", bucket: "features", crossRefs: 0, size: 0, failed: true, error: "EACCES" },
    ],
  }
  const md = renderDryRunReport(report)
  assert.match(md, /# F027 P19\.7\.5/)
  assert.match(md, /Total files scanned: 10/)
  assert.match(md, /Already committed.*2/)
  assert.match(md, /To process: 8/)
  assert.match(md, /features: 5/)
  assert.match(md, /Top.*Cross-Refs/)
  assert.match(md, /docs\/features\/A\.md.*12 refs/)
  assert.match(md, /docs\/features\/B\.md: EACCES/)
})

// ── runBackfill — AC-P2-8 dry-run ───────────────────────────────────────

test("backfill-docs · AC-P2-8 dry-run: 写报告 + 不调 ingest + 不写 state", async () => {
  const tempDir = safeTempDir("backfill-dryrun-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const stateFile = path.join(rootDir, ".runtime", "backfill-state.jsonl")
    const reportFile = path.join(rootDir, "docs", "plans", "V16.5-backfill-report-2026-05-15.md")

    let ingestCalls = 0
    const ingestFn: IngestFn = async () => {
      ingestCalls += 1
      return { ingestEventId: "x", type: "concept", crossRefs: 0 }
    }

    const result = await runBackfill({
      rootDir,
      docsSubdirs: ["docs/features", "docs/bugReport", "docs/lessons"],
      stateJsonlPath: stateFile,
      reportPath: reportFile,
      dryRun: true,
      resume: false,
      ingestFn,
    })

    assert.equal(result.dryRun, true)
    assert.equal(result.totalFiles, 4)
    assert.equal(ingestCalls, 0, "dry-run 不应调 ingest")
    assert.equal(fs.existsSync(stateFile), false, "dry-run 不应写 state.jsonl")
    assert.ok(fs.existsSync(reportFile), "dry-run 应写报告")
    const reportContent = fs.readFileSync(reportFile, "utf-8")
    assert.match(reportContent, /Total files scanned: 4/)
  } finally {
    safeCleanup(tempDir)
  }
})

// ── runBackfill — AC-P2-9 真跑 + resume ─────────────────────────────────

test("backfill-docs · AC-P2-9 真跑: 全部文件调 ingest + state.jsonl 写 committed", async () => {
  const tempDir = safeTempDir("backfill-real-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const stateFile = path.join(rootDir, ".runtime", "backfill-state.jsonl")
    const reportFile = path.join(rootDir, "docs", "plans", "report.md") // 不会被写
    let counter = 0
    const ingestFn: IngestFn = async () => {
      counter += 1
      return { ingestEventId: `evt-${counter}`, type: "concept", crossRefs: 1 }
    }
    const result = await runBackfill({
      rootDir,
      docsSubdirs: ["docs/features", "docs/bugReport", "docs/lessons"],
      stateJsonlPath: stateFile,
      reportPath: reportFile,
      dryRun: false,
      resume: false,
      ingestFn,
    })
    assert.equal(result.dryRun, false)
    assert.equal(result.totalFiles, 4)
    assert.equal(result.succeeded, 4)
    assert.equal(result.failed, 0)
    assert.equal(counter, 4)
    assert.ok(fs.existsSync(stateFile))
    const stateMap = readBackfillState(stateFile)
    assert.equal(stateMap.size, 4)
    for (const e of stateMap.values()) {
      assert.equal(e.status, "committed")
      assert.match(e.ingestEventId ?? "", /^evt-/)
    }
    // 不写 report
    assert.equal(fs.existsSync(reportFile), false)
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · AC-P2-9 v2a F4 marker --resume: 跳 state 已 committed 的文件", async () => {
  const tempDir = safeTempDir("backfill-resume-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const stateFile = path.join(rootDir, ".runtime", "backfill-state.jsonl")
    const reportFile = path.join(rootDir, "docs", "plans", "report.md")

    // 预填 state：F999 + B999 已 committed（应被 resume 跳过）
    appendBackfillState(stateFile, {
      file: "docs/features/F999.md",
      status: "committed",
      ingestEventId: "evt-old-1",
      ts: "2026-05-14T00:00:00.000Z",
    })
    appendBackfillState(stateFile, {
      file: "docs/bugReport/B999.md",
      status: "committed",
      ingestEventId: "evt-old-2",
      ts: "2026-05-14T00:00:01.000Z",
    })

    let counter = 100
    const ingestedFiles: string[] = []
    const ingestFn: IngestFn = async (_abs, source) => {
      counter += 1
      ingestedFiles.push(source)
      return { ingestEventId: `evt-${counter}`, type: "concept", crossRefs: 0 }
    }
    const result = await runBackfill({
      rootDir,
      docsSubdirs: ["docs/features", "docs/bugReport", "docs/lessons"],
      stateJsonlPath: stateFile,
      reportPath: reportFile,
      dryRun: false,
      resume: true,
      ingestFn,
    })
    assert.equal(result.skipped, 2, "F999 + B999 应跳过")
    assert.equal(result.succeeded, 2, "F998 + L001 真跑")
    const ingestedRel = ingestedFiles.map((f) => f.replace(/\\/g, "/"))
    assert.deepEqual(
      ingestedRel.sort(),
      ["docs/features/F998.md", "docs/lessons/L001.md"],
    )
  } finally {
    safeCleanup(tempDir)
  }
})

// ── 范-r1 P2-1: frontmatter fallback (v2a F4) ──────────────────────────

test("backfill-docs · 范-r1 P2-1: extractSourcePathFromFrontmatter 提取 ingest_metadata.source_path", () => {
  const tempDir = safeTempDir("backfill-fm-extract-")
  try {
    const draftFile = path.join(tempDir, "draft.md")
    fs.writeFileSync(
      draftFile,
      [
        "---",
        "title: Test Draft",
        "ingest_metadata:",
        "  source_path: docs/features/F999.md",
        "  ingest_event_id: evt-42",
        "tags:",
        "  - test",
        "---",
        "",
        "# body",
        "",
      ].join("\n"),
    )
    const sp = extractSourcePathFromFrontmatter(draftFile)
    assert.equal(sp, "docs/features/F999.md")
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · 范-r1 P2-1: extractSourcePathFromFrontmatter 缺 frontmatter / 缺字段 → null", () => {
  const tempDir = safeTempDir("backfill-fm-missing-")
  try {
    const noFm = path.join(tempDir, "no-fm.md")
    fs.writeFileSync(noFm, "# just body\n")
    assert.equal(extractSourcePathFromFrontmatter(noFm), null)

    const fmNoSource = path.join(tempDir, "fm-no-source.md")
    fs.writeFileSync(
      fmNoSource,
      "---\ntitle: x\nother: yes\n---\n# body\n",
    )
    assert.equal(extractSourcePathFromFrontmatter(fmNoSource), null)
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · 范-r1 P2-1: scanFrontmatterCommittedSources 扫 _backfill / _auto", async () => {
  const tempDir = safeTempDir("backfill-fm-scan-")
  try {
    const backfillDir = path.join(tempDir, "_backfill")
    const autoDir = path.join(tempDir, "_auto")
    fs.mkdirSync(backfillDir, { recursive: true })
    fs.mkdirSync(autoDir, { recursive: true })
    fs.writeFileSync(
      path.join(backfillDir, "f999-backfill.md"),
      "---\ningest_metadata:\n  source_path: docs/features/F999.md\n---\n# x\n",
    )
    fs.writeFileSync(
      path.join(autoDir, "f998-auto.md"),
      "---\ningest_metadata:\n  source_path: docs/features/F998.md\n---\n# x\n",
    )
    fs.writeFileSync(
      path.join(autoDir, "no-fm.md"),
      "# just body, no frontmatter\n",
    )
    const set = await scanFrontmatterCommittedSources([backfillDir, autoDir])
    assert.equal(set.size, 2)
    assert.ok(set.has("docs/features/F999.md"))
    assert.ok(set.has("docs/features/F998.md"))
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · 范-r1 P2-1: --resume 合并 state.jsonl + frontmatterCommittedSources", async () => {
  const tempDir = safeTempDir("backfill-fm-merge-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const stateFile = path.join(rootDir, ".runtime", "backfill-state.jsonl")
    const reportFile = path.join(rootDir, "docs", "plans", "report.md")

    // state 只 commit 了 F999；frontmatterCommittedSources 兜底 F998
    appendBackfillState(stateFile, {
      file: "docs/features/F999.md",
      status: "committed",
      ingestEventId: "evt-state-1",
      ts: "2026-05-14T00:00:00.000Z",
    })

    const ingested: string[] = []
    let counter = 0
    const ingestFn: IngestFn = async (_abs, source) => {
      counter += 1
      ingested.push(source)
      return { ingestEventId: `evt-${counter}`, type: "concept", crossRefs: 0 }
    }

    const result = await runBackfill({
      rootDir,
      docsSubdirs: ["docs/features", "docs/bugReport", "docs/lessons"],
      stateJsonlPath: stateFile,
      reportPath: reportFile,
      dryRun: false,
      resume: true,
      ingestFn,
      // ★ frontmatter fallback 模拟：F998 已有 draft frontmatter
      frontmatterCommittedSources: new Set(["docs/features/F998.md"]),
    })

    assert.equal(result.skipped, 2, "F999 (state) + F998 (frontmatter) 共跳 2")
    assert.equal(result.succeeded, 2, "B999 + L001 真跑")
    const sortedIngested = ingested.map((f) => f.replace(/\\/g, "/")).sort()
    assert.deepEqual(sortedIngested, ["docs/bugReport/B999.md", "docs/lessons/L001.md"])
  } finally {
    safeCleanup(tempDir)
  }
})

// ── 范-r2 P2-1: CLI wiring (runBackfillFromCli) ────────────────────────

test("backfill-docs · 范-r2 P2-1 CLI wiring: --resume 真调 frontmatter scan + 合并 skip", async () => {
  const tempDir = safeTempDir("backfill-cli-wiring-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    // 模拟 wiki/concepts/draft/_backfill 下有 F999 的 frontmatter marker
    const draftBackfillDir = path.join(
      rootDir,
      "wiki",
      "concepts",
      "draft",
      "_backfill",
    )
    fs.mkdirSync(draftBackfillDir, { recursive: true })
    fs.writeFileSync(
      path.join(draftBackfillDir, "f999-imported.md"),
      [
        "---",
        "title: F999 imported",
        "ingest_metadata:",
        "  source_path: docs/features/F999.md",
        "  ingest_event_id: evt-fm-1",
        "---",
        "# body",
      ].join("\n"),
    )
    // state.jsonl 完全为空（模拟 state 丢失场景）

    const ingested: string[] = []
    let counter = 0
    const ingestFn: IngestFn = async (_abs, source) => {
      counter += 1
      ingested.push(source)
      return { ingestEventId: `evt-${counter}`, type: "concept", crossRefs: 0 }
    }

    const result = await runBackfillFromCli(
      { rootDir, dryRun: false, resume: true },
      ingestFn,
    )

    assert.equal(
      result.frontmatterCommittedCount,
      1,
      "CLI 应真调 scan 找到 1 个 frontmatter committed source",
    )
    // F999 应被 frontmatter fallback skip；F998 + B999 + L001 真跑
    assert.equal(result.skipped, 1, "F999 frontmatter committed → skip")
    assert.equal(result.succeeded, 3)
    const sortedIngested = ingested.map((f) => f.replace(/\\/g, "/")).sort()
    assert.deepEqual(
      sortedIngested,
      ["docs/bugReport/B999.md", "docs/features/F998.md", "docs/lessons/L001.md"],
    )
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · 范-r2 P2-1 CLI wiring: --dry-run 不调 frontmatter scan", async () => {
  const tempDir = safeTempDir("backfill-cli-dryrun-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    // 即使 _backfill 下有 frontmatter markers，dry-run 也不调 scan
    const draftBackfillDir = path.join(rootDir, "wiki", "concepts", "draft", "_backfill")
    fs.mkdirSync(draftBackfillDir, { recursive: true })
    fs.writeFileSync(
      path.join(draftBackfillDir, "x.md"),
      "---\ningest_metadata:\n  source_path: docs/features/F999.md\n---\n# x\n",
    )
    const ingestFn: IngestFn = async () => ({ ingestEventId: "x", type: "x", crossRefs: 0 })
    const result = await runBackfillFromCli(
      { rootDir, dryRun: true, resume: true },
      ingestFn,
    )
    assert.equal(
      result.frontmatterCommittedCount,
      0,
      "dry-run 路径不应调 scan（frontmatterCommittedSources undefined）",
    )
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · 范-r2 P2-1 CLI wiring: 不传 --resume 不调 frontmatter scan", async () => {
  const tempDir = safeTempDir("backfill-cli-no-resume-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const ingestFn: IngestFn = async () => ({ ingestEventId: "x", type: "x", crossRefs: 0 })
    const result = await runBackfillFromCli(
      { rootDir, dryRun: false, resume: false },
      ingestFn,
    )
    assert.equal(result.frontmatterCommittedCount, 0)
    assert.equal(result.skipped, 0)
    assert.equal(result.succeeded, 4, "全部跑（无 resume / 无 frontmatter scan）")
  } finally {
    safeCleanup(tempDir)
  }
})

test("backfill-docs · AC-P2-9 ingest 抛错 → state 落 status='failed' + error", async () => {
  const tempDir = safeTempDir("backfill-fail-")
  try {
    const { rootDir } = setupDocsTree(tempDir)
    const stateFile = path.join(rootDir, ".runtime", "backfill-state.jsonl")
    const reportFile = path.join(rootDir, "docs", "plans", "report.md")
    let calls = 0
    const ingestFn: IngestFn = async (_abs, source) => {
      calls += 1
      if (source.includes("F998.md")) {
        throw new Error("LLM rate limit")
      }
      return { ingestEventId: `evt-${calls}`, type: "concept", crossRefs: 0 }
    }
    const result = await runBackfill({
      rootDir,
      docsSubdirs: ["docs/features", "docs/bugReport", "docs/lessons"],
      stateJsonlPath: stateFile,
      reportPath: reportFile,
      dryRun: false,
      resume: false,
      ingestFn,
    })
    assert.equal(result.failed, 1)
    assert.equal(result.succeeded, 3)
    assert.equal(result.failedFiles.length, 1)
    assert.match(result.failedFiles[0].file, /F998\.md/)
    assert.match(result.failedFiles[0].error, /rate limit/)
    const stateMap = readBackfillState(stateFile)
    const failedEntry = [...stateMap.values()].find((e) => e.status === "failed")
    assert.ok(failedEntry)
    assert.equal(failedEntry.ingestEventId, null)
    assert.match(failedEntry.error ?? "", /rate limit/)
  } finally {
    safeCleanup(tempDir)
  }
})
