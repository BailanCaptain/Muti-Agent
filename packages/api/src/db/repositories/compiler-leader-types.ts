/**
 * F027 P3.5 · Compiler Leader Lease 域类型
 * 真相源：docs/plans/V16.5-final.md chap 5（Compiler Leader Lease 防 split-brain）
 *
 * 状态机：
 *   acquireLeader ── 无 leader 或 lease 已过期 ──► 当选（term++） + 持 lease
 *                ── 现任未过期               ──► null（caller 看 null = not_leader）
 *
 *   renewLeader   ── 当前 term 持有        ──► 延长 lease_expires_at
 *                 ── term 不匹配           ──► null（被抢占了，caller 应 abort）
 *
 *   releaseLeader ── 当前 term 持有        ──► true
 *                 ── 否则                 ──► false
 *
 * 不变量：
 *   1. 同时刻最多一个 leader（id=1 PK）
 *   2. current_term 严格单调递增（每次抢占都 +1，不复用）
 *   3. 旧 term 写 wiki_events 由 reject_stale_leader 触发器 SQL ABORT
 */

export interface CompilerLeader {
  id: 1
  currentTerm: string // bigint as decimal string
  leaderAlias: string
  acquiredAt: string
  renewedAt: string
  leaseExpiresAt: string
}

export interface AcquireLeaderInput {
  leaderAlias: string
  ttlSeconds: number
  /** ISO timestamp; default = new Date().toISOString()。测试用注入 deterministic 时间。 */
  now?: string
}

export interface AcquireLeaderSuccess {
  currentTerm: string
  leaseExpiresAt: string
}

export interface RenewLeaderInput {
  currentTerm: string
  ttlSeconds: number
  now?: string
}

export interface ReleaseLeaderInput {
  currentTerm: string
}

export class StaleLeaderTermError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StaleLeaderTermError"
  }
}
