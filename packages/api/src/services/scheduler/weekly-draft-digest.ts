/**
 * F027 P19.10 · WeeklyDraftDigest (cron 0 9 * * 1 Asia/Shanghai, target R-201)
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-12 + V16.5 chap 17
 * line 1807 + line 2676（"只有 user-drop 主流 draft（顶层文件）进 WeeklyDraftDigest
 * 推送队列——保证小孙审批信号干净"）
 *
 * 职责：每周一 9:00 把 **user-drop 顶层 draft** 汇总成 digest 推 R-201。
 *
 * 关键约束（保证审批信号干净）：
 *   - **只推 user-drop 主流 draft**（`wiki/concepts/draft/<file>.md` 顶层文件）
 *   - 4 类子目录 draft **不推**：
 *     - `_auto/`        — cron docs-watcher 增量
 *     - `_backfill/`    — P19.7.5 一次性 backfill
 *     - `_quarantined/` — 5 层 sanitize 命中 chained_suspect
 *     - `_expired/`     — 30 天未 promote 自动归档
 *
 * 职责（Day 12 digest 逻辑壳；scan/push 由 caller 注入）：
 *   - scanDrafts() 返全部 draft entities
 *   - pushDigest(digest) 推 R-201（caller 串 room API）
 *   - 本类不读 fs / 不发 room message；纯逻辑可单测
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export interface DraftEntry {
  /** Repo-relative path，如 wiki/concepts/draft/2026-05-09-rag.md。 */
  path: string
  /** 可选标题（digest 展示用）。 */
  title?: string
  /** 可选 ISO 创建时刻。 */
  createdAt?: string
}

export interface DraftDigest {
  generatedAt: string
  /** 只含 user-drop 顶层 draft。 */
  userDropDrafts: DraftEntry[]
  /** 被过滤掉的子目录 draft 数（_auto/_backfill/_quarantined/_expired）。 */
  skippedSubdirDrafts: number
  /** 被过滤掉的非 draft 路径数（防御 — scanDrafts 理应只返 draft）。 */
  skippedNonDraft: number
}

export interface WeeklyDraftDigestOptions {
  /** Caller-injected scanner; 返全部 draft entities snapshot。 */
  scanDrafts: () => Promise<DraftEntry[]>
  /**
   * Caller-injected pusher; 推 digest 到 R-201。
   * 不注入时 digest 仅返回不推（dry-run / 测试模式）。
   */
  pushDigest?: (digest: DraftDigest) => Promise<void>
  /** Inject clock (testing); 默认 () => new Date()。 */
  clock?: () => Date
  logger?: FastifyBaseLogger
}

export class WeeklyDraftDigest {
  private readonly opts: WeeklyDraftDigestOptions
  private readonly log: FastifyBaseLogger
  private readonly clock: () => Date

  constructor(opts: WeeklyDraftDigestOptions) {
    this.opts = opts
    this.log = opts.logger ?? createLogger("weekly-draft-digest")
    this.clock = opts.clock ?? (() => new Date())
  }

  async run(): Promise<DraftDigest> {
    const all = await this.opts.scanDrafts()
    const userDropDrafts: DraftEntry[] = []
    let skippedSubdirDrafts = 0
    let skippedNonDraft = 0

    for (const draft of all) {
      const cls = classifyDraftPath(draft.path)
      if (cls === "user-drop") {
        userDropDrafts.push(draft)
      } else if (cls === "subdir") {
        skippedSubdirDrafts += 1
      } else {
        skippedNonDraft += 1
      }
    }

    const digest: DraftDigest = {
      generatedAt: this.clock().toISOString(),
      userDropDrafts,
      skippedSubdirDrafts,
      skippedNonDraft,
    }

    if (this.opts.pushDigest) {
      try {
        await this.opts.pushDigest(digest)
      } catch (err) {
        this.log.warn({ err }, "pushDigest threw (ignored — digest still returned)")
      }
    }

    this.log.info(
      {
        userDrop: userDropDrafts.length,
        skippedSubdir: skippedSubdirDrafts,
        skippedNonDraft,
      },
      "weekly draft digest done",
    )
    return digest
  }
}

export type DraftPathClass = "user-drop" | "subdir" | "non-draft"

/**
 * 分类 draft path：
 *   - 'user-drop'  — `.../draft/<file>.md`（draft/ 下直接文件，无子目录）
 *   - 'subdir'     — `.../draft/_auto|_backfill|_quarantined|_expired|.../<file>.md`
 *   - 'non-draft'  — path 不含 `/draft/`
 */
export function classifyDraftPath(rawPath: string): DraftPathClass {
  const p = rawPath.replace(/\\/g, "/")
  const marker = "/draft/"
  const idx = p.indexOf(marker)
  if (idx === -1) return "non-draft"
  const tail = p.slice(idx + marker.length)
  // tail 含 '/' → draft/ 下还有子目录 → subdir draft
  if (tail.includes("/")) return "subdir"
  return "user-drop"
}
