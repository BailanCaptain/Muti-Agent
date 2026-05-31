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
  /**
   * F027 P4 Day 10 AC-P4-3 e · seriesId (防 chained 误检)。
   * preview 时 caller 传入 → store 保留 → commit 时落盘 frontmatter `series_id: <id>`。
   */
  seriesId?: string
  /** preview 创建时刻 ISO */
  createdAt: string
  /** preview 过期时刻 ISO（< now 时 take 返 null + 自动剔除） */
  expiresAt: string
  /**
   * F027 v3 G11 · LLM 编译后的完整 markdown（frontmatter + body）。
   * preview 编译成功 → 存编译产物；commit 落盘写这个（含 cross_refs/dedup/canonical_owner）。
   * 未注入 compile deps / 编译失败兜底 → 缺省，commit 退回写 sanitizedContent。
   */
  compiledMarkdown?: string
  /**
   * F027 AC-P1-5 · multi-drop 关联用：preview 时算好的 embedding + 投稿人 + ingest 时刻，
   * commit 成功后写 recent_drops（避免 commit 再 embed 一次）。缺省 = 未接 correlate deps。
   */
  embedding?: number[]
  contributedBy?: string
  ingestedAt?: number
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
   * 读 preview entry **不删除**（Week 2 r2 范-r1 P3 引入）。
   *
   * 用于 commit endpoint: peek → updateWiki(可能失败) → ok 才 consume(remove)。
   * 瞬时失败（CAS conflict / lease_held / internal）后用户可重试同 previewId
   * 而不必重 preview/sanitize。
   *
   * 过期 entry 顺手剔除（与 take 一致语义，防内存泄漏）。
   */
  peek(
    previewId: string,
  ): { entry: PreviewStoreEntry; reason: "ok" } | { entry: null; reason: "not_found" | "expired" } {
    const e = this.entries.get(previewId)
    if (!e) return { entry: null, reason: "not_found" }
    const now = this.clock().getTime()
    if (new Date(e.expiresAt).getTime() <= now) {
      this.entries.delete(previewId) // 过期顺手剔除
      return { entry: null, reason: "expired" }
    }
    return { entry: e, reason: "ok" }
  }

  /**
   * 显式删除 entry（Week 2 r2 范-r1 P3 引入）。
   *
   * 用于 commit endpoint 在 updateWiki 成功后 / 不可恢复终态时（denied_acl / path_invalid）
   * 主动消费 preview。返回 true = 真删；false = entry 不存在（重复 consume 是 idempotent）。
   */
  consume(previewId: string): boolean {
    return this.entries.delete(previewId)
  }

  /**
   * **DEPRECATED** since Week 2 r2 — 用 peek + consume 取代。
   *
   * 保留是为了 Day 9-10 老测试 + caller 仍按"一次性消费"语义的兼容；
   * 新代码应该 peek 后 commit 成功才 consume，瞬时失败保留 preview 让用户重试。
   */
  take(
    previewId: string,
  ): { entry: PreviewStoreEntry; reason: "ok" } | { entry: null; reason: "not_found" | "expired" } {
    const r = this.peek(previewId)
    if (r.reason === "ok") this.consume(previewId)
    return r
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
