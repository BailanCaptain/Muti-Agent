/**
 * F027 P19.1 + P19.2 · NightlyJobScheduler — 框架 + lease guard hook
 *
 * 范围：
 *   - register(spec) — start 前注册 job（pattern + handler）
 *   - start() — 用 croner 物化所有已注册 spec，idempotent
 *   - stop() — 停所有 cron，idempotent
 *   - health() — { running, startedAt, jobs[ {name, pattern, nextRun} ] }
 *   - guard hook（P19.2）：每次 cron 触发前问 guard()，非 null 则 skip + onSkip 通知
 *
 * 不做（推后）：
 *   - 直接耦合 SchedulerLeader → caller 用 `guard: () => leader.shouldSkipJob()`
 *   - ConfigLoader（wiki.config.yaml fallback）→ P19.3a Day 3
 *   - job_trace 落盘 → P19.4 Day 3（onSkip 暴露 hook）
 *   - 真 jobs 注册（NightlyHealthCheck / Vacuum / ...）→ Week 2-4
 *   - reentrancy long-run skip policy → P19.6 RoomCompilerTick（更细 guard）
 *
 * croner 内置 protect:true 已防同一 job 上一次未跑完时跳过；handler 错误用
 * catch:fn 捕获不打断调度器。tz 默认 Asia/Shanghai（plan §5 Open#5）。
 */

import { Cron } from "croner"
import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export interface JobSpec {
  /** Unique job name. 注册重复抛错。 */
  name: string
  /** croner 兼容的 cron 表达式（5/6/7-part）。 */
  cron: string
  /** 可选；不填走 scheduler 默认 tz。 */
  timezone?: string
  /** Job 主体；同步或 Promise 都允许。 */
  handler: () => Promise<void> | void
}

export interface SchedulerJobView {
  name: string
  pattern: string
  /** ISO timestamp；未启动或已停 → null。 */
  nextRun: string | null
}

export interface SchedulerHealth {
  running: boolean
  /** 启动时间 ISO；stop 后清空。 */
  startedAt: string | null
  jobs: SchedulerJobView[]
}

export interface NightlyJobSchedulerOptions {
  logger?: FastifyBaseLogger
  /** 默认时区；plan §5 Open#5：Asia/Shanghai。 */
  defaultTimezone?: string
  /**
   * P19.2 lease guard hook。每次 cron 触发先问；返非 null 则 skip 并触发 onSkip。
   * 默认 `() => null`（无 guard，job 每次都跑）。
   * 生产用法：`guard: () => schedulerLeader.shouldSkipJob()`
   */
  guard?: () => string | null
  /**
   * P19.2 + P19.4 hook：guard 触发 skip 时回调。Day 2 仅 log；Day 3 P19.4 在此写
   * job_trace（status='skipped_not_leader' + reason=guard 返回值）。
   */
  onSkip?: (jobName: string, reason: string) => void
}

export class NightlyJobScheduler {
  private readonly log: FastifyBaseLogger
  private readonly defaultTimezone: string
  private readonly guard: () => string | null
  private readonly onSkip?: (jobName: string, reason: string) => void
  private readonly specs = new Map<string, JobSpec>()
  private readonly jobs = new Map<string, Cron>()
  private startedAt: string | null = null

  constructor(options: NightlyJobSchedulerOptions = {}) {
    this.log = options.logger ?? createLogger("nightly-job-scheduler")
    this.defaultTimezone = options.defaultTimezone ?? "Asia/Shanghai"
    this.guard = options.guard ?? (() => null)
    this.onSkip = options.onSkip
  }

  register(spec: JobSpec): void {
    if (this.startedAt !== null) {
      throw new Error(
        `[NightlyJobScheduler] cannot register '${spec.name}' after start(); call stop() first`,
      )
    }
    if (this.specs.has(spec.name)) {
      throw new Error(`[NightlyJobScheduler] duplicate job name '${spec.name}'`)
    }
    this.specs.set(spec.name, { ...spec })
  }

  start(): void {
    if (this.startedAt !== null) {
      this.log.debug({ jobs: this.jobs.size }, "scheduler already running, start() noop")
      return
    }
    const startedAt = new Date().toISOString()

    for (const spec of this.specs.values()) {
      const job = new Cron(
        spec.cron,
        {
          name: spec.name,
          timezone: spec.timezone ?? this.defaultTimezone,
          protect: true,
          catch: (err, cronJob) => {
            this.log.error(
              { err, jobName: cronJob.name },
              "scheduled job threw (caught by croner)",
            )
          },
        },
        async () => {
          // P19.2 lease guard — 三段 guard 任一失败 → skip
          let skipReason: string | null = null
          try {
            skipReason = this.guard()
          } catch (err) {
            this.log.error({ err, jobName: spec.name }, "guard threw; treating as skip")
            skipReason = "guard_error"
          }
          if (skipReason !== null) {
            this.log.warn({ jobName: spec.name, reason: skipReason }, "job skipped by guard")
            if (this.onSkip) {
              try {
                this.onSkip(spec.name, skipReason)
              } catch (err) {
                this.log.warn({ err }, "onSkip threw (ignored)")
              }
            }
            return
          }
          try {
            await spec.handler()
          } catch (err) {
            // catch:fn 已兜了；这里防御性兜底（异步 handler 罕见漏网路径）。
            this.log.error({ err, jobName: spec.name }, "handler async error fallthrough")
          }
        },
      )
      this.jobs.set(spec.name, job)
    }

    this.startedAt = startedAt
    this.log.info(
      { jobs: this.jobs.size, startedAt, tz: this.defaultTimezone },
      "scheduler started",
    )
  }

  stop(): void {
    if (this.startedAt === null) {
      this.log.debug("scheduler not running, stop() noop")
      return
    }
    for (const [name, job] of this.jobs) {
      try {
        job.stop()
      } catch (err) {
        this.log.warn({ err, name }, "error stopping job (ignored)")
      }
    }
    const stoppedCount = this.jobs.size
    this.jobs.clear()
    this.startedAt = null
    this.log.info({ stoppedCount }, "scheduler stopped")
  }

  health(): SchedulerHealth {
    const running = this.startedAt !== null
    const jobs: SchedulerJobView[] = []
    for (const spec of this.specs.values()) {
      const job = this.jobs.get(spec.name) ?? null
      const nextDate = running && job ? job.nextRun() : null
      jobs.push({
        name: spec.name,
        pattern: spec.cron,
        nextRun: nextDate ? nextDate.toISOString() : null,
      })
    }
    return { running, startedAt: this.startedAt, jobs }
  }
}
