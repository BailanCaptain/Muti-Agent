#!/usr/bin/env tsx
/**
 * F027 B3 · 完整 ingest-module —— preview(LLM 编译) → commit(faithful 持久化到 wiki)。
 *
 * backfill-docs.ts `--ingest-module <此文件>` 加载本模块导出的 `ingest`，对每篇 doc 跑
 * preview（编译产 compiledMarkdown）→ commit（IngestCommitService 经 updateWiki 走完整
 * ACL/CAS/lease/atomic-write/wiki_events 落 `<wikiRoot>/wiki/concepts/draft/_auto/<name>.md`）。
 *
 * **为何用 IngestCommitService 而非直写**：commit 走 updateWiki prod 路径 = 正确 root
 * （绕开 B2 实测的 double-wiki-root 陷阱：writer 根 ≠ reader 根会让 KB tab 恒空）+ 写
 * wiki_events 审计行 + frontmatter（compiledMarkdown 已带）。
 *
 * 构造（与 server.ts:109/274/820-852 同款）：
 *   createDrizzleDb(sqlitePath) → db
 *   createWikiServices({db, wikiRoot}) → {updateWiki, leases, leader}
 *   IngestPreviewService（compile 链同 ingest-sample.ts）+ PreviewStore
 *   IngestCommitService({store, updateWiki, leases, leaderTerm})
 *
 * **Iron Law**：测试/试跑用**临时 sqlite + 临时 wikiRoot**，别碰 live preview DB。
 * 全量 55 篇真跑 = 合 dev 后主库运营步（数据写 .runtime/wiki/ 不进 git）。
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { createDrizzleDb } from "../src/db/drizzle-instance"
import { IngestCommitService } from "../src/routes/phase3/ingest-commit"
import { IngestPreviewService } from "../src/routes/phase3/ingest-preview"
import { PreviewStore } from "../src/routes/phase3/preview-store"
import { createHaikuRunner, createOpusRunner } from "../src/runtime/haiku-runner"
import { createRunnerWithFallback } from "../src/runtime/runner-with-fallback"
import { EmbeddingService } from "../src/services/embedding-service"
import { createProductionCompileLLMClient } from "../src/wiki/llm-compile/production-compile-llm-client"
import { createProductionEntityExistenceChecker } from "../src/wiki/llm-compile/entity-existence-checker"
import { createProductionIndexLiteLoader } from "../src/wiki/llm-compile/index-lite-loader"
import type { CompileLLMClient } from "../src/wiki/llm-compile/types"
import { createWikiServices } from "../src/wiki/wiki-services"
import type { IngestFn } from "./backfill-docs"

export interface IngestModuleOpts {
  /** sqlite 路径（含 wiki_events / wiki_leases / compiler_leader 表；createDrizzleDb 建表）。 */
  sqlitePath: string
  /** 单层 wiki 根（= server.ts wikiServices.wikiRoot；commit 落 `<wikiRoot>/wiki/concepts/draft/_auto/`）。 */
  wikiRoot: string
  /** 测试可注入 fake CompileLLMClient（不烧真 LLM）；默认 Opus 4.7 primary + Haiku 4.5 fallback。 */
  llmClient?: CompileLLMClient
  /** handbook 编译规则（默认空串；生产可从 loadHandbookSlices 注入）。 */
  handbookCompileRules?: string
  callerAlias?: string
  logger?: (msg: string) => void
}

/** 构造一个 ingest 模块实例（DI 友好；测试注入 fake llmClient + 临时 DB/wikiRoot）。 */
export function createIngestModule(opts: IngestModuleOpts): { ingest: IngestFn; close: () => void } {
  const log = opts.logger ?? (() => {})
  const { db, close } = createDrizzleDb(opts.sqlitePath)
  const wikiServices = createWikiServices({ db, wikiRoot: opts.wikiRoot })
  const store = new PreviewStore()
  // 双层根（RAG/entity 扫描根，同 server.ts ingestCompileWikiRoot = <wikiRoot>/wiki）
  const compileWikiRoot = path.join(opts.wikiRoot, "wiki")
  const llmClient =
    opts.llmClient ??
    createProductionCompileLLMClient({
      runner: createRunnerWithFallback({ primary: createOpusRunner(), fallback: createHaikuRunner() }),
      // batch backfill 放宽编译超时（同 ingest-sample；大文档 60s 不够）
      timeoutMs: 180_000,
      logger: log,
    })
  const preview = new IngestPreviewService({
    store,
    compile: {
      embedding: new EmbeddingService({}),
      indexLoader: createProductionIndexLiteLoader({ wikiRoot: compileWikiRoot }),
      entityChecker: createProductionEntityExistenceChecker({ wikiRoot: compileWikiRoot }),
      llmClient,
      handbookCompileRules: opts.handbookCompileRules ?? "",
      logger: log,
    },
  })
  const commit = new IngestCommitService({
    store,
    updateWiki: wikiServices.updateWiki,
    leases: wikiServices.leases,
    leaderTerm: () => wikiServices.leader.getCurrent()?.currentTerm ?? "0",
  })
  const callerAlias = opts.callerAlias ?? "backfill"

  const ingest: IngestFn = async (filePath, source) => {
    const content = readFileSync(filePath, "utf-8")
    const previewRes = await preview.preview(
      { sourcePath: source, content, mimeType: "text/markdown" },
      { provenance: "docs-watcher" },
    )
    const result = commit.commit({ previewId: previewRes.previewId, callerAlias })
    if (!result.ok) {
      throw new Error(`ingest commit failed (${result.error.code}): ${result.error.message}`)
    }
    const crossRefs = (content.match(/\[\[[^\]]+\]\]/g) ?? []).length
    return { ingestEventId: result.response.ingestEventId, type: "concept", crossRefs }
  }
  return { ingest, close }
}

// ── backfill `--ingest-module` 默认入口（env: SQLITE_PATH + WIKI_ROOT；lazy singleton）──
let singleton: { ingest: IngestFn; close: () => void } | null = null

export const ingest: IngestFn = async (filePath, source) => {
  if (!singleton) {
    const sqlitePath =
      process.env.SQLITE_PATH || path.join(process.cwd(), ".runtime", "wiki-ingest.sqlite")
    const wikiRoot = process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki")
    singleton = createIngestModule({ sqlitePath, wikiRoot, logger: (m) => console.error(`[ingest-module] ${m}`) })
  }
  return singleton.ingest(filePath, source)
}
