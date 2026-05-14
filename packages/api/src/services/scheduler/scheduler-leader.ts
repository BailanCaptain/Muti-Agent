/**
 * F027 P19.2 · SchedulerLeader — runtime owner election
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md §5 Open#2 + AC-P2-2
 *
 * 架构（v2b F1 修订后）：
 *   - 起来一次性 acquireLeader（不每 job 持锁）→ runtime owner election
 *   - 30s heartbeat renewLeader；renew 返 null → selfDemote('heartbeat_failed')
 *   - selfDemote 清 lease + 记 demotedReason + 启动 follower poll
 *   - follower 60s poll 抢空位（旧 leader 释放 / TTL 到期）
 *   - 三段 guard（shouldSkipJob）：
 *       1. role check — 非 leader → role_not_leader OR lease_lost (按 demotedReason)
 *       2. lease 对象 check — leader 但内部 lease=null（防御）→ lease_lost
 *       3. lease wall clock check — leader 但时钟过期 → lease_expired
 *
 * 不做（Day 2 范围外）：
 *   - job_trace 落盘 → P19.4 Day 3（onDemote/onAcquireAsFollower 暴露 hook）
 *   - 与 NightlyJobScheduler 的耦合 → caller 用 `guard: () => leader.shouldSkipJob()`
 *
 * 注：lease 持久化 + ABA 防御（fencing token）已由 P3.5 CompilerLeaderRepository
 * + reject_stale_leader 触发器搞定，本类不重写。
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"
import type { CompilerLeaderRepository } from "../../db/repositories/compiler-leader-repository"

export type LeaderRole = "starting" | "leader" | "follower" | "demoted"

/** Why selfDemote() 触发；记录在内部 demotedReason，给 onDemote 回调用。 */
export type DemoteReason = "heartbeat_failed" | "manual_release"

/**
 * shouldSkipJob 返回的 skip 原因 — 对应 AC-P2-4 reason enum 子集（runJob 路径，
 * trace status='skipped_not_leader'）。
 *
 * v2b F1 三段 guard 区分：
 *   - role_not_leader: role='follower' / 'starting'（Guard 1，未当选）
 *   - lease_lost: role='demoted' + demotedReason='heartbeat_failed'（Guard 1，主动 demote）
 *   - lease_expired: role='leader' 但 wall clock 过期（Guard 3，未察觉地丢）
 */
export type SkipReason = "role_not_leader" | "lease_lost" | "lease_expired"

export interface LeaderLease {
  currentTerm: string
  leaseExpiresAt: string
}

export interface SchedulerLeaderOptions {
  /** Unique alias per runtime instance（建议 `${hostname}-${pid}`）。 */
  leaderAlias: string
  leaseRepo: CompilerLeaderRepository
  /** Lease TTL；默认 90s（heartbeat 30s × 3 容错）。 */
  ttlSeconds?: number
  /** Heartbeat 间隔；默认 30s。 */
  heartbeatIntervalMs?: number
  /** Follower poll 间隔；默认 60s。 */
  followerPollIntervalMs?: number
  logger?: FastifyBaseLogger
  /** 注入时钟（测试用）；默认 () => new Date()。 */
  clock?: () => Date
  /** 自降级回调（heartbeat 失败 / manual stop）；P19.4 在此写 trace。 */
  onDemote?: (reason: DemoteReason, prevLease: LeaderLease | null) => void
  /** Follower poll 抢成功回调；P19.4 在此写 trace 'recovered_from_crash'。 */
  onAcquireAsFollower?: (lease: LeaderLease) => void
}

export class SchedulerLeader {
  private readonly log: FastifyBaseLogger
  private readonly alias: string
  private readonly repo: CompilerLeaderRepository
  private readonly ttlSeconds: number
  private readonly hbIntervalMs: number
  private readonly pollIntervalMs: number
  private readonly clock: () => Date
  private readonly onDemote?: SchedulerLeaderOptions["onDemote"]
  private readonly onAcquireAsFollower?: SchedulerLeaderOptions["onAcquireAsFollower"]

  private role: LeaderRole = "starting"
  private lease: LeaderLease | null = null
  private demotedReason: DemoteReason | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(opts: SchedulerLeaderOptions) {
    this.alias = opts.leaderAlias
    this.repo = opts.leaseRepo
    this.ttlSeconds = opts.ttlSeconds ?? 90
    this.hbIntervalMs = opts.heartbeatIntervalMs ?? 30_000
    this.pollIntervalMs = opts.followerPollIntervalMs ?? 60_000
    this.log = opts.logger ?? createLogger(`scheduler-leader[${opts.leaderAlias}]`)
    this.clock = opts.clock ?? (() => new Date())
    this.onDemote = opts.onDemote
    this.onAcquireAsFollower = opts.onAcquireAsFollower
  }

  /** 触发首次 acquire；后续靠 heartbeat / poll 维持。idempotent。 */
  start(): void {
    if (this.stopped) {
      throw new Error("SchedulerLeader: cannot start after stop()")
    }
    if (this.role !== "starting") {
      this.log.debug({ role: this.role }, "start() noop (already started)")
      return
    }
    this.tryAcquire()
  }

  /** 释放 lease（如持有）+ 清 timers。idempotent。 */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearHeartbeat()
    this.clearPoll()
    const wasLeader = this.role === "leader" && this.lease !== null
    if (wasLeader) {
      try {
        this.repo.releaseLeader({ currentTerm: this.lease!.currentTerm })
      } catch (err) {
        this.log.warn({ err }, "release on stop failed (ignored)")
      }
    }
    this.role = "demoted"
    this.demotedReason = "manual_release"
    this.lease = null
  }

  getRole(): LeaderRole {
    return this.role
  }

  getLease(): LeaderLease | null {
    return this.lease ? { ...this.lease } : null
  }

  getDemotedReason(): DemoteReason | null {
    return this.demotedReason
  }

  /**
   * v2b F1 三段 guard。null = 可跑 job；非 null = 应 skip 并写 trace。
   *
   * 顺序很重要：role guard 先（区分 selfDemote vs 未当选），lease 对象 check
   * 防御兜底，wall clock check 兜 selfDemote 没跑但时钟过期的边缘场景。
   */
  shouldSkipJob(): SkipReason | null {
    if (this.role !== "leader") {
      if (this.role === "demoted" && this.demotedReason === "heartbeat_failed") {
        return "lease_lost"
      }
      return "role_not_leader"
    }
    if (!this.lease) {
      return "lease_lost"
    }
    const nowMs = this.clock().getTime()
    const expMs = new Date(this.lease.leaseExpiresAt).getTime()
    if (nowMs >= expMs) {
      return "lease_expired"
    }
    return null
  }

  // ── private ────────────────────────────────────────────────────────────

  private tryAcquire(): void {
    if (this.stopped) return
    const nowIso = this.clock().toISOString()
    const result = this.repo.acquireLeader({
      leaderAlias: this.alias,
      ttlSeconds: this.ttlSeconds,
      now: nowIso,
    })
    if (result) {
      const wasNonLeader = this.role !== "leader" && this.role !== "starting"
      this.role = "leader"
      this.lease = { currentTerm: result.currentTerm, leaseExpiresAt: result.leaseExpiresAt }
      this.demotedReason = null
      this.clearPoll()
      this.startHeartbeat()
      this.log.info(
        { term: result.currentTerm, expires: result.leaseExpiresAt },
        "acquired leader",
      )
      if (wasNonLeader && this.onAcquireAsFollower) {
        try {
          this.onAcquireAsFollower({ ...this.lease })
        } catch (err) {
          this.log.warn({ err }, "onAcquireAsFollower threw (ignored)")
        }
      }
    } else {
      this.role = "follower"
      this.lease = null
      this.startPoll()
      this.log.info("became follower (existing leader holds lease)")
    }
  }

  private heartbeatTick(): void {
    if (this.stopped || this.role !== "leader" || !this.lease) return
    const nowIso = this.clock().toISOString()
    const result = this.repo.renewLeader({
      currentTerm: this.lease.currentTerm,
      ttlSeconds: this.ttlSeconds,
      now: nowIso,
    })
    if (result) {
      this.lease = { currentTerm: result.currentTerm, leaseExpiresAt: result.leaseExpiresAt }
      this.log.debug({ expires: result.leaseExpiresAt }, "heartbeat renewed")
    } else {
      this.selfDemote("heartbeat_failed")
    }
  }

  private pollTick(): void {
    if (this.stopped) return
    if (this.role === "leader") return // 防御
    this.tryAcquire()
  }

  /** v2b F1: 清 lease + 记 demotedReason + 启 poll + 触发回调。 */
  private selfDemote(reason: DemoteReason): void {
    const prevLease = this.lease ? { ...this.lease } : null
    this.log.warn({ reason, prevLease }, "self-demoting from leader")
    this.role = "demoted"
    this.demotedReason = reason
    this.lease = null
    this.clearHeartbeat()
    this.startPoll()
    if (this.onDemote) {
      try {
        this.onDemote(reason, prevLease)
      } catch (err) {
        this.log.warn({ err }, "onDemote threw (ignored)")
      }
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.hbIntervalMs)
    this.heartbeatTimer.unref?.()
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private startPoll(): void {
    this.clearPoll()
    this.pollTimer = setInterval(() => this.pollTick(), this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private clearPoll(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}
