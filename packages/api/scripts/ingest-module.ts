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
    // 德彪 codex P3-1：crossRefs 从**编译产物**统计（LLM 可能规范化/新增 wikilink），比原始 doc 准。
    const compiled = previewRes.llmCompiledPreview || content
    const crossRefs = (compiled.match(/\[\[[^\]]+\]\]/g) ?? []).length
    const result = commit.commit({ previewId: previewRes.previewId, callerAlias })
    if (!result.ok) {
      // 德彪 codex P2：CAS conflict（`_auto/<basename>.md` 同名已存在）= **幂等成功**（已导入），
      // 不当 failed —— 重跑无 --resume 时不把"已成功导入"误报成 failed。异源同名 collision 罕见，
      // 主防线是 --resume + state.jsonl/frontmatter 双源 marker；本分支是兜底幂等。其他错（denied_acl /
      // path_invalid / internal 等）仍 throw 让 backfill 记 failed。
      if (result.error.detail?.reason === "conflict") {
        return { ingestEventId: "already-exists", type: "concept", crossRefs }
      }
      throw new Error(`ingest commit failed (${result.error.code}): ${result.error.message}`)
    }
    return { ingestEventId: result.response.ingestEventId, type: "concept", crossRefs }
  }
  return { ingest, close }
}

// ── backfill `--ingest-module` 默认入口（env: SQLITE_PATH + WIKI_ROOT；lazy singleton）──
let singleton: { ingest: IngestFn; close: () => void } | null = null

export const ingest: IngestFn = async (filePath, source) => {
  if (!singleton) {
    // 德彪 codex P2：env 缺失 **fail-fast**，不静默落到 cwd 默认 root —— 少配 env 会把 wiki 文件 +
    // wiki_events 写到 reader 读不到的错误根（= B2 double-root 同类风险）。生产 backfill 必须显式配。
    // 测试/试跑请直接 createIngestModule({sqlitePath, wikiRoot, ...})，不走本 env 入口。
    const sqlitePath = process.env.SQLITE_PATH
    const wikiRoot = process.env.WIKI_ROOT
    if (!sqlitePath || !wikiRoot) {
      throw new Error(
        "ingest-module 默认入口需显式 env：SQLITE_PATH（目标库 sqlite）+ WIKI_ROOT（目标 wiki 根·单层）；缺一即抛，避免静默写错 root。",
      )
    }
    // 德彪 codex P2：注入生产同款 handbook 编译规则（与 server.ts ingest 路径一致），不留空 → 编译质量对齐。
    let handbookCompileRules = ""
    try {
      const { loadHandbookSlices } = await import("../src/wiki/handbook-slicer")
      const handbookRoot = process.env.WIKI_HANDBOOK_ROOT || process.cwd()
      handbookCompileRules = (await loadHandbookSlices(handbookRoot)).compileRules
    } catch (err) {
      console.error(
        `[ingest-module] handbook compileRules 加载失败（用空规则继续）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    singleton = createIngestModule({
      sqlitePath,
      wikiRoot,
      handbookCompileRules,
      logger: (m) => console.error(`[ingest-module] ${m}`),
    })
  }
  return singleton.ingest(filePath, source)
}
