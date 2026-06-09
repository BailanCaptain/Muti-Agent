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
  /**
   * F027 chunk B：被本 entity 覆盖的旧 path 列表（compile pipeline / dedup=supersedes 写）。
   * deadSupersedes 检测用——指向不存在 entity 的 path = 死链。
   */
  supersedes?: string[]
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
  /**
   * **范-r1 P1 修复**：resolve `[[wikilink]]` target（可能是 name 而非 path）→ entity.path。
   *
   * 实际 wikilink 多是 `[[Concept Name|alias]]` / `[[Concept#section]]` 等
   * name-based（compile-prompt.ts:75 emit）。直接当 path 对比会 false-positive
   * 误报 deadLink。
   *
   * caller 注入 resolver：根据 target text + fromEntity + allEntities 算出 path
   * 或返 null 表示不能 resolve（caller 不知道这个 name 是什么）。
   *
   * **不注入时的 default 行为**：只对"path-style" target（`wiki/...md` 形如
   * 真实 fs path）做存在性检查；其他 name-style target **跳过 deadLink 检测**
   * 避免 false positive（spec 真实情况由 caller 用 wiki-services 等 layer 接 resolver）。
   */
  resolveWikiLink?: (
    target: string,
    fromEntity: WikiEntity,
    allEntities: WikiEntity[],
  ) => string | null
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

/**
 * F027 chunk B（从 wiki-memories-lint R1 搬来）：同一 declared canonical_owner_path
 * 被 >1 个非 draft entity 声称 = 冲突（应只有一个 canonical 拥有者）。
 * 表时代 R1 = "多 state=canonical 行"；文件时代 canonical = 非 /draft/ 路径。
 */
export interface DuplicateCanonical {
  canonicalOwnerPath: string
  /** 声称拥有此 canonical path 的多个 entity 路径（>=2）。 */
  claimants: string[]
}

/**
 * F027 chunk B（从 wiki-memories-lint R3 搬来）：supersedes 指向的旧 path 必须仍存在于
 * entity 集合（即使已归档）。死链 = 引用从未写入或被物理删除的 path。
 */
export interface DeadSupersedes {
  path: string
  /** supersedes 中指向不存在 entity 的 path 列表。 */
  missing: string[]
}

export interface HealthCheckReport {
  scannedAt: string
  totalEntities: number
  deadLinks: DeadLink[]
  orphans: string[]
  missingFrontmatter: MissingFrontmatter[]
  canonicalOwnerDrift: CanonicalOwnerDrift[]
  draftExpired: DraftExpired[]
  /** F027 chunk B：R1 治理搬文件——重复 canonical 声称。 */
  duplicateCanonical: DuplicateCanonical[]
  /** F027 chunk B：R3 治理搬文件——supersedes 死链。 */
  deadSupersedes: DeadSupersedes[]
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

    // F027 #285 receive 德彪 r1 P2-3 · 派生视图豁免判定：generated_by marker
    // （viewfinder=room-compiler G3 / session-summary=memory-service #285）。派生视图
    // 不进 canonical KB（无 canonical_owner_path 是设计而非缺陷），缺字段/orphan 报警
    // = 每夜噪声。不能加 canonical marker 豁免（会进全局索引污染）→ 按 generated_by 过滤。
    // 注意：仅豁免「被报告」，其 body 的 outbound refs 仍参与 inbound 计数/deadLinks。
    const isDerivedView = (e: WikiEntity): boolean =>
      typeof e.frontmatter.generated_by === "string" && e.frontmatter.generated_by.length > 0

    for (const entity of entities) {
      const myPath = normalizePath(entity.path)

      // (1) missingFrontmatter（派生视图豁免 — P2-3；refs 扫描仍照常走）
      if (!isDerivedView(entity)) {
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
        // 范-r1 P1: wikilink 走 resolver；rellink 已是 path-style 直接对比
        let resolved: string | null
        if (ref.kind === "rellink") {
          resolved = normalizePath(ref.target)
        } else if (this.opts.resolveWikiLink) {
          const r = this.opts.resolveWikiLink(ref.target, entity, entities)
          resolved = r === null ? null : normalizePath(r)
        } else {
          // default no-resolver：仅 path-style target 做存在性检查；name-style 跳过避免 false-positive
          resolved = looksLikePath(ref.target)
            ? normalizePath(ref.target.endsWith(".md") ? ref.target : `${ref.target}.md`)
            : null
        }
        if (resolved === null) continue // resolver 没法判 / name-style 默认豁免
        // 范-r1 P2-3: self-link 不算 inbound（防自循环 orphan 被隐藏）
        if (resolved === myPath) continue
        if (allPaths.has(resolved)) {
          inboundCounts.set(resolved, (inboundCounts.get(resolved) ?? 0) + 1)
        } else {
          deadLinks.push({ from: entity.path, to: ref.target })
        }
      }
    }

    // (4) orphans = inboundCounts == 0 的（任何 /draft/ 路径豁免——未发布 + 已归档不应被引用；
    //     派生视图豁免 — P2-3：viewfinder/session-summary 本就没人 [[link]] 它们）
    const orphans: string[] = []
    for (const e of entities) {
      const myPath = normalizePath(e.path)
      if ((inboundCounts.get(myPath) ?? 0) === 0 && !isAnyDraftPath(myPath) && !isDerivedView(e)) {
        orphans.push(e.path)
      }
    }

    // (5) draftExpired (含 v2 修订 reviewing=true 跳过 + 范-r1 P2-2 split active)
    const nowMs = this.clock().getTime()
    const ttlMs = this.draftTtlDays * 24 * 3600 * 1000
    const draftExpired: DraftExpired[] = []
    for (const entity of entities) {
      // 范-r1 P2-2: 只对 active draft 做 TTL 检查（_expired/ 已归档 / _quarantined/ 隔离都跳过）
      if (!isActiveDraftPath(normalizePath(entity.path))) continue
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

    // (6) duplicateCanonical（F027 chunk B · wiki-memories-lint R1 搬来）
    // 同一 declared canonical_owner_path 被 >1 个非 draft entity 声称 → 冲突。
    // 正常每个 entity 声称自己（== 自身 path）；两个非 draft 声称同一 path = 漂移/重复。
    const claimantsByPath = new Map<string, string[]>()
    for (const e of entities) {
      if (isAnyDraftPath(normalizePath(e.path))) continue
      const declared = e.frontmatter.canonical_owner_path
      if (typeof declared !== "string" || declared.length === 0) continue
      const key = normalizePath(declared)
      const arr = claimantsByPath.get(key) ?? []
      arr.push(e.path)
      claimantsByPath.set(key, arr)
    }
    const duplicateCanonical: DuplicateCanonical[] = []
    for (const [canonicalOwnerPath, claimants] of claimantsByPath) {
      if (claimants.length > 1) duplicateCanonical.push({ canonicalOwnerPath, claimants })
    }

    // (7) deadSupersedes（F027 chunk B · wiki-memories-lint R3 搬来）
    // supersedes 指向的旧 path 必须仍在 entity 集合内（即使已 deprecated/归档）。
    const deadSupersedes: DeadSupersedes[] = []
    for (const e of entities) {
      const sup = e.frontmatter.supersedes
      if (!Array.isArray(sup) || sup.length === 0) continue
      const missing = sup
        .filter((p): p is string => typeof p === "string")
        .filter((p) => !allPaths.has(normalizePath(p)))
      if (missing.length > 0) deadSupersedes.push({ path: e.path, missing })
    }

    const report: HealthCheckReport = {
      scannedAt,
      totalEntities: entities.length,
      deadLinks,
      orphans,
      missingFrontmatter,
      canonicalOwnerDrift,
      draftExpired,
      duplicateCanonical,
      deadSupersedes,
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
        duplicateCanonical: duplicateCanonical.length,
        deadSupersedes: deadSupersedes.length,
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

/**
 * 范-r1 P2-2: 区分 active draft（应做 TTL）vs 已归档/隔离 draft（跳过 TTL）。
 *   - active：top-level draft + _backfill + _auto + 其他常规 draft 子目录
 *   - non-active：_expired (已归档) + _quarantined (sanitize 隔离)
 */
function isActiveDraftPath(normalizedPath: string): boolean {
  if (!normalizedPath.includes("/draft/")) return false
  if (normalizedPath.includes("/draft/_expired/")) return false
  if (normalizedPath.includes("/draft/_quarantined/")) return false
  return true
}

/** 任何 /draft/ 路径（含 _expired / _quarantined）— 用于 orphan 豁免（已归档也不应被引用）。 */
function isAnyDraftPath(normalizedPath: string): boolean {
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

/**
 * 范-r1 P1: extracted ref 区分 wikilink (raw target text) vs rellink (已解析 path-style)。
 * caller 路径根据 kind 选 resolver vs 直接对比。
 */
type ExtractedRef =
  | { kind: "wikilink"; target: string } // raw text inside [[...]]; e.g. "Concept Name|alias" or "wiki/concepts/foo"
  | { kind: "rellink"; target: string } // resolved path-style; e.g. "wiki/concepts/foo.md"

function extractRefs(body: string, fromPath: string): ExtractedRef[] {
  const refs: ExtractedRef[] = []
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].trim()
    refs.push({ kind: "wikilink", target })
  }
  for (const m of body.matchAll(RELLINK_RE)) {
    const raw = m[0].slice(1, -1) // strip ( )
    const fromDir = path.posix.dirname(normalizePath(fromPath))
    const resolved = path.posix.normalize(path.posix.join(fromDir, raw))
    refs.push({ kind: "rellink", target: resolved })
  }
  return refs
}

/**
 * 范-r1 P1 default no-resolver path-detection：true = target 形如 fs path
 * （可直接当 entity.path 对比）；false = name-style，需 resolver。
 */
function looksLikePath(target: string): boolean {
  // 含 '/' 或以 .md 结尾 → path-style
  if (target.includes("/")) return true
  if (target.endsWith(".md")) return true
  return false
}
