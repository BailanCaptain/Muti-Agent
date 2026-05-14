/**
 * F027 P19.6 · RoomCompilerTick — 5min + idle 30min + reentrancy guard
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-6
 *
 * 职责（Day 5 scheduling 壳；实际 compile 由 injected executor 执行）：
 *   - cron "*\/5 * * * *" 每 5min 触发 tick(scheduledFor)
 *   - 长跑 vs tick 撞调度：上次 tick 仍在跑（inProgress=true）→ 本次 skip
 *     + 落 trace status='skipped_reentry'
 *   - missed window：cron 在 windowEnd 之前未触发（runtime crash / event loop
 *     阻塞 / 长跑 job 阻塞）→ skip + 落 trace status='missed_window'，不补跑
 *   - idle 30min：辅助 isIdle() 判断；默认 30min 未成功 = idle，可由 caller
 *     用来决定要不要"不论事件触发"也来一次维护 sweep（caller 决定 cron 触发
 *     频率，本类只暴露状态）
 *
 * 不做：
 *   - 不实现 room 编译本体（compileExecutor 由调用方注入）
 *   - 不直接落 trace 文件（onTrace 回调暴露 hook；实际 writeJobTrace 由
 *     scheduler-runtime 集成层调用，保持本类纯逻辑可测）
 *   - 不依赖 NightlyJobScheduler / SchedulerLeader（caller 在 job handler 里
 *     `await tick.tick(scheduledFor)`；leader guard 由 scheduler.guard 已挡）
 *
 * 时间窗语义（plan §4）：
 *   windowStart = scheduledFor
 *   windowEnd   = scheduledFor + windowMinutes (默认 5min)
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"
import {
  JOB_TRACE_SCHEMA_VERSION,
  type JobTrace,
  type JobTraceStatus,
  newRunId,
} from "./job-trace"

export type CompileExecutorResult = {
  /** 0 = idle（无 room 需要编译）；> 0 = 处理了 N 个 room。 */
  roomsProcessed: number
}

export interface RoomCompilerTickOptions {
  /**
   * 注入的实际 compile 函数。返回 roomsProcessed=0 表示 idle。
   * 抛错 → tick 落 trace status='failed'。
   */
  compileExecutor: () => Promise<CompileExecutorResult>
  /** Window 长度分钟数；默认 5（与 cron "*\/5 * * * *" 周期匹配）。 */
  windowMinutes?: number
  /** Idle 阈值分钟数；isIdle() 用；默认 30。 */
  idleThresholdMinutes?: number
  /** trace 回调；caller 转 writeJobTrace。 */
  onTrace?: (trace: JobTrace) => void
  /** 注入时钟（测试用）；默认 () => new Date()。 */
  clock?: () => Date
  logger?: FastifyBaseLogger
  /** Job 名；落 trace 用；默认 'room-compiler-tick'。 */
  jobName?: string
  /** 当前 leaderTerm，落 trace 用；默认 null。 */
  leaderTerm?: string | null
}

export type TickOutcome =
  | { status: "ok"; roomsProcessed: number; durationMs: number; trace: JobTrace }
  | { status: "skipped_reentry"; trace: JobTrace }
  | { status: "missed_window"; trace: JobTrace }
  | { status: "failed"; error: string; trace: JobTrace }

export class RoomCompilerTick {
  private readonly executor: () => Promise<CompileExecutorResult>
  private readonly windowMinutes: number
  private readonly idleThresholdMinutes: number
  private readonly onTrace?: (trace: JobTrace) => void
  private readonly clock: () => Date
  private readonly log: FastifyBaseLogger
  private readonly jobName: string
  private readonly leaderTerm: string | null

  private inProgress = false
  private lastSuccessAt: Date | null = null

  constructor(opts: RoomCompilerTickOptions) {
    this.executor = opts.compileExecutor
    this.windowMinutes = opts.windowMinutes ?? 5
    this.idleThresholdMinutes = opts.idleThresholdMinutes ?? 30
    this.onTrace = opts.onTrace
    this.clock = opts.clock ?? (() => new Date())
    this.jobName = opts.jobName ?? "room-compiler-tick"
    this.leaderTerm = opts.leaderTerm ?? null
    this.log = opts.logger ?? createLogger(this.jobName)
  }

  /**
   * 主入口。caller 在 cron handler 里 await。返回 outcome（含 trace）。
   *
   * 顺序：
   *   1. missed window check（now > windowEnd）→ skip + 'missed_window'
   *   2. reentrancy check（inProgress=true）→ skip + 'skipped_reentry'
   *   3. 跑 executor → 'ok' / 'failed'
   *
   * inProgress 在 finally 里复位（异常路径也复位，防 zombie lock）。
   */
  async tick(scheduledFor: Date): Promise<TickOutcome> {
    const now = this.clock()
    const windowStart = scheduledFor
    const windowEnd = new Date(scheduledFor.getTime() + this.windowMinutes * 60_000)

    // (1) missed window
    if (now.getTime() > windowEnd.getTime()) {
      const trace = this.makeTrace({
        scheduledFor,
        windowStart,
        windowEnd,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        status: "missed_window",
      })
      this.log.warn(
        { scheduledFor: scheduledFor.toISOString(), windowEnd: windowEnd.toISOString() },
        "tick missed window — skipping per skip policy",
      )
      this.emitTrace(trace)
      return { status: "missed_window", trace }
    }

    // (2) reentrancy
    if (this.inProgress) {
      const trace = this.makeTrace({
        scheduledFor,
        windowStart,
        windowEnd,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        status: "skipped_reentry",
      })
      this.log.warn(
        { scheduledFor: scheduledFor.toISOString() },
        "tick skipped — previous tick still in progress",
      )
      this.emitTrace(trace)
      return { status: "skipped_reentry", trace }
    }

    // (3) run
    this.inProgress = true
    const startedAt = this.clock()
    try {
      const result = await this.executor()
      const finishedAt = this.clock()
      const durationMs = finishedAt.getTime() - startedAt.getTime()
      this.lastSuccessAt = finishedAt
      const trace = this.makeTrace({
        scheduledFor,
        windowStart,
        windowEnd,
        startedAt,
        finishedAt,
        durationMs,
        status: "ok",
        result,
      })
      this.emitTrace(trace)
      return { status: "ok", roomsProcessed: result.roomsProcessed, durationMs, trace }
    } catch (err) {
      const finishedAt = this.clock()
      const durationMs = finishedAt.getTime() - startedAt.getTime()
      const error = err as Error
      const trace = this.makeTrace({
        scheduledFor,
        windowStart,
        windowEnd,
        startedAt,
        finishedAt,
        durationMs,
        status: "failed",
        error: { message: error.message, stack: error.stack },
      })
      this.log.error({ err }, "tick executor threw")
      this.emitTrace(trace)
      return { status: "failed", error: error.message, trace }
    } finally {
      this.inProgress = false
    }
  }

  /**
   * 上次 successful tick 距今超过 idleThresholdMinutes（默认 30）= idle。
   * 从未成功过也返 true（启动期）。
   *
   * 用法：caller 可调 isIdle() 决定要不要插入额外的"维护 sweep"（即使 cron
   * 周期内事件量 0 也跑一次，更新 lastSuccessAt 防 monitoring 误报 stuck）。
   */
  isIdle(now?: Date): boolean {
    const ref = now ?? this.clock()
    if (this.lastSuccessAt === null) return true
    return ref.getTime() - this.lastSuccessAt.getTime() >= this.idleThresholdMinutes * 60_000
  }

  /** 当前是否有 tick 正在跑（reentrancy 内部状态查询，调试用）。 */
  isInProgress(): boolean {
    return this.inProgress
  }

  /** 上次成功的 tick 完成时间；null = 从未成功。 */
  getLastSuccessAt(): Date | null {
    return this.lastSuccessAt
  }

  // ── private ────────────────────────────────────────────────────────────

  private makeTrace(input: {
    scheduledFor: Date
    windowStart: Date
    windowEnd: Date
    startedAt: Date | null
    finishedAt: Date | null
    durationMs: number | null
    status: JobTraceStatus
    result?: unknown
    error?: { message: string; stack?: string }
  }): JobTrace {
    return {
      schemaVersion: JOB_TRACE_SCHEMA_VERSION,
      jobName: this.jobName,
      runId: newRunId(),
      scheduledFor: input.scheduledFor.toISOString(),
      windowStart: input.windowStart.toISOString(),
      windowEnd: input.windowEnd.toISOString(),
      startedAt: input.startedAt ? input.startedAt.toISOString() : null,
      finishedAt: input.finishedAt ? input.finishedAt.toISOString() : null,
      durationMs: input.durationMs,
      status: input.status,
      leaderTerm: this.leaderTerm,
      reason: null,
      result: input.result ?? null,
      error: input.error ?? null,
      alertedRoom: null,
    }
  }

  private emitTrace(trace: JobTrace): void {
    if (!this.onTrace) return
    try {
      this.onTrace(trace)
    } catch (err) {
      this.log.warn({ err }, "onTrace threw (ignored)")
    }
  }
}
