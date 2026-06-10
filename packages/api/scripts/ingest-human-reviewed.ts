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
 * 用法(主库运营,与 backfill 同款 env):
 *   SQLITE_PATH=data/multi-agent.sqlite WIKI_ROOT=.runtime/wiki \
 *     npx tsx scripts/ingest-human-reviewed.ts --reviewer 小孙 docs/bugReport/B014-*.md ...
 *
 * Iron Law:测试用临时 sqlite + 临时 wikiRoot。
 */

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
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
  const store = new PreviewStore()
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
      // 真 LLM 编译(与 preview.runCompile 同参,差异仅:rawContent=原文未 sanitize——
      // 这就是豁免本体;quotedSpans 空因为没有 sanitize 隔离段)。
      // 编译失败不 fallback stub:人工质量通道,失败即报错让人重跑/跳过(不静默落原文)。
      const draft = await runCompilePipelineWithRetry(
        {
          rawContent: content,
          rawMetadata: {
            ingestMessageId: previewId,
            // 项目内 docs/ 源(同 docs-watcher 待遇);豁免事实由 ingest_exemption 行显式承载。
            fromUserDrop: false,
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
      const compiledMarkdown = injectExemptionLine(
        renderCompiledDraft(draft),
        opts.reviewer,
        now.toISOString(),
      )
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
        // ingest-module 同款幂等:同名已存在 = 已导入,不当 failed。
        if (result.error.detail?.reason === "conflict") {
          return { file: sourcePath, ok: true, ingestEventId: "already-exists" }
        }
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

/** frontmatter 末尾(闭合 --- 前)注豁免审计行:谁、何时、豁免了什么。 */
export function injectExemptionLine(markdown: string, reviewer: string, isoDate: string): string {
  const line = `ingest_exemption: sanitize-skipped (human-reviewed by ${reviewer} @ ${isoDate})`
  // renderCompiledDraft 产物固定 `---\n<yaml>---\n<body>`;第二个 --- 是闭合栏。
  const close = markdown.indexOf("---", 4)
  if (markdown.startsWith("---\n") && close > 0) {
    return `${markdown.slice(0, close)}${line}\n${markdown.slice(close)}`
  }
  // 防御:无 frontmatter(不应发生)→ 顶部补一个最小 frontmatter
  return `---\n${line}\n---\n${markdown}`
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const rIdx = args.indexOf("--reviewer")
  if (rIdx < 0 || !args[rIdx + 1]) {
    console.error("用法: ingest-human-reviewed.ts --reviewer <真名> <file.md> [file2.md ...]")
    process.exitCode = 1
    return
  }
  const reviewer = args[rIdx + 1]
  const files = args.filter((_, i) => i !== rIdx && i !== rIdx + 1)
  if (files.length === 0) {
    console.error("必须显式列出人审过的文件(无目录通配——每个文件名都是一次人工确认)")
    process.exitCode = 1
    return
  }
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

  const { ingestOne, close } = createHumanReviewedIngest({
    sqlitePath,
    wikiRoot,
    reviewer,
    logger: (m) => console.log(`  [compile] ${m}`),
  })
  let failed = 0
  try {
    for (const f of files) {
      const abs = path.resolve(f)
      if (!existsSync(abs)) {
        console.error(`✗ 文件不存在: ${f}`)
        failed++
        continue
      }
      const source = path.relative(process.cwd(), abs).replace(/\\/g, "/")
      console.log(`编译+收录(人审豁免): ${source} …`)
      const r = await ingestOne(abs, source)
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
