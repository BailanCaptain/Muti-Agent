/**
 * F027 P19.8 · NightlyHealthCheck (cron 0 4 * * * Asia/Shanghai)
 *
 * 真相源：docs/plans/V16.5-final.md chap 17 line 1816-1854 + AC-P2-10
 *
 * 5 类问题（red/green fixture 全覆盖）：
 *   - deadLinks: entity 引用了不存在的 path
 *   - orphans: 没有任何 entity 引用的 path（无 inbound 链接）
 *   - missingFrontmatter: 缺 sources 或 canonical_owner_path 字段
 *   - canonicalOwnerDrift: 实际 path 与 frontmatter canonical_owner_path 不符
 *   - draftExpired: /draft/ 下 30 天未 promote → mv 到 /draft/_expired/
 *     **draft frontmatter `reviewing: true` 跳过归档**（v2 修订）
 *
 * 职责（Day 9-10 health check 逻辑壳；scan/move 由 caller 注入）：
 *   - scanEntities() 返 wiki 全部 entities (caller 串 db / fs)
 *   - moveExpiredDraft(srcPath, dstPath) 执行归档（caller 串 fs.rename）
 *   - 本类不直接读 fs / db；纯逻辑可单测
 *
 * 不做：
 *   - 不实现 entity 扫描（caller 注入；wiki-services 等 layer 已有）
 *   - 不直接 mv 文件（caller 注入；测试用 stub 计数）
 *   - 不推 R-201 alert（caller 在 onReport 回调里串）
 *   - 不绑 leader gate / scheduler tick — 同其他 Phase 2 jobs，集成层 wire
 */

import path from "node:path"
import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export interface WikiFrontmatter {
  sources?: string[]
  canonical_owner_path?: string
  /** v2 修订：reviewing=true 跳过 draft TTL 归档（避免审核中 draft 被自动归档）。 */
  reviewing?: boolean
  /** ISO 创建时刻；用于 draft TTL 计算。 */
  created_at?: string
  /** Other arbitrary fields preserved but ignored by health check. */
  [k: string]: unknown
}

export interface WikiEntity {
  /** Repo-relative or absolute path（caller 自约定；本类不解析）。 */
  path: string
  frontmatter: WikiFrontmatter
  body: string
}

export interface NightlyHealthCheckOptions {
  /** Caller-injected scanner; returns 全部 wiki entities snapshot。 */
  scanEntities: () => Promise<WikiEntity[]>
  /**
   * Caller-injected mover; mv srcPath → dstPath。
   * 若 not provided：draftExpired 仅记录路径，movedTo 设 null（dry-run 模式）。
   */
  moveExpiredDraft?: (srcPath: string, dstPath: string) => Promise<void>
  /** Inject clock (testing); 默认 () => new Date()。 */
  clock?: () => Date
  /** Draft TTL 阈值；默认 30 天。 */
  draftTtlDays?: number
  /**
   * Health report 回调 — caller 在此推 R-201 alert（V16.5 chap 17:1853 的
   * `publishHealthReport`）。本类不直接 emit；保持纯逻辑。
   */
  onReport?: (report: HealthCheckReport) => Promise<void> | void
  logger?: FastifyBaseLogger
}

export interface DeadLink {
  from: string
  to: string
}

export interface MissingFrontmatter {
  path: string
  missing: ("sources" | "canonical_owner_path")[]
}

export interface CanonicalOwnerDrift {
  path: string
  declared: string
}

export interface DraftExpired {
  path: string
  ageDays: number
  movedTo: string | null
}

export interface HealthCheckReport {
  scannedAt: string
  totalEntities: number
  deadLinks: DeadLink[]
  orphans: string[]
  missingFrontmatter: MissingFrontmatter[]
  canonicalOwnerDrift: CanonicalOwnerDrift[]
  draftExpired: DraftExpired[]
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g
// 提取相对 path：(./foo.md) / (../bar.md) / [text](./foo.md) — 取尾段 path
const RELLINK_RE = /\(\.\.?\/[^)\s]+?\.md\)/g

export class NightlyHealthCheck {
  private readonly opts: NightlyHealthCheckOptions
  private readonly log: FastifyBaseLogger
  private readonly clock: () => Date
  private readonly draftTtlDays: number

  constructor(opts: NightlyHealthCheckOptions) {
    this.opts = opts
    this.log = opts.logger ?? createLogger("nightly-health-check")
    this.clock = opts.clock ?? (() => new Date())
    this.draftTtlDays = opts.draftTtlDays ?? 30
  }

  async run(): Promise<HealthCheckReport> {
    const entities = await this.opts.scanEntities()
    const scannedAt = this.clock().toISOString()
    const allPaths = new Set(entities.map((e) => normalizePath(e.path)))

    const deadLinks: DeadLink[] = []
    const inboundCounts = new Map<string, number>()
    const missingFrontmatter: MissingFrontmatter[] = []
    const canonicalOwnerDrift: CanonicalOwnerDrift[] = []

    // 初始化 inboundCounts 为 0
    for (const e of entities) inboundCounts.set(normalizePath(e.path), 0)

    for (const entity of entities) {
      const myPath = normalizePath(entity.path)

      // (1) missingFrontmatter
      const missing: ("sources" | "canonical_owner_path")[] = []
      if (
        !Array.isArray(entity.frontmatter.sources) ||
        entity.frontmatter.sources.length === 0
      ) {
        missing.push("sources")
      }
      if (typeof entity.frontmatter.canonical_owner_path !== "string") {
        missing.push("canonical_owner_path")
      }
      if (missing.length > 0) {
        missingFrontmatter.push({ path: entity.path, missing })
      }

      // (2) canonicalOwnerDrift
      const declared = entity.frontmatter.canonical_owner_path
      if (typeof declared === "string" && declared.length > 0) {
        if (normalizePath(declared) !== myPath) {
          canonicalOwnerDrift.push({ path: entity.path, declared })
        }
      }

      // (3) deadLinks + inbound counting
      const refs = extractRefs(entity.body, entity.path)
      for (const ref of refs) {
        const refNorm = normalizePath(ref)
        if (allPaths.has(refNorm)) {
          inboundCounts.set(refNorm, (inboundCounts.get(refNorm) ?? 0) + 1)
        } else {
          deadLinks.push({ from: entity.path, to: ref })
        }
      }
    }

    // (4) orphans = inboundCounts == 0 的（draft 子目录默认豁免——尚未发布）
    const orphans: string[] = []
    for (const e of entities) {
      const myPath = normalizePath(e.path)
      if ((inboundCounts.get(myPath) ?? 0) === 0 && !isDraftPath(myPath)) {
        orphans.push(e.path)
      }
    }

    // (5) draftExpired (含 v2 修订 reviewing=true 跳过)
    const nowMs = this.clock().getTime()
    const ttlMs = this.draftTtlDays * 24 * 3600 * 1000
    const draftExpired: DraftExpired[] = []
    for (const entity of entities) {
      if (!isDraftPath(normalizePath(entity.path))) continue
      // v2 修订：reviewing=true 跳过归档（审核中保留）
      if (entity.frontmatter.reviewing === true) continue
      const createdIso = entity.frontmatter.created_at
      if (typeof createdIso !== "string") continue
      const createdMs = Date.parse(createdIso)
      if (Number.isNaN(createdMs)) continue
      const ageMs = nowMs - createdMs
      if (ageMs <= ttlMs) continue
      const ageDays = Math.floor(ageMs / (24 * 3600 * 1000))
      const expiredPath = expiredArchivePath(entity.path)
      let movedTo: string | null = null
      if (this.opts.moveExpiredDraft) {
        try {
          await this.opts.moveExpiredDraft(entity.path, expiredPath)
          movedTo = expiredPath
        } catch (err) {
          this.log.warn(
            { err, src: entity.path, dst: expiredPath },
            "moveExpiredDraft threw (recorded as not-moved)",
          )
        }
      }
      draftExpired.push({ path: entity.path, ageDays, movedTo })
    }

    const report: HealthCheckReport = {
      scannedAt,
      totalEntities: entities.length,
      deadLinks,
      orphans,
      missingFrontmatter,
      canonicalOwnerDrift,
      draftExpired,
    }

    if (this.opts.onReport) {
      try {
        await this.opts.onReport(report)
      } catch (err) {
        this.log.warn({ err }, "onReport threw (ignored — health check still returns report)")
      }
    }

    this.log.info(
      {
        deadLinks: deadLinks.length,
        orphans: orphans.length,
        missingFrontmatter: missingFrontmatter.length,
        canonicalOwnerDrift: canonicalOwnerDrift.length,
        draftExpired: draftExpired.length,
      },
      "health check done",
    )

    return report
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

function isDraftPath(normalizedPath: string): boolean {
  return normalizedPath.includes("/draft/")
}

function expiredArchivePath(originalPath: string): string {
  // wiki/concepts/draft/X.md → wiki/concepts/draft/_expired/X.md
  // 若 path 已含 _expired/ 不重复嵌套
  if (normalizePath(originalPath).includes("/draft/_expired/")) return originalPath
  // 用 path.posix 强 POSIX 拼，避免 Windows backslash
  const posixPath = normalizePath(originalPath)
  const idx = posixPath.indexOf("/draft/")
  if (idx === -1) return originalPath
  const head = posixPath.slice(0, idx + "/draft/".length)
  const tail = posixPath.slice(idx + "/draft/".length)
  return `${head}_expired/${tail}`
}

function extractRefs(body: string, fromPath: string): string[] {
  const refs: string[] = []
  // [[wikilink]] — 路径直接是 wikilink target
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].trim()
    refs.push(target.endsWith(".md") ? target : `${target}.md`)
  }
  // (./foo.md) / (../bar.md) — 解析为相对 fromPath 的 path
  for (const m of body.matchAll(RELLINK_RE)) {
    const raw = m[0].slice(1, -1) // strip ( )
    // 用 path.posix 解析；fromPath 提取 dirname
    const fromDir = path.posix.dirname(normalizePath(fromPath))
    const resolved = path.posix.normalize(path.posix.join(fromDir, raw))
    refs.push(resolved)
  }
  return refs
}
