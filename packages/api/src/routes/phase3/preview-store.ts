/**
 * F027 Phase 3 P20 · PreviewStore — Week 2 Day 9-10 (AC-P3-10)
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 2 Day 9-10
 *   + contracts.ts §4 PreviewIngestResponse / §7 PostIngestCommitBody
 *
 * 职责：把 Day 5 ingest preview 的产物（previewId, sanitizedContent, sourcePath, etc.）
 * 暂存内存，等 Day 9-10 commit endpoint 凭 previewId 取出落盘到真 wiki。
 *
 * 设计：
 *   - in-memory Map<previewId, PreviewStoreEntry>（单进程 API server；restart 丢未消费 preview）
 *   - put(): IngestPreviewService 在 preview() 成功后调
 *   - take(): IngestCommitService 在 commit() 时调，**一次性消费**（读 + 删）
 *   - prune(): 定期清理过期 entries（commit 时也会顺手 prune 自己条目）
 *
 * 不做（Day 9-10 范围外）：
 *   - 不持久化到 SQLite（preview 寿命 10 min，重启丢失可接受）
 *   - 不做 quota（单 alias 缓 N 条）—— Phase 4 加 nightly purge job
 *   - 不做 race 防护（commit 路径单线程；多 instance 部署需要换 SQLite 表）
 */

export interface PreviewStoreEntry {
  previewId: string
  /** 原始 source path (e.g., 'concepts/foo.md' 或 'raw/conversations/2026-05-20-chat.md') */
  sourcePath: string
  /** sanitize 后的纯文本内容（落盘内容来自这里） */
  sanitizedContent: string
  /** caller 在 preview 时指定的 mimeType（commit 时用作 audit metadata） */
  mimeType: string
  /** caller 可选的 targetType (feature/bug/lesson/concept) */
  targetType?: string
  /** preview 创建时刻 ISO */
  createdAt: string
  /** preview 过期时刻 ISO（< now 时 take 返 null + 自动剔除） */
  expiresAt: string
}

export interface PreviewStoreDeps {
  /** 注入 clock（测试用 deterministic 过期；默认 () => new Date()） */
  clock?: () => Date
}

export class PreviewStore {
  private readonly entries = new Map<string, PreviewStoreEntry>()
  private readonly clock: () => Date

  constructor(deps: PreviewStoreDeps = {}) {
    this.clock = deps.clock ?? (() => new Date())
  }

  /**
   * 写入一个 preview entry。
   * 重复 previewId 会覆盖（一般不会发生 — UUID 碰撞概率极小）。
   */
  put(entry: PreviewStoreEntry): void {
    this.entries.set(entry.previewId, entry)
  }

  /**
   * 取出 preview entry，**同时从 store 删除**（一次性消费）。
   *
   * 返回 null 表示：
   *   - previewId 不存在（commit endpoint → DRAFT_NOT_FOUND 404）
   *   - 已过期（commit endpoint → DRAFT_NOT_FOUND 404 + detail.reason='preview_expired'）
   *
   * 不区分两种 not-found 的设计原因：DRAFT_NOT_FOUND 已含 "preview/draft not found" 语义，
   * caller 不需要区分；过期 entry 顺手剔除（防止内存泄漏）。
   */
  take(
    previewId: string,
  ): { entry: PreviewStoreEntry; reason: "ok" } | { entry: null; reason: "not_found" | "expired" } {
    const e = this.entries.get(previewId)
    if (!e) return { entry: null, reason: "not_found" }
    this.entries.delete(previewId)
    const now = this.clock().getTime()
    if (new Date(e.expiresAt).getTime() <= now) {
      return { entry: null, reason: "expired" }
    }
    return { entry: e, reason: "ok" }
  }

  /**
   * 清理所有过期 entry（caller 可定期调，或 commit 路径顺手清）。
   * 返回清理掉的 entry 数。
   */
  prune(): number {
    const now = this.clock().getTime()
    let removed = 0
    for (const [id, e] of this.entries) {
      if (new Date(e.expiresAt).getTime() <= now) {
        this.entries.delete(id)
        removed++
      }
    }
    return removed
  }

  /** 当前 store 大小（debug / health-check 用）。 */
  size(): number {
    return this.entries.size
  }
}
