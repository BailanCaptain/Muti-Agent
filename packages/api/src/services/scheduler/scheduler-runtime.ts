/**
 * F027 P19.16 · SchedulerRuntime — 集成层（11 jobs 接进 scheduler + leader + trace）
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md §5 Day 21-22 整合 + AC-P2-1
 *
 * 职责（Week 4 整合 — 范在 Week 1/2/3 review 都接受延到此处补）：
 *   - 把 cron jobs 注册进 NightlyJobScheduler，每次触发包一层 job_trace 落盘
 *   - guard hook 接 SchedulerLeader.shouldSkipJob()：非 leader → skipped_not_leader
 *   - onGuardError → failed trace；timeout → timeout trace
 *   - startup jobs：runtime 起来后跑一次（受 leader guard 约束）
 *   - event-driven jobs（watcher / ChainedAlertNotifier / WikiCompilerDebounce）：
 *     **仅在 leader 上跑**（范-r2 P1-1）；follower→leader 提升时起，demote 时停
 *   - SchedulerRuntime 自己构造并持有 SchedulerLeader，装 onDemote /
 *     onAcquireAsFollower hook → 落 lease_lost / recovered_from_crash trace（范-r2 P2-1）
 *   - per-job reentrancy guard（范-r2 P1-2）：上一轮 ghost job 未结束 → 本轮
 *     skipped_reentry，绝不并发同名 job；timeout 时 abort signal 让合作型 job 早退
 *   - failed / timeout / recovered_from_crash / lease_lost 状态 trace 推 R-201
 *
 * 设计沿用 Phase 2 注入依赖范式：jobs 由 caller 构造好后以统一 run() 接口注入，
 *   本层不碰 fs/db（leaseRepo 由 caller 注入），纯 wiring + trace，可单测。
 *
 * 不做：
 *   - 不强杀 ghost job（JS promise 无法强杀）；timeout 后 abort signal 仅"请求"
 *     合作型 job 早退，不合作的 job 仍跑到自然结束 —— reentrancy guard 兜并发安全
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"
import type { CompilerLeaderRepository } from "../../db/repositories/compiler-leader-repository"
import {
  type JobTrace,
  type JobTraceReason,
  type JobTraceStatus,
  JOB_TRACE_REASON_VALUES,
  JOB_TRACE_SCHEMA_VERSION,
  newRunId,
  writeJobTrace,
} from "./job-trace"
import { NightlyJobScheduler, type JobContext } from "./nightly-job-scheduler"
import {
  SchedulerLeader,
  type DemoteReason,
  type LeaderLease,
} from "./scheduler-leader"

/** Job run() 的返回值；job 可自报 status（如 RoomCompilerTick 的 missed_window）。 */
export interface JobRunOutcome {
  /** 覆盖 trace status；默认 'ok'。 */
  status?: Extract<
    JobTraceStatus,
    "ok" | "missed_window" | "skipped_reentry" | "recovered_from_crash"
  >
  /** Job-specific 结果 payload，进 trace.result。 */
  result?: unknown
}

export interface CronJobRegistration {
  name: string
  /** croner cron 表达式。 */
  cron: string
  timezone?: string
  /** 默认 5。 */
  windowMinutes?: number
  /** 单次运行超时（秒）；超时 → trace status='timeout' + abort signal。 */
  timeoutSeconds: number
  /**
   * Job 主体；接 ctx + AbortSignal；返 outcome 或 void。
   * 长跑 job 应周期性检查 `signal.aborted` 以便 timeout 时早退。
   */
  run: (ctx: JobContext, signal: AbortSignal) => Promise<JobRunOutcome> | Promise<void>
}

export interface StartupJobRegistration {
  name: string
  timeoutSeconds: number
  run: (signal: AbortSignal) => Promise<JobRunOutcome> | Promise<void>
}

/** Watcher / ChainedAlertNotifier / WikiCompilerDebounce — 纯 lifecycle。 */
export interface EventDrivenJobRegistration {
  name: string
  start?: () => void | Promise<void>
  stop?: () => void | Promise<void>
}

export interface SchedulerRuntimeOptions {
  /** 本 runtime 实例 leader 别名（建议 `${hostname}-${pid}`）。 */
  leaderAlias: string
  /** Caller-injected: lease 仓储（SchedulerRuntime 内部据此构造 SchedulerLeader）。 */
  leaseRepo: CompilerLeaderRepository
  /** Lease TTL 秒；默认走 SchedulerLeader 默认 90。 */
  leaderTtlSeconds?: number
  /** Heartbeat 间隔 ms；默认走 SchedulerLeader 默认 30000。 */
  heartbeatIntervalMs?: number
  /** Follower poll 间隔 ms；默认走 SchedulerLeader 默认 60000。 */
  followerPollIntervalMs?: number
  cronJobs: CronJobRegistration[]
  startupJobs?: StartupJobRegistration[]
  eventDrivenJobs?: EventDrivenJobRegistration[]
  /** trace 落盘 root；默认 process.cwd()。 */
  rootDir?: string
  /** 默认时区；plan §5 Open#5：Asia/Shanghai。 */
  defaultTimezone?: string
  /** 注入时钟（测试用）；默认 () => new Date()。 */
  clock?: () => Date
  /** failed/timeout/... 告警目标 room；默认 R-201。 */
  alertRoom?: string
  /** 注入：推 trace 告警到 room。不传则只落盘不推。 */
  pushAlert?: (trace: JobTrace) => void | Promise<void>
  logger?: FastifyBaseLogger
}

/** timeout 专用错误，区分于 job 自身 throw。 */
export class JobTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`job exceeded timeout ${timeoutMs}ms`)
    this.name = "JobTimeoutError"
  }
}

/** failed/timeout/recovered_from_crash/lease_lost 推 R-201（plan §4）。 */
const ALERT_STATUSES: ReadonlySet<JobTraceStatus> = new Set<JobTraceStatus>([
  "failed",
  "timeout",
  "recovered_from_crash",
  "lease_lost",
])

/** leader 生命周期 trace（lease_lost / recovered_from_crash）的合成 jobName。 */
const LEADER_TRACE_JOB = "scheduler-leader"

export class SchedulerRuntime {
  private readonly log: FastifyBaseLogger
  private readonly leader: SchedulerLeader
  private readonly cronJobs: CronJobRegistration[]
  private readonly startupJobs: StartupJobRegistration[]
  private readonly eventDrivenJobs: EventDrivenJobRegistration[]
  private readonly rootDir: string
  private readonly defaultTimezone: string
  private readonly clock: () => Date
  private readonly alertRoom: string
  private readonly pushAlert?: (trace: JobTrace) => void | Promise<void>
  private readonly cronByName = new Map<string, CronJobRegistration>()
  private readonly scheduler: NightlyJobScheduler
  /** 范-r2 P1-2：当前真 job promise 未 settle 的 cron job 名（reentrancy guard）。 */
  private readonly runningJobs = new Set<string>()
  private started = false
  /** 范-r2 P1-1：event-driven jobs 是否已起（leader 上才起；幂等）。 */
  private eventDrivenStarted = false

  constructor(opts: SchedulerRuntimeOptions) {
    this.log = opts.logger ?? createLogger("scheduler-runtime")
    this.cronJobs = opts.cronJobs
    this.startupJobs = opts.startupJobs ?? []
    this.eventDrivenJobs = opts.eventDrivenJobs ?? []
    this.rootDir = opts.rootDir ?? process.cwd()
    this.defaultTimezone = opts.defaultTimezone ?? "Asia/Shanghai"
    this.clock = opts.clock ?? (() => new Date())
    this.alertRoom = opts.alertRoom ?? "R-201"
    this.pushAlert = opts.pushAlert
    for (const reg of this.cronJobs) {
      if (this.cronByName.has(reg.name)) {
        throw new Error(`SchedulerRuntime: duplicate cron job '${reg.name}'`)
      }
      this.cronByName.set(reg.name, reg)
    }
    // 范-r2 P2-1：SchedulerRuntime 自己构造并持有 leader，装生命周期 hook。
    this.leader = new SchedulerLeader({
      leaderAlias: opts.leaderAlias,
      leaseRepo: opts.leaseRepo,
      ttlSeconds: opts.leaderTtlSeconds,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      followerPollIntervalMs: opts.followerPollIntervalMs,
      clock: this.clock,
      logger: this.log,
      onDemote: (reason, prevLease) => this.onLeaderDemote(reason, prevLease),
      onAcquireAsFollower: (lease) => this.onLeaderTakeover(lease),
    })
    this.scheduler = new NightlyJobScheduler({
      logger: this.log,
      defaultTimezone: this.defaultTimezone,
      guard: () => this.leader.shouldSkipJob(),
      onSkip: (jobName, reason) => this.onJobSkipped(jobName, reason),
      onGuardError: (jobName, error) => this.onGuardError(jobName, error),
    })
  }

  /**
   * 起 leader + 注册并启动 cron jobs + 跑 startup jobs + （leader 才）起 event-driven jobs。
   * idempotent。
   */
  async start(): Promise<void> {
    if (this.started) {
      this.log.debug("SchedulerRuntime already started, start() noop")
      return
    }
    this.leader.start()

    for (const reg of this.cronJobs) {
      this.scheduler.register({
        name: reg.name,
        cron: reg.cron,
        timezone: reg.timezone,
        windowMinutes: reg.windowMinutes,
        handler: (ctx) => this.runCronJob(reg, ctx),
      })
    }
    this.scheduler.start()

    await this.runStartupJobs()

    // 范-r2 P1-1：event-driven jobs 只在 leader 上跑。起来即 leader → 现在起；
    // 起来是 follower → 不起，等 onLeaderTakeover 提升时再起。
    if (this.leader.getRole() === "leader") {
      await this.startEventDrivenJobs()
    } else {
      this.log.info("started as follower; event-driven jobs deferred until leadership")
    }

    this.started = true
    this.log.info(
      {
        cronJobs: this.cronJobs.length,
        startupJobs: this.startupJobs.length,
        eventDrivenJobs: this.eventDrivenJobs.length,
        role: this.leader.getRole(),
      },
      "SchedulerRuntime started",
    )
  }

  /** 停 scheduler + event-driven jobs + leader。idempotent。 */
  async stop(): Promise<void> {
    if (!this.started) return
    this.scheduler.stop()
    await this.stopEventDrivenJobs()
    this.leader.stop()
    this.started = false
    this.log.info("SchedulerRuntime stopped")
  }

  /** 委托 scheduler.health()（cron job 调度视图）。 */
  health() {
    return this.scheduler.health()
  }

  /** 当前 leader 角色（调试 / 测试用）。 */
  leaderRole() {
    return this.leader.getRole()
  }

  // ── private ──────────────────────────────────────────────────────────

  private async runCronJob(reg: CronJobRegistration, ctx: JobContext): Promise<void> {
    // 范-r2 P1-2 reentrancy guard：上一轮（含 timeout 后的 ghost job）真 job
    // promise 未 settle → 跳过本轮，落 skipped_reentry，绝不并发同名 job。
    if (this.runningJobs.has(reg.name)) {
      this.log.warn({ job: reg.name }, "job still running (ghost?), skipping reentry")
      await this.persistTrace(
        this.buildTrace({
          jobName: reg.name,
          runId: newRunId(),
          scheduledFor: ctx.scheduledFor,
          windowStart: ctx.windowStart,
          windowEnd: ctx.windowEnd,
          startedAt: null,
          finishedAt: null,
          status: "skipped_reentry",
          reason: null,
          result: null,
          error: null,
        }),
      )
      return
    }

    const runId = newRunId()
    const startedAt = this.clock()
    const controller = new AbortController()
    // 真 job promise 与 wrapper 解耦：timeout 后 ghost 仍在跑，runningJobs 标记
    // 直到真 promise settle 才解除 → ghost 期间下一轮触发被 reentry guard 挡。
    const jobPromise = Promise.resolve(reg.run(ctx, controller.signal))
    this.runningJobs.add(reg.name)
    void jobPromise
      .catch(() => {}) // ghost rejection 已被 withTimeout 消费；此处仅防 unhandled
      .finally(() => this.runningJobs.delete(reg.name))

    let status: JobTraceStatus = "ok"
    let result: unknown = null
    let error: { message: string; stack?: string } | null = null
    try {
      const outcome = (await this.withTimeout(jobPromise, reg.timeoutSeconds * 1000)) as
        | JobRunOutcome
        | undefined
      if (outcome?.status) status = outcome.status
      result = outcome?.result ?? null
    } catch (err) {
      const e = err as Error
      if (err instanceof JobTimeoutError) {
        status = "timeout"
        // 范-r2 P1-2：超时 → abort signal，让合作型 job 早退（不合作的仍 ghost，
        // 但 reentry guard 兜并发安全）。
        controller.abort()
      } else {
        status = "failed"
      }
      error = { message: e.message, stack: e.stack }
    }
    const finishedAt = this.clock()
    await this.persistTrace(
      this.buildTrace({
        jobName: reg.name,
        runId,
        scheduledFor: ctx.scheduledFor,
        windowStart: ctx.windowStart,
        windowEnd: ctx.windowEnd,
        startedAt,
        finishedAt,
        status,
        reason: null,
        result,
        error,
      }),
    )
  }

  private async runStartupJobs(): Promise<void> {
    if (this.startupJobs.length === 0) return
    const skip = this.leader.shouldSkipJob()
    for (const reg of this.startupJobs) {
      const runId = newRunId()
      const scheduledFor = this.clock()
      if (skip !== null) {
        // 非 leader → 不跑 startup job，落 skipped_not_leader trace
        await this.persistTrace(
          this.buildTrace({
            jobName: reg.name,
            runId,
            scheduledFor,
            windowStart: scheduledFor,
            windowEnd: scheduledFor,
            startedAt: null,
            finishedAt: null,
            status: "skipped_not_leader",
            reason: this.toTraceReason(skip),
            result: null,
            error: null,
          }),
        )
        continue
      }
      const startedAt = this.clock()
      const controller = new AbortController()
      let status: JobTraceStatus = "ok"
      let result: unknown = null
      let error: { message: string; stack?: string } | null = null
      try {
        const outcome = (await this.withTimeout(
          Promise.resolve(reg.run(controller.signal)),
          reg.timeoutSeconds * 1000,
        )) as JobRunOutcome | undefined
        if (outcome?.status) status = outcome.status
        result = outcome?.result ?? null
      } catch (err) {
        const e = err as Error
        if (err instanceof JobTimeoutError) {
          status = "timeout"
          controller.abort()
        } else {
          status = "failed"
        }
        error = { message: e.message, stack: e.stack }
      }
      const finishedAt = this.clock()
      await this.persistTrace(
        this.buildTrace({
          jobName: reg.name,
          runId,
          scheduledFor,
          windowStart: scheduledFor,
          windowEnd: scheduledFor,
          startedAt,
          finishedAt,
          status,
          reason: null,
          result,
          error,
        }),
      )
    }
  }

  /** 起 event-driven jobs（leader 才调；幂等）。 */
  private async startEventDrivenJobs(): Promise<void> {
    if (this.eventDrivenStarted) return
    this.eventDrivenStarted = true
    for (const reg of this.eventDrivenJobs) {
      if (!reg.start) continue
      try {
        await reg.start()
      } catch (err) {
        this.log.error({ err, job: reg.name }, "event-driven job start() threw")
      }
    }
  }

  /** 停 event-driven jobs（demote / runtime stop 时调；幂等）。 */
  private async stopEventDrivenJobs(): Promise<void> {
    if (!this.eventDrivenStarted) return
    this.eventDrivenStarted = false
    for (const reg of this.eventDrivenJobs) {
      if (!reg.stop) continue
      try {
        await reg.stop()
      } catch (err) {
        this.log.warn({ err, job: reg.name }, "event-driven job stop() threw (ignored)")
      }
    }
  }

  /**
   * 范-r2 P2-1：follower → leader 提升（crash recovery）。
   * 落 recovered_from_crash trace + 起 event-driven jobs。
   */
  private onLeaderTakeover(lease: LeaderLease): void {
    this.log.info({ term: lease.currentTerm }, "took over leadership (crash recovery)")
    const now = this.clock()
    void this.persistTrace(
      this.buildTrace({
        jobName: LEADER_TRACE_JOB,
        runId: newRunId(),
        scheduledFor: now,
        windowStart: now,
        windowEnd: now,
        startedAt: null,
        finishedAt: null,
        status: "recovered_from_crash",
        reason: null,
        result: { acquiredTerm: lease.currentTerm },
        error: null,
        leaderTerm: lease.currentTerm,
      }),
    )
    void this.startEventDrivenJobs()
  }

  /**
   * 范-r2 P2-1：leader → demoted（heartbeat 失败）。
   * 落 lease_lost trace + 停 event-driven jobs。
   * 注：SchedulerLeader.stop() 不走 onDemote，故此回调只会以 heartbeat_failed 触发。
   */
  private onLeaderDemote(reason: DemoteReason, prevLease: LeaderLease | null): void {
    this.log.warn({ reason }, "demoted from leadership")
    const now = this.clock()
    void this.persistTrace(
      this.buildTrace({
        jobName: LEADER_TRACE_JOB,
        runId: newRunId(),
        scheduledFor: now,
        windowStart: now,
        windowEnd: now,
        startedAt: null,
        finishedAt: null,
        status: "lease_lost",
        reason: "heartbeat_failed",
        result: null,
        error: null,
        leaderTerm: prevLease?.currentTerm ?? null,
      }),
    )
    void this.stopEventDrivenJobs()
  }

  /** guard 返 skip reason 时由 NightlyJobScheduler.onSkip 回调。 */
  private onJobSkipped(jobName: string, reason: string): void {
    const now = this.clock()
    const reg = this.cronByName.get(jobName)
    const windowMs = (reg?.windowMinutes ?? 5) * 60_000
    void this.persistTrace(
      this.buildTrace({
        jobName,
        runId: newRunId(),
        scheduledFor: now,
        windowStart: now,
        windowEnd: new Date(now.getTime() + windowMs),
        startedAt: null,
        finishedAt: null,
        status: "skipped_not_leader",
        reason: this.toTraceReason(reason),
        result: null,
        error: null,
      }),
    )
  }

  /** guard 自身抛错时由 NightlyJobScheduler.onGuardError 回调。 */
  private onGuardError(jobName: string, error: Error): void {
    const now = this.clock()
    const reg = this.cronByName.get(jobName)
    const windowMs = (reg?.windowMinutes ?? 5) * 60_000
    void this.persistTrace(
      this.buildTrace({
        jobName,
        runId: newRunId(),
        scheduledFor: now,
        windowStart: now,
        windowEnd: new Date(now.getTime() + windowMs),
        startedAt: null,
        finishedAt: null,
        status: "failed",
        reason: null,
        result: null,
        error: { message: error.message, stack: error.stack },
      }),
    )
  }

  private buildTrace(p: {
    jobName: string
    runId: string
    scheduledFor: Date
    windowStart: Date
    windowEnd: Date
    startedAt: Date | null
    finishedAt: Date | null
    status: JobTraceStatus
    reason: JobTraceReason | null
    result: unknown
    error: { message: string; stack?: string } | null
    /** 显式 leaderTerm（leader 生命周期 trace 用 prevLease）；不填则取当前 lease。 */
    leaderTerm?: string | null
  }): JobTrace {
    const durationMs =
      p.startedAt && p.finishedAt ? p.finishedAt.getTime() - p.startedAt.getTime() : null
    const alertedRoom =
      this.pushAlert && ALERT_STATUSES.has(p.status) ? this.alertRoom : null
    return {
      schemaVersion: JOB_TRACE_SCHEMA_VERSION,
      jobName: p.jobName,
      runId: p.runId,
      scheduledFor: p.scheduledFor.toISOString(),
      windowStart: p.windowStart.toISOString(),
      windowEnd: p.windowEnd.toISOString(),
      startedAt: p.startedAt ? p.startedAt.toISOString() : null,
      finishedAt: p.finishedAt ? p.finishedAt.toISOString() : null,
      durationMs: durationMs !== null && durationMs < 0 ? 0 : durationMs,
      status: p.status,
      leaderTerm:
        p.leaderTerm !== undefined
          ? p.leaderTerm
          : (this.leader.getLease()?.currentTerm ?? null),
      reason: p.reason,
      result: p.result,
      error: p.error,
      alertedRoom,
    }
  }

  private async persistTrace(trace: JobTrace): Promise<void> {
    try {
      writeJobTrace({ rootDir: this.rootDir, trace, clock: this.clock })
    } catch (err) {
      this.log.error({ err, job: trace.jobName }, "writeJobTrace failed (ignored)")
    }
    if (this.pushAlert && ALERT_STATUSES.has(trace.status)) {
      try {
        await this.pushAlert(trace)
      } catch (err) {
        this.log.error({ err, job: trace.jobName }, "pushAlert failed (ignored)")
      }
    }
  }

  /** skip reason 字符串 → JobTraceReason；越界（不应发生）兜底 role_not_leader。 */
  private toTraceReason(reason: string): JobTraceReason {
    return (JOB_TRACE_REASON_VALUES as ReadonlyArray<string>).includes(reason)
      ? (reason as JobTraceReason)
      : "role_not_leader"
  }

  private withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new JobTimeoutError(timeoutMs)), timeoutMs)
      timer.unref?.()
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }
}
