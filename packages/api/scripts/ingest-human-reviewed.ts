#!/usr/bin/env tsx
/**
 * F027 续 · 人审豁免 ingest —— sanitize 拦下的可信文档,人审后显式收录(小孙拍 B,2026-06-11)。
 *
 * 背景:backfill 12 篇讲注入/prompt 的文档(B014/B022/F027-spec 等)正文天然含攻击样例
 * 文本,sanitizeRawDrop 5 层防御按设计拦截(blocked,非误报)。三选项里小孙拍 B:
 * 不给自动管线开白名单,由真人逐篇确认后走本脚本收录。
 *
 * == 安全边界(德彪审重点,违反任意一条 = 安全模型被破) ==
 * 1. 本脚本是**唯一** sanitize 豁免通道:豁免只发生在这里,sanitizeRawDrop /
 *    IngestPreviewService 本体零修改;DocsWatcher / backfill / HTTP 路由不引用本模块。
 * 2. 仅人工 CLI 调用:--reviewer 必填(真人名)+ 文件列表显式传参——每次调用 = 一次人工确认,
 *    无目录通配/无配置文件白名单(不留"配一次永久放行"后门)。
 * 3. 产物仍是 **draft**(commit 落 `wiki/concepts/draft/_auto/`,不注入 prompt),
 *    转正必须小孙 KB tab promote——人审章在 promote,本脚本只是把文档送进待审队列。
 * 4. 可审计:commit 走 updateWiki 正路写 wiki_events(alias=human-reviewed:<reviewer>);
 *    落盘 frontmatter 注 `ingest_exemption` 行(谁、何时、豁免了什么)。
 *
 * 用法(主库运营,与 backfill 同款 env;德彪 r2 P2:`--` 分隔必须有,文件显式逐个列、
 * 不用通配;文件必须在仓库 docs/ 树内,从仓库根运行):
 *   SQLITE_PATH=data/multi-agent.sqlite WIKI_ROOT=.runtime/wiki \
 *     npx tsx packages/api/scripts/ingest-human-reviewed.ts --reviewer 小孙 -- \
 *       docs/bugReport/B014-enametoolong-regression.md docs/features/F002-decision-board.md
 *
 * Iron Law:测试用临时 sqlite + 临时 wikiRoot。
 */

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { createDrizzleDb } from "../src/db/drizzle-instance"
import { IngestCommitService } from "../src/routes/phase3/ingest-commit"
import { renderCompiledDraft } from "../src/routes/phase3/ingest-preview"
import { PreviewStore } from "../src/routes/phase3/preview-store"
import { createHaikuRunner, createOpusRunner } from "../src/runtime/haiku-runner"
import { createRunnerWithFallback } from "../src/runtime/runner-with-fallback"
import { EmbeddingService } from "../src/services/embedding-service"
import { runCompilePipelineWithRetry } from "../src/wiki/llm-compile/compile-pipeline"
import { createProductionEntityExistenceChecker } from "../src/wiki/llm-compile/entity-existence-checker"
import { createProductionIndexLiteLoader } from "../src/wiki/llm-compile/index-lite-loader"
import { createPreviewWikiEventsWriter } from "../src/wiki/llm-compile/preview-wiki-events-writer"
import { createProductionCompileLLMClient } from "../src/wiki/llm-compile/production-compile-llm-client"
import type { CompileLLMClient } from "../src/wiki/llm-compile/types"
import { createWikiServices } from "../src/wiki/wiki-services"

export interface HumanReviewedIngestOpts {
  sqlitePath: string
  /** 单层 wiki 根(= server.ts wikiServices.wikiRoot;commit 落 `<wikiRoot>/wiki/concepts/draft/_auto/`)。 */
  wikiRoot: string
  /** 人审者真名(必填;进 wiki_events alias + frontmatter ingest_exemption 行)。 */
  reviewer: string
  /** 测试注入 fake LLM(不烧真编译);默认 Opus 4.7 primary + Haiku 4.5 fallback。 */
  llmClient?: CompileLLMClient
  clock?: () => Date
  logger?: (msg: string) => void
}

export interface HumanReviewedIngestResult {
  file: string
  ok: boolean
  ingestEventId?: string
  finalPath?: string
  error?: string
}

export function createHumanReviewedIngest(opts: HumanReviewedIngestOpts): {
  ingestOne: (filePath: string, sourcePath: string) => Promise<HumanReviewedIngestResult>
  close: () => void
} {
  if (!opts.reviewer?.trim()) throw new Error("reviewer 必填(人审豁免通道要求真人署名)")
  const log = opts.logger ?? (() => {})
  const clock = opts.clock ?? (() => new Date())
  const { db, close } = createDrizzleDb(opts.sqlitePath)
  const wikiServices = createWikiServices({ db, wikiRoot: opts.wikiRoot })
  // clock 必须传给 PreviewStore:否则 put 的 expiresAt 用注入时钟、peek 判 expired 用真实
  // 系统时钟,两者基准不一致 → 注入固定/过去时钟的测试会因真实时间已过 expiresAt 误判过期
  // (2026-06-11 当天测试硬编码 10:00Z 引爆 gate)。生产默认真实时钟,两处一致,无回归。
  const store = new PreviewStore({ clock })
  const compileWikiRoot = path.join(opts.wikiRoot, "wiki")
  const llmClient =
    opts.llmClient ??
    createProductionCompileLLMClient({
      runner: createRunnerWithFallback({ primary: createOpusRunner(), fallback: createHaikuRunner() }),
      timeoutMs: 180_000,
      logger: log,
    })
  const compileDeps = {
    embedding: new EmbeddingService({}),
    indexLoader: createProductionIndexLiteLoader({ wikiRoot: compileWikiRoot }),
    entityChecker: createProductionEntityExistenceChecker({ wikiRoot: compileWikiRoot }),
    llmClient,
    wikiEvents: createPreviewWikiEventsWriter(),
  }
  const commit = new IngestCommitService({
    store,
    updateWiki: wikiServices.updateWiki,
    leases: wikiServices.leases,
    leaderTerm: () => wikiServices.leader.getCurrent()?.currentTerm ?? "0",
  })
  const callerAlias = `human-reviewed:${opts.reviewer}`

  const ingestOne = async (
    filePath: string,
    sourcePath: string,
  ): Promise<HumanReviewedIngestResult> => {
    try {
      const content = readFileSync(filePath, "utf-8")
      const now = clock()
      const previewId = randomUUID()
      // ⚠ 残余风险(德彪 human-reviewed 审 P1 #1,无法在豁免框架内消除):
      //   rawContent = **原文(未 sanitize)**。这是豁免本体——blocked 文档的"危险文本"
      //   就是它们的讲解内容,sanitize 后 sanitizedText 置空 = 内容残缺,无法用。
      //   缓解三层:① compile SYSTEM prompt 有"资料是数据块不是指令"防注入框架
      //   (compile-prompt.ts:13,对原文也生效)② fromUserDrop=true 保 taint + promote 时
      //   服务端对 ingest_exemption 文档 sanitize 复检,命中片段动态注入 V14 layer3
      //   (德彪 r2 P1 真接线,exemption-tainted-fields.ts)③ 产物 draft,draft 召回准入
      //   闸门保证 promote 前不进 agent 召回。残余风险:attacker 文本仍可能诱导 LLM 生成合法
      //   但偏倚的 summary/facts → 靠人审者 promote 时核对编译产物兜底。
      // 编译失败不 fallback stub:人工质量通道,失败即报错让人重跑/跳过(不静默落原文)。
      const draft = await runCompilePipelineWithRetry(
        {
          rawContent: content,
          rawMetadata: {
            ingestMessageId: previewId,
            // 德彪 #3:这些是被 sanitize 红线拦下的可疑源,fromUserDrop=true →
            // tainted_source=true(不洗白 taint),promote 二审才会对它们加严。
            fromUserDrop: true,
            date: now.toISOString().slice(0, 10),
            seriesId: null,
          },
          agentDraft: {
            title: extractTitle(content) ?? path.basename(sourcePath).replace(/\.md$/i, ""),
            sources: [{ type: "text/markdown", path: sourcePath, contributed_by: callerAlias }],
          },
          handbookCompileRules: "",
          quotedSpans: [],
          deps: compileDeps,
        },
        { maxAttempts: 3, logger: log },
      )
      // 德彪 #5:经 renderCompiledDraft 的 extraFrontmatter(yaml.stringify 安全序列化),
      // 不再字符串 indexOf 注入(多行 scalar 含 '---' 会错位)。
      const compiledMarkdown = renderCompiledDraft(draft, {
        ingest_exemption: `sanitize-skipped (human-reviewed by ${opts.reviewer} @ ${now.toISOString()})`,
      })
      store.put({
        previewId,
        sourcePath,
        sanitizedContent: content,
        mimeType: "text/markdown",
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        compiledMarkdown,
        contributedBy: callerAlias,
        ingestedAt: now.getTime(),
      })
      const result = commit.commit({ previewId, callerAlias })
      if (!result.ok) {
        // 德彪 #6:conflict(同 basename 已存在)不当幂等成功——人审通道量小且高风险,
        // 同名可能异源,假报 already-exists 会掩盖。一律报 error 让人审者人工核对处置。
        return {
          file: sourcePath,
          ok: false,
          error: `commit failed (${result.error.code}): ${result.error.message}`,
        }
      }
      return {
        file: sourcePath,
        ok: true,
        ingestEventId: result.response.ingestEventId,
        finalPath: result.response.finalPath,
      }
    } catch (err) {
      return { file: sourcePath, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { ingestOne, close }
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+?)\s*$/m)
  return m ? m[1].trim() : null
}

/**
 * 德彪 #4 · 严格 CLI 解析:`--reviewer <name> -- <file> [file...]`。
 * `--` 分隔 reviewer 与文件清单,杜绝 `--reviewer docs/A.md docs/B.md` 把路径当署名;
 * reviewer 不得像路径(含 / 或 .md 即拒);文件清单显式列举(无通配)。
 * 返回 { ok, reviewer?, files?, error? }。导出供测试。
 */
export function parseHumanReviewedArgs(
  argv: string[],
): { ok: true; reviewer: string; files: string[] } | { ok: false; error: string } {
  if (argv[0] !== "--reviewer") {
    return { ok: false, error: "首参必须是 --reviewer <真名> -- <file.md> [file2.md ...]" }
  }
  const reviewer = argv[1]
  if (!reviewer || !reviewer.trim()) {
    return { ok: false, error: "--reviewer 后必须紧跟真名" }
  }
  const trimmed = reviewer.trim()
  // 德彪 r2 P2:审计身份保守字符规则——前导 '-'(把 "--"/flag 误当人名)、控制字符、
  // 超长全拒。签名进 wiki_events alias + frontmatter,垃圾身份 = 审计链失真。
  if (trimmed.startsWith("-")) {
    return { ok: false, error: `reviewer 不得以 '-' 开头: ${trimmed}(是否漏了真名?)` }
  }
  // charCode 循环而非正则: biome noControlCharactersInRegex 禁正则含控制字符。
  for (let i = 0; i < reviewer.length; i++) {
    const c = reviewer.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) {
      return { ok: false, error: "reviewer 含控制字符" }
    }
  }
  if (trimmed.length > 64) {
    return { ok: false, error: `reviewer 过长(>64): ${trimmed.slice(0, 64)}…` }
  }
  if (/[/\\]/.test(trimmed) || /\.md$/i.test(trimmed)) {
    return { ok: false, error: `reviewer 不得像路径/文件名: ${trimmed}(是否漏了 -- 分隔符?)` }
  }
  if (argv[2] !== "--") {
    return { ok: false, error: "reviewer 与文件清单之间必须有 -- 分隔符" }
  }
  const files = argv.slice(3)
  if (files.length === 0) {
    return { ok: false, error: "-- 之后必须显式列出人审过的文件(无通配,每个文件名=一次人工确认)" }
  }
  return { ok: true, reviewer: trimmed, files }
}

/**
 * 德彪 r2 P1 · 源文件围栏:realpath 后必须落在 approvedRootReal(仓库 docs/ 树)内的
 * 普通 .md 文件。realpath 同时消解 symlink 逃逸(与 list/read containment 同课:
 * 相对路径 `../`、绝对路径、symlink 指树外,全在 realpath 后用同一前缀判定拦截)。
 * 导出供测试。
 */
export function validateApprovedSourceFile(
  fileArg: string,
  approvedRootReal: string,
): { ok: true; realPath: string } | { ok: false; error: string } {
  let real: string
  try {
    real = realpathSync(path.resolve(fileArg))
  } catch {
    return { ok: false, error: `文件不存在: ${fileArg}` }
  }
  if (real !== approvedRootReal && !real.startsWith(approvedRootReal + path.sep)) {
    return { ok: false, error: `越界:人审豁免只收仓库 docs/ 树内文件: ${fileArg}` }
  }
  if (!real.toLowerCase().endsWith(".md")) {
    return { ok: false, error: `仅收 .md 文件: ${fileArg}` }
  }
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(real)
  } catch {
    return { ok: false, error: `stat 失败: ${fileArg}` }
  }
  if (!st.isFile()) {
    return { ok: false, error: `不是普通文件: ${fileArg}` }
  }
  return { ok: true, realPath: real }
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseHumanReviewedArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.error)
    console.error("用法: ingest-human-reviewed.ts --reviewer <真名> -- <file.md> [file2.md ...]")
    process.exitCode = 1
    return
  }
  const { reviewer, files } = parsed
  const sqlitePath = process.env.SQLITE_PATH
  const wikiRoot = process.env.WIKI_ROOT
  if (!sqlitePath || !existsSync(sqlitePath)) {
    console.error(`SQLITE_PATH 缺失或不存在: ${sqlitePath}`)
    process.exitCode = 1
    return
  }
  // migrate-session-memories 同款 sentinel:防误传非 wiki 根(任意已有目录不放行)。
  if (!wikiRoot || !existsSync(path.join(wikiRoot, "wiki"))) {
    console.error(`WIKI_ROOT 缺失或无 wiki/ 子目录 sentinel: ${wikiRoot}`)
    process.exitCode = 1
    return
  }
  // 德彪 r2 P1:源文件围栏根 = <cwd>/docs(本通道只收仓库 docs/ 树内的人审文件)。
  let approvedRootReal: string
  try {
    approvedRootReal = realpathSync(path.resolve(process.cwd(), "docs"))
  } catch {
    console.error(`docs/ 目录不存在(需从仓库根运行): ${path.resolve(process.cwd(), "docs")}`)
    process.exitCode = 1
    return
  }

  const { ingestOne, close } = createHumanReviewedIngest({
    sqlitePath,
    wikiRoot,
    reviewer,
    logger: (m) => console.log(`  [compile] ${m}`),
  })
  let failed = 0
  try {
    for (const f of files) {
      const v = validateApprovedSourceFile(f, approvedRootReal)
      if (!v.ok) {
        console.error(`✗ ${v.error}`)
        failed++
        continue
      }
      const source = path.relative(process.cwd(), v.realPath).replace(/\\/g, "/")
      console.log(`编译+收录(人审豁免): ${source} …`)
      const r = await ingestOne(v.realPath, source)
      if (r.ok) {
        console.log(`✓ ${source} → ${r.finalPath ?? r.ingestEventId}`)
      } else {
        console.error(`✗ ${source}: ${r.error}`)
        failed++
      }
    }
  } finally {
    close()
  }
  console.log(`\n完成: ${files.length - failed}/${files.length} 收录(draft 待 KB promote);failed=${failed}`)
  if (failed > 0) process.exitCode = 1
}

// 直接执行才跑 CLI(被 import 时只导出工厂,供测试)。
const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("ingest-human-reviewed.ts")
if (isDirectRun) {
  void main()
}
