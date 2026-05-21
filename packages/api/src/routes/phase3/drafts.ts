/**
 * F027 Phase 3 P20 · GET /api/wiki/drafts — Week 1 Day 3
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1 Day 3
 *   + contracts.ts §2 ListDraftsResponse
 *
 * 数据源：扫文件系统 `<wikiRoot>/wiki/concepts/draft/` 下所有 .md（递归）
 *
 * Origin 推断（V16.5.3 D3 三类隔离）：
 *   - path 含 `/_auto/` → "auto"        (DocsWatcher 自动 ingest)
 *   - path 含 `/_backfill/` → "backfill" (历史批量导入)
 *   - path 含 `/_expired/` → "expired"   (TTL 过期归档)
 *   - 其他 → "user-drop"                 (用户拖拽 / [+ Drop] 入口)
 *
 * Type 推断：frontmatter.type 优先；缺时 fallback "concept"
 *
 * 设计：
 *   - 文件不存在 / wikiRoot 不存在 → 返 { drafts: [], total: 0, limit: defLimit, offset: 0 }
 *   - frontmatter 解析失败 → 跳过此文件（log warn），不打断 scan
 *   - mtime 用 fs.stat().mtime（ISO 化）
 *   - 默认 limit=50，offset=0
 *
 * 不做（Phase 3 Day 3 范围）：
 *   - 不实现 demote/promote/批量审批（Phase 4 AC-P4-*）
 *   - 不实现 sanitize 预扫（Day 5 preview endpoint）
 *   - 不写文件（read-only endpoint）
 */

import fs from "node:fs/promises"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import {
  type DraftSummary,
  type DraftType,
  ErrorCode,
  HTTP_STATUS_BY_ERROR,
  type ListDraftsQuery,
  type ListDraftsResponse,
  toErrorResponse,
  validateListDrafts,
} from "./contracts"
import { parseFrontmatter } from "./frontmatter"

const DRAFT_TYPES_ALLOWED: ReadonlySet<DraftType> = new Set<DraftType>([
  "feature",
  "bug",
  "lesson",
  "concept",
  "wiki-memory",
  "session-archive",
])

const DEFAULT_LIMIT = 50
const SUMMARY_LEN = 200

interface DraftFrontmatter {
  title?: string
  type?: string
}

export interface DraftScannerDeps {
  wikiRoot: string
  /** 可选 fs reader override（测试用）。 */
  fsAdapter?: {
    /** 必须返回 dirent.isDirectory() / isSymbolicLink() 这两个判定（范-r1 P1-4）。 */
    readdir: (p: string) => Promise<
      { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[]
    >
    readFile: (p: string) => Promise<string>
    stat: (p: string) => Promise<{ mtime: Date }>
  }
  /** 自定义 logger（默认 noop；route 内由 fastify request.log 注入）。 */
  logWarn?: (obj: Record<string, unknown>, msg: string) => void
}

export class DraftScanner {
  private readonly wikiRoot: string
  private readonly fsAdapter: NonNullable<DraftScannerDeps["fsAdapter"]>
  private readonly logWarn: (obj: Record<string, unknown>, msg: string) => void

  constructor(deps: DraftScannerDeps) {
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
    this.logWarn = deps.logWarn ?? (() => {})
  }

  async list(query: ListDraftsQuery): Promise<ListDraftsResponse> {
    const limit = query.limit ?? DEFAULT_LIMIT
    const offset = query.offset ?? 0

    const draftRoot = path.join(this.wikiRoot, "wiki", "concepts", "draft")
    const all = await this.walkAllDrafts(draftRoot)

    // filter
    let filtered = all
    if (query.type !== undefined) {
      filtered = filtered.filter((d) => d.type === query.type)
    }
    if (query.mtimeFrom !== undefined) {
      const fromMs = Date.parse(query.mtimeFrom)
      filtered = filtered.filter((d) => Date.parse(d.mtime) >= fromMs)
    }
    if (query.mtimeTo !== undefined) {
      const toMs = Date.parse(query.mtimeTo)
      filtered = filtered.filter((d) => Date.parse(d.mtime) <= toMs)
    }

    // sort by mtime DESC (新→老)
    filtered.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))

    const total = filtered.length
    const page = filtered.slice(offset, offset + limit)

    return {
      drafts: page,
      total,
      limit,
      offset,
    }
  }

  private async walkAllDrafts(root: string): Promise<DraftSummary[]> {
    const out: DraftSummary[] = []
    try {
      await this.walkInto(root, out)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") {
        // draft 根目录尚未创建（fresh wiki）— 返空
        return []
      }
      throw err
    }
    return out
  }

  private async walkInto(dir: string, acc: DraftSummary[]): Promise<void> {
    let entries: Awaited<ReturnType<typeof this.fsAdapter.readdir>>
    try {
      entries = await this.fsAdapter.readdir(dir)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") return
      throw err
    }
    for (const ent of entries) {
      // 范-r1 P1-4：拒绝 symlink（V16.5 chap 7 raw drop taint model — 用户拖入的文件
      // 可能含 symlink 逃出 wiki 根目录，符号链接不算合规 draft 来源）。
      if (ent.isSymbolicLink()) {
        this.logWarn({ name: ent.name, dir }, "drafts: skipped symlink entry")
        continue
      }
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await this.walkInto(full, acc)
        continue
      }
      if (!ent.name.endsWith(".md")) continue
      const summary = await this.summarizeDraft(full)
      if (summary) acc.push(summary)
    }
  }

  private async summarizeDraft(absPath: string): Promise<DraftSummary | null> {
    let raw: string
    try {
      raw = await this.fsAdapter.readFile(absPath)
    } catch (err) {
      this.logWarn({ err, absPath }, "drafts: readFile failed (skipped)")
      return null
    }
    let stat: { mtime: Date }
    try {
      stat = await this.fsAdapter.stat(absPath)
    } catch (err) {
      this.logWarn({ err, absPath }, "drafts: stat failed (skipped)")
      return null
    }

    let fmRaw: DraftFrontmatter | null
    try {
      fmRaw = parseFrontmatter<DraftFrontmatter>(raw).frontmatter
    } catch (err) {
      this.logWarn({ err, absPath }, "drafts: frontmatter parse failed (skipped)")
      return null
    }

    const relPath = this.toRelPath(absPath)
    const origin = inferOrigin(relPath)
    const type = inferType(fmRaw)
    const title = inferTitle(fmRaw, relPath)
    // 范-r1 P3-2：用 parseFrontmatter(raw).body 拿 body，去掉本地 stripFrontmatter regex 重复。
    // 范-r1 P2-5：trim 尾部空白先于 slice，再切 SUMMARY_LEN 防"前 200 字含尾部空白"。
    const body = parseFrontmatter(raw).body
    const summary = body.slice(0, SUMMARY_LEN).replace(/\s+$/, "")

    return {
      path: relPath,
      type,
      title,
      mtime: stat.mtime.toISOString(),
      summary,
      origin,
    }
  }

  private toRelPath(absPath: string): string {
    const wikiRootResolved = path.resolve(this.wikiRoot)
    const absResolved = path.resolve(absPath)
    if (absResolved.startsWith(`${wikiRootResolved}${path.sep}`)) {
      return absResolved
        .slice(wikiRootResolved.length + 1)
        .split(path.sep)
        .join("/")
    }
    return absPath.split(path.sep).join("/")
  }
}

function inferOrigin(relPath: string): DraftSummary["origin"] {
  // path 形如 "wiki/concepts/draft/_auto/2026-05-20-foo.md"
  // 拆段后查 "_auto" / "_backfill" / "_expired"
  const segments = relPath.split("/")
  for (const seg of segments) {
    if (seg === "_auto") return "auto"
    if (seg === "_backfill") return "backfill"
    if (seg === "_expired") return "expired"
  }
  return "user-drop"
}

function inferType(fm: DraftFrontmatter | null): DraftType {
  const raw = fm?.type
  if (typeof raw === "string" && DRAFT_TYPES_ALLOWED.has(raw as DraftType)) {
    return raw as DraftType
  }
  return "concept"
}

function inferTitle(fm: DraftFrontmatter | null, relPath: string): string {
  if (fm?.title && typeof fm.title === "string" && fm.title.length > 0) return fm.title
  const filename = relPath.split("/").pop() ?? relPath
  return filename.replace(/\.md$/, "")
}

export function registerDraftsRoute(
  app: FastifyInstance,
  scanner: DraftScanner,
): void {
  app.get("/api/wiki/drafts", async (request, reply) => {
    const validation = validateListDrafts(request.query)
    if (!validation.ok) {
      reply.code(HTTP_STATUS_BY_ERROR[validation.error])
      return toErrorResponse(validation)
    }
    try {
      const body = await scanner.list(validation.value)
      return body
    } catch (err) {
      request.log.error({ err }, "drafts scanner threw")
      reply.code(HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR])
      return toErrorResponse({
        ok: false,
        error: ErrorCode.INTERNAL_ERROR,
        message: (err as Error).message,
      })
    }
  })
}
