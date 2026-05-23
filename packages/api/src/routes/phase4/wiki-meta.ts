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
    return { warnings: out, total: out.length }
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
    }
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
}
