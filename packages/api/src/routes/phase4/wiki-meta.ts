/**
 * F027 Phase 4 Week 4 Day 17 (AC-P4-9 a/b) · GET /api/wiki/warnings + GET /api/wiki/index
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-9 (a)(b) line 253-254
 *   - V16.5 chap 18 line 1953-1954 (WarningsTab + KnowledgeBaseTab 数据源)
 *   - V16.5 chap 22 line 2172-2199 (wiki/index.md + wiki/index/*.md 派生视图)
 *   - Phase 3 drafts.ts scanner pattern (复用 frontmatter parser)
 *
 * 数据源 (worktree-preview 已 fixture seed 拷到 .runtime/worktree-preview/data/wiki/):
 *   - GET /api/wiki/warnings: 平铺扫 <wikiRoot>/warnings/*.md
 *     → frontmatter 解析 type/subtype/severity/source/detected_at/raised_by
 *   - GET /api/wiki/index: 平铺扫 <wikiRoot>/index/*.md
 *     → frontmatter 解析 bucket/generated_at + 文件名 → bucket
 *
 * 设计:
 *   - 不递归子目录 (跟 fixture copier 一致，平铺 .md)
 *   - 文件不存在 / wikiRoot 不存在 → 返空 list (不 throw)
 *   - frontmatter 解析失败 → 跳过该文件 (log warn)
 *   - sort by detected_at / generated_at DESC (新→老)
 *
 * 不做 (Day 17 范围):
 *   - 不实现 markdown 表格 entity-level parse (KB tab multi-select 推 F028)
 *   - 不实现 filter query params (Week 5 follow-up)
 *   - 不实现 pagination (当前 fixture < 20 份够)
 */

import fs from "node:fs/promises"
import path from "node:path"

import type { FastifyInstance } from "fastify"

import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import {
  canReadContainedFile,
  readContainedFile,
  WikiPathInvalidError,
} from "../../wiki/path-containment"
import { parseFrontmatter } from "../phase3/frontmatter"

// ─── contracts (inline; mirror Phase 4 endpoint shapes) ──────────────────────

export type WarningSeverity = "critical" | "high" | "warn" | "info"
export type WarningSubtype = string // 不强制 enum，frontmatter 写啥用啥

export interface WarningSummary {
  path: string
  type: string
  subtype: WarningSubtype
  severity: WarningSeverity | null
  source: string | null
  detectedAt: string | null
  raisedBy: string | null
  /** body 前 200 字 truncate */
  summary: string
  mtime: string
  /**
   * F027 修（小孙自验「展开看全文」404）：点「展开看全文」**是否会成功返回内容**（content 端点 200）。
   * 由 listWarnings 末尾用 `canReadContainedFile`（与 content 端点 readWarningContent 同一可读判定）
   * 统一计算 → **`hasContent=true` ⟺ GET /api/wiki/warnings/content 200**。前端只对 true 渲染按钮。
   *
   * 不按 producer 猜（德彪 codex r-warn P2）：合成 path 也以 `wiki/warnings/` 开头（不能靠前缀，原 bug）；
   * 解析失败但裸读可读的文件不该藏按钮；hardlink 文件会被 content 端点拒（400）不该显按钮。
   */
  hasContent: boolean
}

export interface ListWarningsResponse {
  warnings: WarningSummary[]
  total: number
}

export type IndexBucket = "concepts" | "rules" | "methods" | "people" | "rooms-active" | "rooms-archive" | string

export interface IndexViewSummary {
  path: string
  bucket: IndexBucket
  generatedAt: string | null
  compilerVersion: string | null
  /** body 前 200 字 truncate (派生视图通常含表格，前 200 字给个概览) */
  summary: string
  mtime: string
}

export interface ListIndexResponse {
  views: IndexViewSummary[]
  total: number
}

// ─── Scanner ────────────────────────────────────────────────────────────────

interface WarningFrontmatter {
  type?: string
  subtype?: string
  severity?: string
  source?: string
  detected_at?: string
  raised_by?: string
}

interface IndexFrontmatter {
  type?: string
  bucket?: string
  generated_at?: string
  compiler_version?: string
}

export interface WikiMetaScannerDeps {
  wikiRoot: string
  /** Optional fs adapter for tests. */
  fsAdapter?: {
    readdir: (
      p: string,
    ) => Promise<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[]>
    readFile: (p: string) => Promise<string>
    stat: (p: string) => Promise<{ mtime: Date }>
  }
  /**
   * codex Week 4 mid-r1 P2 修: warnings 列表 merge wiki_events action='warning_raised' rows
   * (plan AC-P4-9 a line 253 "派生数据源读 wiki/warnings/*.md + wiki_events action='warning_raised'")
   * 可选注入: 缺则 fallback 仅 scan fs (向后兼容单测), 注入后 merge by path 去重.
   */
  events?: WikiEventsRepository
  logWarn?: (obj: Record<string, unknown>, msg: string) => void
}

const SUMMARY_LEN = 200
const ALLOWED_SEVERITY: ReadonlySet<WarningSeverity> = new Set<WarningSeverity>([
  "critical",
  "high",
  "warn",
  "info",
])

export class WikiMetaScanner {
  private readonly wikiRoot: string
  private readonly fsAdapter: NonNullable<WikiMetaScannerDeps["fsAdapter"]>
  private readonly events: WikiEventsRepository | undefined
  private readonly logWarn: (obj: Record<string, unknown>, msg: string) => void

  constructor(deps: WikiMetaScannerDeps) {
    this.wikiRoot = deps.wikiRoot
    this.fsAdapter = deps.fsAdapter ?? {
      readdir: async (p) => {
        const entries = await fs.readdir(p, { withFileTypes: true })
        return entries.map((e) => ({
          name: e.name,
          isDirectory: () => e.isDirectory(),
          isSymbolicLink: () => e.isSymbolicLink(),
        }))
      },
      readFile: (p) => fs.readFile(p, "utf-8"),
      stat: (p) => fs.stat(p),
    }
    this.events = deps.events
    this.logWarn = deps.logWarn ?? (() => {})
  }

  async listWarnings(): Promise<ListWarningsResponse> {
    const dir = path.join(this.wikiRoot, "warnings")
    const files = await this.listMdFiles(dir)
    const byPath = new Map<string, WarningSummary>()
    for (const fileName of files) {
      const summary = await this.summarizeWarning(dir, fileName)
      if (summary) byPath.set(summary.path, summary)
    }

    // codex mid-r1 P2: merge wiki_events action='warning_raised' rows
    // (plan AC-P4-9 a 字面要求, fs file 缺时 events row 兜底, fs 优先 events 兜底)
    if (this.events) {
      try {
        const events = this.events.getByAction("warning_raised", 200)
        for (const ev of events) {
          if (byPath.has(ev.path)) continue // fs file 优先, events 仅补缺
          byPath.set(ev.path, this.eventToWarning(ev))
        }
      } catch (err) {
        this.logWarn({ err }, "wiki-meta: events.getByAction failed (skip merge)")
      }
    }

    // sort by detectedAt DESC (新→老); null 排末尾
    const out = [...byPath.values()].sort((a, b) => {
      if (a.detectedAt === null && b.detectedAt === null) return 0
      if (a.detectedAt === null) return 1
      if (b.detectedAt === null) return -1
      return Date.parse(b.detectedAt) - Date.parse(a.detectedAt)
    })
    // 德彪 codex r-warn P2：hasContent 用 content 端点同一套可读判定**统一重算**（producer 占位被覆盖）。
    // 不按"哪个 producer 造的"猜 —— 否则会发散：解析失败但裸读可读的文件（藏按钮）、hardlink 文件（显按钮却 400）。
    // 此处与 readWarningContent 共用 resolveWarningAbsPath + canReadContainedFile → hasContent=true ⟺ content 200。
    for (const w of out) {
      w.hasContent = await this.computeHasContent(w.path)
    }
    return { warnings: out, total: out.length }
  }

  /**
   * 把 list 给的逻辑 path（'wiki/warnings/<name>'）解析为磁盘 abs path + 施加平铺 basename 白名单。
   * readWarningContent（content 端点）与 computeHasContent（list hasContent）共用 → 路径派生一致。
   * 非法 path 抛 WikiPathInvalidError。
   */
  private resolveWarningAbsPath(warningPath: string): string {
    const PREFIX = "wiki/warnings/"
    if (typeof warningPath !== "string" || !warningPath.startsWith(PREFIX)) {
      throw new WikiPathInvalidError(`warning path must start with '${PREFIX}': ${warningPath}`)
    }
    const name = warningPath.slice(PREFIX.length)
    if (
      name.length === 0 ||
      name.includes("/") ||
      name.includes("\\") ||
      name.includes(":") || // 德彪 codex r2 P2：NTFS ADS（`x.txt:stream.md` 绕过 .md 检查）
      name.includes("..") ||
      name.includes("\0") ||
      !name.endsWith(".md")
    ) {
      throw new WikiPathInvalidError(`invalid warning filename: ${warningPath}`)
    }
    return path.join(this.wikiRoot, "warnings", name)
  }

  /**
   * 德彪 codex r-warn P2：list 侧 hasContent 必须 = "content 端点点开会不会 200"，不能按 producer 猜。
   * 与 readWarningContent 共用 resolveWarningAbsPath + 同一 canReadContainedFile 判定 →
   * hasContent=true ⟺ readWarningContent 返回内容 ⟺ GET /api/wiki/warnings/content 200。
   * 非法 path / 不存在 / 目录 / hardlink / 越界 → false（content 端点会 400/404）。
   */
  private async computeHasContent(warningPath: string): Promise<boolean> {
    let absPath: string
    try {
      absPath = this.resolveWarningAbsPath(warningPath)
    } catch {
      return false // 非法 path → content 端点 400 → 不显展开按钮
    }
    const warningsRoot = path.join(this.wikiRoot, "warnings")
    try {
      return await canReadContainedFile(absPath, warningsRoot)
    } catch (err) {
      this.logWarn({ err, warningPath }, "wiki-meta: hasContent probe failed")
      return false
    }
  }

  private eventToWarning(ev: {
    path: string
    alias: string
    ts: string
    diffSummary?: string | null
    reason?: string | null
  }): WarningSummary {
    return {
      path: ev.path,
      type: "warning",
      subtype: "warning_raised",
      severity: null,
      source: "wiki_events",
      detectedAt: ev.ts,
      raisedBy: ev.alias,
      summary: (ev.reason ?? ev.diffSummary ?? "").slice(0, SUMMARY_LEN),
      mtime: ev.ts,
      hasContent: false, // 占位：listWarnings() 末尾用 canReadContainedFile 统一重算（德彪 r-warn P2）
    }
  }

  /**
   * F027 · 读单条 warning 全文（KB tab「展开看全文」；摘要列表只给 200 字 summary）。
   * warnings 目录平铺（listMdFiles 非递归，只扫 `<wikiRoot>/warnings/*.md`），故路径围栏 =
   * basename 白名单：path 必须 'wiki/warnings/<纯文件名>.md'（无子目录 / .. / NUL / 路径分隔符）。
   * 注意：path 里的 'wiki/' 是逻辑前缀——this.wikiRoot 已是 wiki 内容根（warnings 直接在其下，无 wiki/
   * 子层），故剥前缀后只拼 warnings/<name>。event-only warning（无文件）→ ENOENT → null（route 404）。
   */
  async readWarningContent(
    warningPath: string,
  ): Promise<{ content: string; mtime: string } | null> {
    // resolveWarningAbsPath：平铺 basename 白名单（非法 path 抛 WikiPathInvalidError）。
    // 与 computeHasContent 共用同一派生 → list hasContent 与本端点路径判定一致。
    const absPath = this.resolveWarningAbsPath(warningPath)
    const warningsRoot = path.join(this.wikiRoot, "warnings")
    // 德彪 codex P1：realpath containment（防 symlink/junction 跟随逃逸）+ 普通文件校验
    //（name 白名单已强制纯 .md 文件名，此处再防真实路径越界）。
    return readContainedFile(absPath, warningsRoot)
  }

  async listIndex(): Promise<ListIndexResponse> {
    const dir = path.join(this.wikiRoot, "index")
    const files = await this.listMdFiles(dir)
    const out: IndexViewSummary[] = []
    for (const fileName of files) {
      const summary = await this.summarizeIndex(dir, fileName)
      if (summary) out.push(summary)
    }
    // sort by bucket name asc (concepts / methods / rooms-active / rules)
    out.sort((a, b) => a.bucket.localeCompare(b.bucket))
    return { views: out, total: out.length }
  }

  private async listMdFiles(dir: string): Promise<string[]> {
    try {
      const entries = await this.fsAdapter.readdir(dir)
      return entries
        .filter((e) => !e.isDirectory() && !e.isSymbolicLink() && e.name.endsWith(".md"))
        .map((e) => e.name)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") return []
      throw err
    }
  }

  private async summarizeWarning(
    dir: string,
    fileName: string,
  ): Promise<WarningSummary | null> {
    const absPath = path.join(dir, fileName)
    let raw: string
    try {
      raw = await this.fsAdapter.readFile(absPath)
    } catch (err) {
      this.logWarn({ err, absPath }, "wiki-meta: warning readFile failed")
      return null
    }
    let stat: { mtime: Date }
    try {
      stat = await this.fsAdapter.stat(absPath)
    } catch (err) {
      this.logWarn({ err, absPath }, "wiki-meta: warning stat failed")
      return null
    }

    let fm: WarningFrontmatter | null
    let body: string
    try {
      const parsed = parseFrontmatter<WarningFrontmatter>(raw)
      fm = parsed.frontmatter
      body = parsed.body
    } catch (err) {
      this.logWarn({ err, absPath }, "wiki-meta: warning frontmatter parse failed")
      return null
    }

    const severity =
      fm?.severity && ALLOWED_SEVERITY.has(fm.severity as WarningSeverity)
        ? (fm.severity as WarningSeverity)
        : null
    const summary = body.slice(0, SUMMARY_LEN).replace(/\s+$/, "")

    return {
      path: `wiki/warnings/${fileName}`,
      type: fm?.type ?? "warning",
      subtype: fm?.subtype ?? "unknown",
      severity,
      source: fm?.source ?? null,
      detectedAt: fm?.detected_at ?? null,
      raisedBy: fm?.raised_by ?? null,
      summary,
      mtime: stat.mtime.toISOString(),
      hasContent: false, // 占位：listWarnings() 末尾用 canReadContainedFile 统一重算（德彪 r-warn P2）
    }
  }

  private async summarizeIndex(
    dir: string,
    fileName: string,
  ): Promise<IndexViewSummary | null> {
    const absPath = path.join(dir, fileName)
    let raw: string
    try {
      raw = await this.fsAdapter.readFile(absPath)
    } catch (err) {
      this.logWarn({ err, absPath }, "wiki-meta: index readFile failed")
      return null
    }
    let stat: { mtime: Date }
    try {
      stat = await this.fsAdapter.stat(absPath)
    } catch (err) {
      this.logWarn({ err, absPath }, "wiki-meta: index stat failed")
      return null
    }

    let fm: IndexFrontmatter | null
    let body: string
    try {
      const parsed = parseFrontmatter<IndexFrontmatter>(raw)
      fm = parsed.frontmatter
      body = parsed.body
    } catch (err) {
      this.logWarn({ err, absPath }, "wiki-meta: index frontmatter parse failed")
      return null
    }

    const bucket = fm?.bucket ?? fileName.replace(/\.md$/, "")
    const summary = body.slice(0, SUMMARY_LEN).replace(/\s+$/, "")

    return {
      path: `wiki/index/${fileName}`,
      bucket,
      generatedAt: fm?.generated_at ?? null,
      compilerVersion: fm?.compiler_version ?? null,
      summary,
      mtime: stat.mtime.toISOString(),
    }
  }
}

// ─── Route registration ──────────────────────────────────────────────────────

export interface WikiMetaRoutesDeps {
  scanner: WikiMetaScanner
}

export function registerWikiMetaRoutes(
  app: FastifyInstance,
  deps: WikiMetaRoutesDeps,
): void {
  app.get("/api/wiki/warnings", async (request, reply) => {
    try {
      return await deps.scanner.listWarnings()
    } catch (err) {
      request.log.error({ err }, "GET /api/wiki/warnings threw")
      reply.code(500)
      return { ok: false, error: "INTERNAL_ERROR", message: (err as Error).message }
    }
  })

  app.get("/api/wiki/index", async (request, reply) => {
    try {
      return await deps.scanner.listIndex()
    } catch (err) {
      request.log.error({ err }, "GET /api/wiki/index threw")
      reply.code(500)
      return { ok: false, error: "INTERNAL_ERROR", message: (err as Error).message }
    }
  })

  // F027 · GET /api/wiki/warnings/content?path=<warningPath> —— KB tab「展开看全文」按需读单条全文。
  // 静态路径，与 /api/wiki/warnings 不冲突（fastify 精确匹配）。
  app.get("/api/wiki/warnings/content", async (request, reply) => {
    const { path: warningPath } = request.query as { path?: string }
    if (typeof warningPath !== "string" || warningPath.length === 0) {
      reply.code(400)
      return { ok: false, error: "VALIDATION_FAILED", message: "query param 'path' is required" }
    }
    try {
      const result = await deps.scanner.readWarningContent(warningPath)
      if (!result) {
        reply.code(404)
        return { ok: false, error: "NOT_FOUND", message: "warning not found" }
      }
      return result
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        reply.code(400)
        return { ok: false, error: "PATH_INVALID", message: err.message }
      }
      request.log.error({ err }, "GET /api/wiki/warnings/content threw")
      reply.code(500)
      return { ok: false, error: "INTERNAL_ERROR", message: (err as Error).message }
    }
  })
}
