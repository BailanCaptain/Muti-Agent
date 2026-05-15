/**
 * F027 P19.14 · ChainedAlertNotifier (事件驱动 — 非 cron)
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-16 + V16.5 chap
 * line 829 / 853 / 1657 / 1814（chained_suspect 命中推 room）
 *
 * 职责：5 层 sanitize 把某 drop 标记 chained_suspect 时，实时推 alert 到 R-201
 *   （区别于 cron job — 这是 11 jobs 里 2 个 event-driven 之一）。
 *
 * 职责（Day 17 notifier 逻辑壳；pushAlert 由 caller 注入）：
 *   - notify(event) — 收 chained_suspect 事件 → 构造 alert → pushAlert
 *   - dedup：同 draftPath 在 dedupWindowMs 内重复 → 只推 1 次（防 alert 风暴）
 *   - 本类不发 room message（caller 串 room API）；纯逻辑可单测
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export interface ChainedSuspectEvent {
  /** 被标记 chained_suspect 的 drop / draft 路径。 */
  draftPath: string
  /** 检出原因 / detail。 */
  reason: string
  /** 关联的其他 drop（"chain" 上的同伙）；可空。 */
  relatedPaths?: string[]
  /** 检出时刻 ISO；不填用 clock()。 */
  detectedAt?: string
}

export interface ChainedAlert {
  targetRoom: string
  draftPath: string
  reason: string
  relatedPaths: string[]
  alertedAt: string
}

export interface ChainedAlertNotifierOptions {
  /** Caller-injected: 推 alert 到 room。 */
  pushAlert: (alert: ChainedAlert) => Promise<void>
  /** 目标 room；默认 R-201（V16.5 chap 17 默认健康/告警 room）。 */
  targetRoom?: string
  /**
   * 去重窗口（ms）：同 draftPath 在此窗口内重复 notify → 只推第一次。
   * 默认 0 = 不去重（每次 notify 都推）。
   */
  dedupWindowMs?: number
  /** Inject clock (testing); 默认 () => new Date()。 */
  clock?: () => Date
  logger?: FastifyBaseLogger
}

export interface NotifyResult {
  /** 是否真推了 alert。 */
  alerted: boolean
  /** 未推时的原因（如 deduped）。 */
  skipReason?: "deduped" | "push_failed"
}

export class ChainedAlertNotifier {
  private readonly pushAlert: (alert: ChainedAlert) => Promise<void>
  private readonly targetRoom: string
  private readonly dedupWindowMs: number
  private readonly clock: () => Date
  private readonly log: FastifyBaseLogger
  /** draftPath → 上次 alert 时刻 ms（dedup 用）。 */
  private readonly lastAlertAt = new Map<string, number>()

  constructor(opts: ChainedAlertNotifierOptions) {
    this.pushAlert = opts.pushAlert
    this.targetRoom = opts.targetRoom ?? "R-201"
    this.dedupWindowMs = opts.dedupWindowMs ?? 0
    this.clock = opts.clock ?? (() => new Date())
    this.log = opts.logger ?? createLogger("chained-alert-notifier")
  }

  /**
   * 收 chained_suspect 事件，推 alert（含 dedup）。
   * 返回 { alerted, skipReason? }。
   */
  async notify(event: ChainedSuspectEvent): Promise<NotifyResult> {
    const nowMs = this.clock().getTime()

    // dedup：同 draftPath 在窗口内重复 → skip
    if (this.dedupWindowMs > 0) {
      const last = this.lastAlertAt.get(event.draftPath)
      if (last !== undefined && nowMs - last < this.dedupWindowMs) {
        this.log.debug({ draftPath: event.draftPath }, "chained alert deduped")
        return { alerted: false, skipReason: "deduped" }
      }
    }

    const alert: ChainedAlert = {
      targetRoom: this.targetRoom,
      draftPath: event.draftPath,
      reason: event.reason,
      relatedPaths: event.relatedPaths ?? [],
      alertedAt: event.detectedAt ?? new Date(nowMs).toISOString(),
    }

    try {
      await this.pushAlert(alert)
    } catch (err) {
      this.log.error({ err, draftPath: event.draftPath }, "pushAlert failed")
      return { alerted: false, skipReason: "push_failed" }
    }

    // 仅在成功推送后记 dedup 时刻
    this.lastAlertAt.set(event.draftPath, nowMs)
    this.log.info(
      { draftPath: event.draftPath, targetRoom: this.targetRoom },
      "chained_suspect alert pushed",
    )
    return { alerted: true }
  }
}
