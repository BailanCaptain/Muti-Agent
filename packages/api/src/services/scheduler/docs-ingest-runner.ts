/**
 * F027 final-vision P1-2 · DocsIngestRunner
 *
 * 真相源：
 *   - docs/plans/V16.5-final.md chap 17 line 1807 + line 2656-2662（路径 2 增量 watcher）
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-6 walkthrough 场景 2
 *     "新建 docs/features/F999-test.md → 5s 内自动 ingest → wiki/concepts/draft/_auto/"
 *   - packages/api/src/routes/phase3/ingest-preview.ts (IngestPreviewService)
 *   - packages/api/src/routes/phase3/ingest-commit.ts (IngestCommitService)
 *
 * 职责（DocsWatcher.onEvent caller）：
 *   - 接 DocsWatcher 收敛后的 DocsEvent (add/change/unlink)
 *   - add/change → fs.readFile → IngestPreviewService.preview → 非 blocked → IngestCommitService.commit
 *   - unlink → 跳过 (docs-watcher 删除事件不触发 ingest; backfill 路径覆盖)
 *
 * 不做：
 *   - 不实现 chokidar/debounce (DocsWatcher 已实施)
 *   - 不写 wiki_events (commit pipeline 内部 updateWiki 已写)
 *   - 不接 retry/dead-letter (preview blocked 或 commit 失败 → 日志记录，不重试 — 由 DriftDetector 兜底)
 *   - 不绑 leader gate (scheduler-bootstrap 由 caller wire)
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { FastifyBaseLogger } from "fastify"
import type { IngestCommitService } from "../../routes/phase3/ingest-commit"
import type { IngestPreviewService } from "../../routes/phase3/ingest-preview"
import { createLogger } from "../../lib/logger"
import type { DocsEvent } from "./docs-watcher"

const MAX_INGEST_BYTES = 1_048_576 // 1MB (同 contracts MAX_INGEST_CONTENT_BYTES)

export const DOCS_WATCHER_CALLER_ALIAS = "docs-watcher"

/** F027 final-vision P1-2 r2 修：版本化 _auto 路径基础前缀。 */
const AUTO_TARGET_DIR = "wiki/concepts/draft/_auto"

export interface DocsIngestRunnerDeps {
  preview: IngestPreviewService
  commit: IngestCommitService
  logger?: FastifyBaseLogger
  /** 注入 clock（测试 deterministic 用；默认 () => Date.now()）。 */
  now?: () => number
}

export interface DocsIngestRunResult {
  skipped: boolean
  /** skipped=true 时填 reason；否则 null。 */
  skippedReason?:
    | "unlink_kind"
    | "file_not_found"
    | "file_too_large"
    | "read_error"
    | "preview_blocked"
    | "commit_failed"
  /** 非 skip 路径：commit endpoint 返回值。 */
  finalPath?: string
  ingestEventId?: string
}

export class DocsIngestRunner {
  private readonly preview: IngestPreviewService
  private readonly commit: IngestCommitService
  private readonly log: FastifyBaseLogger
  private readonly now: () => number

  constructor(deps: DocsIngestRunnerDeps) {
    this.preview = deps.preview
    this.commit = deps.commit
    this.log = deps.logger ?? createLogger("docs-ingest-runner")
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * F027 final-vision P1-2 r2 修：算版本化 finalPath，避免 change 事件第二次落
   * 同 `_auto/<basename>.md` 撞 CAS conflict。
   *
   * 格式：`wiki/concepts/draft/_auto/<basename-without-ext>-<unixMs>.md`
   * - 每次 ingest 都唯一（1ms 内两次 race 概率极低；真撞 → fail-soft commit_failed 兜底）
   * - 同源历史 _auto/* 保留（V16.5 line 2662 期望写 supersedes frontmatter 留 future feature）
   */
  private versionedTargetPath(relativePath: string): string {
    const basename = path.basename(relativePath)
    const ext = path.extname(basename) || ".md"
    const stem = basename.slice(0, basename.length - ext.length) || "doc"
    return `${AUTO_TARGET_DIR}/${stem}-${this.now()}${ext}`
  }

  /**
   * DocsWatcher.onEvent 入口。
   *
   * unlink 直接跳过；add/change 走完整 preview → commit pipeline。
   * 所有失败 / blocked 写 log warn 但不抛（caller 已是 fail-soft try/catch）。
   */
  async runIngest(event: DocsEvent): Promise<DocsIngestRunResult> {
    if (event.kind === "unlink") {
      this.log.debug({ event }, "docs-ingest-runner: unlink skip")
      return { skipped: true, skippedReason: "unlink_kind" }
    }

    // 读文件（race: 用户可能在 stabilityMs 内删了文件）
    let content: string
    try {
      const stat = await fs.stat(event.absolutePath)
      if (stat.size > MAX_INGEST_BYTES) {
        this.log.warn(
          { event, size: stat.size, max: MAX_INGEST_BYTES },
          "docs-ingest-runner: file too large, skip",
        )
        return { skipped: true, skippedReason: "file_too_large" }
      }
      content = await fs.readFile(event.absolutePath, "utf-8")
    } catch (err) {
      // ENOENT (文件被删) → file_not_found；其他 → read_error
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        this.log.debug({ event }, "docs-ingest-runner: file not found (race), skip")
        return { skipped: true, skippedReason: "file_not_found" }
      }
      this.log.warn({ event, err }, "docs-ingest-runner: read failed")
      return { skipped: true, skippedReason: "read_error" }
    }

    // 1. preview (sanitize + minimal stub LLM 预览)
    let previewResult: Awaited<ReturnType<typeof this.preview.preview>>
    try {
      previewResult = await this.preview.preview(
        {
          sourcePath: event.relativePath,
          content,
          mimeType: "text/markdown",
        },
        // codex P2-3(G11)：docs-watcher ingest 的是项目内文档，非外部投喂 →
        // provenance=docs-watcher（tainted_source=false / contributed_by=docs-watcher）。
        { provenance: "docs-watcher" },
      )
    } catch (err) {
      this.log.warn({ event, err }, "docs-ingest-runner: preview threw")
      return { skipped: true, skippedReason: "preview_blocked" }
    }

    // sanitized === '' → preview 内部判 blocked
    if (previewResult.sanitizedContent === "") {
      this.log.warn(
        { event, warnings: previewResult.warnings },
        "docs-ingest-runner: preview blocked (sanitize redline), skip commit",
      )
      return { skipped: true, skippedReason: "preview_blocked" }
    }

    // 2. commit (落 wiki/concepts/draft/_auto/<stem>-<unixMs>.md)
    //    final-vision P1-2 r2 修：用 targetPathOverride 走版本化 path，change 事件第二次也不撞名。
    const targetPathOverride = this.versionedTargetPath(event.relativePath)
    const commitResult = this.commit.commit(
      {
        previewId: previewResult.previewId,
        callerAlias: DOCS_WATCHER_CALLER_ALIAS,
      },
      { targetPathOverride },
    )
    if (!commitResult.ok) {
      this.log.warn(
        { event, error: commitResult.error },
        "docs-ingest-runner: commit failed",
      )
      return { skipped: true, skippedReason: "commit_failed" }
    }

    this.log.info(
      {
        event,
        finalPath: commitResult.response.finalPath,
        ingestEventId: commitResult.response.ingestEventId,
      },
      "docs-ingest-runner: ingest committed",
    )
    return {
      skipped: false,
      finalPath: commitResult.response.finalPath,
      ingestEventId: commitResult.response.ingestEventId,
    }
  }
}
