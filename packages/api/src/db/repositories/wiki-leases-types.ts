/**
 * F027 P3 · wiki_leases 域类型 + lease 状态契约
 * 真相源：docs/plans/V16.5-final.md chap 6（update_wiki MCP 写入流程 step 1+7）
 *
 * lease 状态机：
 *   acquireLease ── path 无 lease 或已过期 ──► 颁发新 token + expires_at
 *                ── path 有未过期 lease     ──► null（caller 看 null = lease_held）
 *
 *   renewLease  ── 当前 token 仍持有       ──► 延长 expires_at
 *               ── 不是当前 token / 过期    ──► null（caller 应 reacquire）
 *
 *   releaseLease ── 当前 token 持有        ──► true（删 lease 行）
 *                ── 否则                   ──► false（noop）
 *
 * 不变量：
 *   1. fencing_token 严格单调递增（wiki_fencing_seq.next_value 原子推进）
 *   2. path 同一时刻最多一个未过期 lease（path 是 PK + INSERT-OR-CONDITIONAL-UPDATE）
 *   3. acquireLease 总是分配新 token（即使是抢占 expired lease 也换新 token）
 *      —— 防 ABA：即使旧 owner 的 token 被复用回来，新 owner 已拿更大的 token
 */

export interface WikiLease {
  path: string
  fencingToken: string
  ownerAlias: string
  acquiredAt: string
  expiresAt: string
  leaderTerm: string
}

export interface AcquireLeaseInput {
  path: string
  ownerAlias: string
  ttlSeconds: number
  leaderTerm: string
  /** ISO timestamp; default = new Date().toISOString()。测试用注入 deterministic 时间。 */
  now?: string
}

export interface AcquireLeaseSuccess {
  fencingToken: string
  expiresAt: string
}

export interface RenewLeaseInput {
  path: string
  fencingToken: string
  ttlSeconds: number
  now?: string
}

export interface RenewLeaseSuccess {
  fencingToken: string
  expiresAt: string
}

export interface ReleaseLeaseInput {
  path: string
  fencingToken: string
}

export class LeaseNotHeldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LeaseNotHeldError"
  }
}
