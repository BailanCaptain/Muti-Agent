#!/usr/bin/env tsx
/**
 * F027 P19.7.5 · backfill-docs.ts (V16.5.3 D2)
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-8/9 + V16.5
 * chap 17 line 2640-2654
 *
 * 模式：
 *   --dry-run            扫描 + 输出报告，不调 ingest，不写 state；
 *                        报告落 docs/plans/V16.5-backfill-report-<YYYY-MM-DD>.md
 *   (默认)               真跑 ingest，append state.jsonl 进度，可被 SIGKILL 中断
 *   --resume             跳过 state.jsonl 里 status='committed' 的文件
 *                        （AC-P2-9 v2a F4：state 文件优先；缺失 fallback 扫
 *                        frontmatter ingest_metadata.ingest_event_id）
 *
 * Marker 双源（v2a F4 锁定）：
 *   1. .runtime/backfill-state.jsonl  — 进度文件（每行一 JSON entry）
 *   2. draft frontmatter `ingest_metadata.ingest_event_id`（实际写入由 ingest
 *      pipeline 的 post-compile.ts:83 负责，本脚本不直接写 frontmatter）
 *
 * **不新增 DB column / index / CHECK / schema**（AC-P2-9 v2a F4 强约束）。
 *
 * 实际 ingest 函数由 caller 通过 `--ingest-module <path>` 注入；测试用 stub。
 * 默认无 ingest module → 报错（避免误调真 LLM）。
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { parseArgs as parseNodeArgs } from "node:util"

export interface BackfillStateEntry {
  /** Source doc path (relative to repo root). */
  file: string
  /** committed | failed */
  status: "committed" | "failed"
  /** Returned by ingest fn (uuid / wiki_events.id 视实现而定); failed 时为 null。 */
  ingestEventId: string | null
  /** ISO timestamp. */
  ts: string
  /** Failed 时记错误消息。 */
  error?: string
}

export interface IngestResult {
  /** wiki_events 行 id 或其他 event id (caller 自行约定)。 */
  ingestEventId: string
  /** 推断类型 (concept / lesson / external-ref / 等)；用于 dry-run 报告类型分布。 */
  type: string
  /** Cross-refs 密度（[[wikilink]] / 相对 path 总数）。 */
  crossRefs: number
}

export type IngestFn = (filePath: string, source: string) => Promise<IngestResult>

export interface BackfillArgs {
  rootDir: string
  /** 要扫的 docs 子目录列表（绝对或相对 rootDir）；默认 features / bugReport / lessons。 */
  docsSubdirs: string[]
  stateJsonlPath: string
  reportPath: string
  dryRun: boolean
  resume: boolean
  /** 注入测试用 ingest fn；CLI 模式从 --ingest-module 加载。 */
  ingestFn: IngestFn
  /**
   * **范-r1 P2-1 修复**：v2a F4 frontmatter fallback。
   *
   * caller 预扫 wiki/concepts/draft/{_backfill,_auto}/* frontmatter，提取
   * `ingest_metadata.source_path` (post-compile.ts 写入的字段) 收集到 Set。
   * 本脚本 --resume 时合并 state.jsonl committed + 本 Set 一起 skip。
   *
   * 用途：state.jsonl 损坏 / 丢失 / 没同步 → 用 frontmatter 兜底，避免重跑
   * 已成功导入的源文件（post-compile 写入是 atomic + idempotent，frontmatter
   * 存在 = source 已入 wiki）。
   *
   * 默认 (undefined): 只用 state.jsonl，不做 frontmatter fallback (Day 7-8 行为)。
   */
  frontmatterCommittedSources?: Set<string>
}

export const DEFAULT_DOCS_SUBDIRS = ["docs/features", "docs/bugReport", "docs/lessons"]

// ── CLI parsing ──────────────────────────────────────────────────────────

export function parseBackfillArgs(argv: string[]): {
  dryRun: boolean
  resume: boolean
  rootDir: string
  ingestModule: string | null
} {
  const parsed = parseNodeArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      "root-dir": { type: "string" },
      "ingest-module": { type: "string" },
    },
    strict: true,
  })
  return {
    dryRun: !!parsed.values["dry-run"],
    resume: !!parsed.values.resume,
    rootDir: parsed.values["root-dir"] ?? process.cwd(),
    ingestModule: parsed.values["ingest-module"] ?? null,
  }
}

// ── Frontmatter fallback scan (v2a F4) ───────────────────────────────────

/**
 * 范-r1 P2-1: 扫描 wiki/concepts/draft/{_backfill,_auto}/ 下所有 .md 文件的
 * YAML frontmatter，提取 `ingest_metadata.source_path` 字段（post-compile.ts:83
 * 实际写入的源文件路径），返回已 committed 的源文件 Set。
 *
 * v2a F4 强约束："resume 时优先读 state 文件，缺失 fallback 扫 frontmatter"。
 *
 * 用法：caller 在 --resume 时调本函数预扫，传入 runBackfill.frontmatterCommittedSources。
 *
 * 鲁棒性：单文件 frontmatter 解析失败跳过不打断（可能 yaml 格式错 / IO 错）。
 */
export async function scanFrontmatterCommittedSources(
  draftDirs: string[],
  options: { sourcePathField?: string } = {},
): Promise<Set<string>> {
  const field = options.sourcePathField ?? "source_path"
  const committed = new Set<string>()
  for (const dir of draftDirs) {
    if (!existsSync(dir)) continue
    const files: string[] = []
    await collectMarkdownFiles(dir, files)
    for (const file of files) {
      try {
        const sourcePath = extractSourcePathFromFrontmatter(file, field)
        if (sourcePath) committed.add(sourcePath)
      } catch {
        // 单文件解析失败跳过（YAML 错 / IO 错）
      }
    }
  }
  return committed
}

async function collectMarkdownFiles(dir: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await collectMarkdownFiles(full, out)
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full)
    }
  }
}

/**
 * 提取 frontmatter 中的 ingest_metadata.<field>。
 * 默认 field='source_path'（post-compile.ts:83 写入约定）。
 *
 * 简化解析（不引 yaml lib，避免 hot path 开销）：
 *   只处理 `--- ... ---` 包裹的 YAML 头；扫 `ingest_metadata:\n  source_path: <value>`
 *   形式。复杂 YAML 路径 (锚点 / multiline) 不支持 — 正常 frontmatter 写入不该用。
 */
export function extractSourcePathFromFrontmatter(
  filePath: string,
  field = "source_path",
): string | null {
  const content = readFileSync(filePath, "utf-8")
  // 仅匹配文件开头 `---\n...---\n` frontmatter 块
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const fm = m[1]
  // 找 ingest_metadata: ... 块下的 source_path
  const lines = fm.split(/\r?\n/)
  let inIngestMeta = false
  for (const line of lines) {
    if (/^ingest_metadata:\s*$/.test(line)) {
      inIngestMeta = true
      continue
    }
    // 离开 ingest_metadata 块的判定：缩进 0 的新顶层 key
    if (inIngestMeta && /^[A-Za-z0-9_-]+:/.test(line)) {
      inIngestMeta = false
    }
    if (inIngestMeta) {
      const fieldRe = new RegExp(`^\\s+${field}:\\s*['"]?([^'"\\n]+?)['"]?\\s*$`)
      const fm2 = line.match(fieldRe)
      if (fm2) return fm2[1].trim()
    }
  }
  return null
}

// ── State file (.runtime/backfill-state.jsonl) ───────────────────────────

export function readBackfillState(stateJsonlPath: string): Map<string, BackfillStateEntry> {
  const map = new Map<string, BackfillStateEntry>()
  if (!existsSync(stateJsonlPath)) return map
  const raw = readFileSync(stateJsonlPath, "utf-8")
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as BackfillStateEntry
      // 后写覆盖前写（重试场景）
      map.set(entry.file, entry)
    } catch {
      // 单行损坏跳过，不打断（防 kill -9 中途写入半行）
    }
  }
  return map
}

export function appendBackfillState(stateJsonlPath: string, entry: BackfillStateEntry): void {
  mkdirSync(path.dirname(stateJsonlPath), { recursive: true })
  appendFileSync(stateJsonlPath, `${JSON.stringify(entry)}\n`, "utf-8")
}

// ── File enumeration ─────────────────────────────────────────────────────

export async function enumerateDocsFiles(
  rootDir: string,
  subdirs: string[],
): Promise<string[]> {
  const result: string[] = []
  for (const subdir of subdirs) {
    const abs = path.isAbsolute(subdir) ? subdir : path.join(rootDir, subdir)
    if (!existsSync(abs)) continue
    await walk(abs, result)
  }
  return result.sort()
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 目录不可读跳过
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue // .git / .DS_Store 等
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      await walk(full, out)
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(full)
    }
  }
}

// ── Dry-run report ───────────────────────────────────────────────────────

export interface DryRunFileStats {
  file: string
  /** 路径推断的"类型"桶（e.g. features / bugReport / lessons / unknown）。 */
  bucket: string
  /** [[wikilink]] + (../path.md) ref 计数。 */
  crossRefs: number
  /** Bytes。 */
  size: number
  /** Read error。 */
  failed: boolean
  /** Error message if failed。 */
  error?: string
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g
const RELLINK_RE = /\(\.\.?\/[^)]+\.md\)/g

export function analyzeDocFile(absPath: string, rootDir: string): DryRunFileStats {
  // 路径统一 POSIX 风格（防 Windows backslash 与 state.jsonl forward-slash key mismatch）
  const rel = path.relative(rootDir, absPath).replace(/\\/g, "/")
  const segs = rel.split("/")
  // segs[0]=docs, segs[1]=features|bugReport|lessons|...
  const bucket = segs[1] ?? "unknown"
  let crossRefs = 0
  let size = 0
  let failed = false
  let error: string | undefined
  try {
    const stat = statSync(absPath)
    size = stat.size
    const content = readFileSync(absPath, "utf-8")
    const wikilinks = (content.match(WIKILINK_RE) ?? []).length
    const rellinks = (content.match(RELLINK_RE) ?? []).length
    crossRefs = wikilinks + rellinks
  } catch (err) {
    failed = true
    error = (err as Error).message
  }
  return { file: rel, bucket, crossRefs, size, failed, error }
}

export interface DryRunReport {
  generatedAt: string
  totalFiles: number
  alreadyCommitted: number
  toProcess: number
  byBucket: Record<string, number>
  topCrossRefs: DryRunFileStats[]
  failedFiles: DryRunFileStats[]
}

export function buildDryRunReport(
  allStats: DryRunFileStats[],
  alreadyCommittedFiles: Set<string>,
  topN = 10,
): DryRunReport {
  const byBucket: Record<string, number> = {}
  for (const s of allStats) {
    byBucket[s.bucket] = (byBucket[s.bucket] ?? 0) + 1
  }
  const toProcess = allStats.filter((s) => !alreadyCommittedFiles.has(s.file)).length
  const topCrossRefs = [...allStats]
    .filter((s) => !s.failed)
    .sort((a, b) => b.crossRefs - a.crossRefs)
    .slice(0, topN)
  const failedFiles = allStats.filter((s) => s.failed)
  return {
    generatedAt: new Date().toISOString(),
    totalFiles: allStats.length,
    alreadyCommitted: alreadyCommittedFiles.size,
    toProcess,
    byBucket,
    topCrossRefs,
    failedFiles,
  }
}

export function renderDryRunReport(report: DryRunReport): string {
  const lines: string[] = []
  lines.push("# F027 P19.7.5 · Backfill Dry-Run Report")
  lines.push("")
  lines.push(`Generated: ${report.generatedAt}`)
  lines.push("")
  lines.push("## Summary")
  lines.push(`- Total files scanned: ${report.totalFiles}`)
  lines.push(`- Already committed (skip): ${report.alreadyCommitted}`)
  lines.push(`- To process: ${report.toProcess}`)
  lines.push(`- Failed read: ${report.failedFiles.length}`)
  lines.push("")
  lines.push("## Type Distribution (by docs subdir)")
  for (const [bucket, count] of Object.entries(report.byBucket).sort()) {
    lines.push(`- ${bucket}: ${count}`)
  }
  lines.push("")
  lines.push(`## Top ${report.topCrossRefs.length} Cross-Refs Density`)
  if (report.topCrossRefs.length === 0) {
    lines.push("- (none)")
  } else {
    for (const s of report.topCrossRefs) {
      lines.push(`- ${s.file} (${s.crossRefs} refs, ${s.size} bytes)`)
    }
  }
  lines.push("")
  lines.push("## Failed Files")
  if (report.failedFiles.length === 0) {
    lines.push("- (none)")
  } else {
    for (const s of report.failedFiles) {
      lines.push(`- ${s.file}: ${s.error ?? "(unknown)"}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

// ── Backfill main loop ───────────────────────────────────────────────────

export interface BackfillRunResult {
  dryRun: boolean
  resume: boolean
  totalFiles: number
  skipped: number
  succeeded: number
  failed: number
  reportPath?: string
  failedFiles: { file: string; error: string }[]
}

export async function runBackfill(args: BackfillArgs): Promise<BackfillRunResult> {
  const allFiles = await enumerateDocsFiles(args.rootDir, args.docsSubdirs)
  const allStats = allFiles.map((f) => analyzeDocFile(f, args.rootDir))

  const stateMap = readBackfillState(args.stateJsonlPath)
  const committedFiles = new Set<string>()
  for (const [file, entry] of stateMap) {
    if (entry.status === "committed") committedFiles.add(file)
  }
  // 范-r1 P2-1: 合并 frontmatter fallback set（v2a F4 双源 marker）
  if (args.frontmatterCommittedSources) {
    for (const f of args.frontmatterCommittedSources) committedFiles.add(f)
  }

  if (args.dryRun) {
    const report = buildDryRunReport(allStats, committedFiles)
    const md = renderDryRunReport(report)
    mkdirSync(path.dirname(args.reportPath), { recursive: true })
    writeFileSync(args.reportPath, md, "utf-8")
    return {
      dryRun: true,
      resume: args.resume,
      totalFiles: allStats.length,
      skipped: committedFiles.size,
      succeeded: 0,
      failed: report.failedFiles.length,
      reportPath: args.reportPath,
      failedFiles: report.failedFiles.map((s) => ({ file: s.file, error: s.error ?? "" })),
    }
  }

  // 真跑
  let succeeded = 0
  let failed = 0
  let skipped = 0
  const failedFiles: { file: string; error: string }[] = []

  for (const stat of allStats) {
    if (args.resume && committedFiles.has(stat.file)) {
      skipped += 1
      continue
    }
    const absPath = path.isAbsolute(stat.file) ? stat.file : path.join(args.rootDir, stat.file)
    try {
      const result = await args.ingestFn(absPath, stat.file)
      const entry: BackfillStateEntry = {
        file: stat.file,
        status: "committed",
        ingestEventId: result.ingestEventId,
        ts: new Date().toISOString(),
      }
      appendBackfillState(args.stateJsonlPath, entry)
      succeeded += 1
    } catch (err) {
      const error = (err as Error).message
      const entry: BackfillStateEntry = {
        file: stat.file,
        status: "failed",
        ingestEventId: null,
        ts: new Date().toISOString(),
        error,
      }
      appendBackfillState(args.stateJsonlPath, entry)
      failed += 1
      failedFiles.push({ file: stat.file, error })
    }
  }

  return {
    dryRun: false,
    resume: args.resume,
    totalFiles: allStats.length,
    skipped,
    succeeded,
    failed,
    failedFiles,
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────

async function main() {
  const cli = parseBackfillArgs(process.argv.slice(2))
  let ingestFn: IngestFn
  if (cli.ingestModule) {
    const mod = await import(cli.ingestModule)
    if (typeof mod.ingest !== "function") {
      throw new Error(`--ingest-module ${cli.ingestModule} must export 'ingest' function`)
    }
    ingestFn = mod.ingest as IngestFn
  } else {
    if (!cli.dryRun) {
      throw new Error(
        "real run requires --ingest-module <path>; pass --dry-run to scan without ingest",
      )
    }
    // dry-run 不调 ingest，stub 即可
    ingestFn = async () => ({ ingestEventId: "dry-run", type: "unknown", crossRefs: 0 })
  }

  const today = new Date().toISOString().slice(0, 10)
  const result = await runBackfill({
    rootDir: cli.rootDir,
    docsSubdirs: DEFAULT_DOCS_SUBDIRS,
    stateJsonlPath: path.join(cli.rootDir, ".runtime", "backfill-state.jsonl"),
    reportPath: path.join(cli.rootDir, "docs", "plans", `V16.5-backfill-report-${today}.md`),
    dryRun: cli.dryRun,
    resume: cli.resume,
    ingestFn,
  })

  console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
