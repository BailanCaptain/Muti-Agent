/**
 * F027 P19.15 · WikiCompilerDebounce (事件驱动 — 非 cron)
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-17 + V16.5 chap 2
 * line 219（程序编派生视图 index.md / sources.md / log.md）
 *
 * 职责：每次写 wiki_events 后启 5s debounce；5s 内无新写 → 触发派生视图重生成
 *   （区别于 cron job — 这是 11 jobs 里 2 个 event-driven 之一，配 ChainedAlertNotifier）。
 *   连续写 burst 收敛成 1 次重编（防每条 event 都全量重编派生视图）。
 *
 * 职责（Day 18 debounce 逻辑壳；recompile 由 caller 注入）：
 *   - onWikiEvent() — 每次 wiki_events 写调一次，重置 debounce 计时
 *   - 5s idle → recompileDerivedViews()
 *   - reentrancy guard：recompile 进行中又来 event → 标记 pending，本轮完后补跑
 *   - flush() — 立即跑（shutdown / 测试用）
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export interface WikiCompilerDebounceOptions {
  /** Caller-injected: 实际派生视图重生成（index/sources/log 等程序编）。 */
  recompileDerivedViews: () => Promise<void>
  /** Debounce 延迟 ms；默认 5000（写后 5s — AC-P2-17）。 */
  debounceMs?: number
  logger?: FastifyBaseLogger
}

export class WikiCompilerDebounce {
  private readonly recompile: () => Promise<void>
  private readonly debounceMs: number
  private readonly log: FastifyBaseLogger

  private debounceTimer: NodeJS.Timeout | null = null
  private running = false
  /** recompile 进行中收到新 event → 标记本轮后补跑。 */
  private pendingAfterRun = false
  private stopped = false

  constructor(opts: WikiCompilerDebounceOptions) {
    this.recompile = opts.recompileDerivedViews
    this.debounceMs = opts.debounceMs ?? 5000
    this.log = opts.logger ?? createLogger("wiki-compiler-debounce")
  }

  /**
   * 每次 wiki_events 写后调。重置 debounce 计时；debounceMs 内无新调用 →
   * 触发 recompile。burst 收敛成 1 次。
   */
  onWikiEvent(): void {
    if (this.stopped) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.fire()
    }, this.debounceMs)
    this.debounceTimer.unref?.()
  }

  /** 立即触发待跑的 recompile（shutdown / 测试）。无 pending 则 noop。 */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    await this.fire()
  }

  /** 停止 — 清 pending timer，不再接受 onWikiEvent。 */
  stop(): void {
    this.stopped = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  /** 当前是否有 recompile 在跑（调试用）。 */
  isRunning(): boolean {
    return this.running
  }

  // ── private ──────────────────────────────────────────────────────────

  private async fire(): Promise<void> {
    // reentrancy guard：上一轮 recompile 还在跑 → 标记 pending，本轮完后补跑
    if (this.running) {
      this.pendingAfterRun = true
      return
    }
    this.running = true
    try {
      await this.recompile()
    } catch (err) {
      this.log.error({ err }, "recompileDerivedViews threw (caught)")
    } finally {
      this.running = false
    }
    // 本轮跑期间又有 event → 补跑一次（收敛 reentrancy 期间的所有 event 为 1 次）
    if (this.pendingAfterRun) {
      this.pendingAfterRun = false
      await this.fire()
    }
  }
}
