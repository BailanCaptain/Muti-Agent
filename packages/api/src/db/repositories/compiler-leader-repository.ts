/**
 * F027 P3.5 · CompilerLeaderRepository — chap 5 split-brain 防御 leader lease
 * 真相源：docs/plans/V16.5-final.md chap 5（Compiler Leader Lease）
 *
 * 职责：
 *   - acquireLeader：无 leader 或已过期 → 当选 + term++（防 ABA：每次抢占 term
 *     单调推进，旧 leader 写 wiki_events 被触发器 RAISE(ABORT)）
 *   - renewLeader：当前 term 持有 → 延长 lease_expires_at
 *   - releaseLeader：当前 term 持有 → 删除（DELETE WHERE id=1）
 *   - getCurrent：读单行 leader 状态（debug / leaderTerm() injection）
 *   - isLeader：当前 term 持有 + 未过期 = true（pre-write capability check）
 *
 * 不做：
 *   - heartbeat scheduler（caller 自己 setInterval renew）
 *   - 续约失败回调（caller 监测 renew → null 后 self-abort）
 *
 * 并发模型：
 *   single SQLite connection 同步原子；多 connection 走 SQLite WAL serialization
 *   + INSERT OR FAIL / ON CONFLICT WHERE 单条 SQL atomic（同 wiki_leases 设计）。
 */

import { sql } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../schema"
import type {
  AcquireLeaderInput,
  AcquireLeaderSuccess,
  CompilerLeader,
  ReleaseLeaderInput,
  RenewLeaderInput,
} from "./compiler-leader-types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface LeaderRow {
  id: number
  current_term: string
  leader_alias: string
  acquired_at: string
  renewed_at: string
  lease_expires_at: string
}

export class CompilerLeaderRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * 抢 leader。
   * 返回 { currentTerm, leaseExpiresAt } 表示当选；
   * 返回 null 表示现任未过期（caller 不是 leader，应继续 follower 模式）。
   *
   * 抢占语义：
   *   - 无 leader 行 → INSERT 当选 (term=1)
   *   - 有 leader 行但 lease_expires_at <= now → 抢占 + term++
   *   - 有 leader 行未过期 → 拒（即使 caller 就是现任 alias 也拒，必须 renew）
   *
   * **每次抢占 term 严格单调递增**（防 ABA：旧 leader 即使时钟回拨拿不回旧 term）。
   */
  acquireLeader(input: AcquireLeaderInput): AcquireLeaderSuccess | null {
    const now = input.now ?? new Date().toISOString()
    const leaseExpiresAt = isoAdd(now, input.ttlSeconds)

    // 单条 UPSERT：INSERT 不存在 → term=1；冲突时 WHERE expired → 抢占 + term+1
    // SQLite ON CONFLICT DO UPDATE 不支持 RETURNING with WHERE 不通过 → 0 行
    const row = this.db.get<{ current_term: string; lease_expires_at: string }>(
      sql`
        INSERT INTO compiler_leader (id, current_term, leader_alias, acquired_at, renewed_at, lease_expires_at)
        VALUES (1, '1', ${input.leaderAlias}, ${now}, ${now}, ${leaseExpiresAt})
        ON CONFLICT(id) DO UPDATE SET
          current_term = CAST(CAST(compiler_leader.current_term AS INTEGER) + 1 AS TEXT),
          leader_alias = excluded.leader_alias,
          acquired_at = excluded.acquired_at,
          renewed_at = excluded.renewed_at,
          lease_expires_at = excluded.lease_expires_at
        WHERE compiler_leader.lease_expires_at <= ${now}
        RETURNING current_term, lease_expires_at
      `,
    )

    if (!row) return null
    return { currentTerm: row.current_term, leaseExpiresAt: row.lease_expires_at }
  }

  /**
   * 续约：当前 term 持有且未过期才能延长。
   * 返回 { currentTerm, leaseExpiresAt } 或 null（被抢占；caller 应 self-abort）。
   * 续约不换 term —— 同 leader 周期内 term 稳定。
   */
  renewLeader(input: RenewLeaderInput): AcquireLeaderSuccess | null {
    const now = input.now ?? new Date().toISOString()
    const leaseExpiresAt = isoAdd(now, input.ttlSeconds)

    const row = this.db.get<{ current_term: string; lease_expires_at: string }>(
      sql`
        UPDATE compiler_leader SET renewed_at = ${now}, lease_expires_at = ${leaseExpiresAt}
        WHERE id = 1
          AND current_term = ${input.currentTerm}
          AND lease_expires_at > ${now}
        RETURNING current_term, lease_expires_at
      `,
    )

    if (!row) return null
    return { currentTerm: row.current_term, leaseExpiresAt: row.lease_expires_at }
  }

  /**
   * 主动释放：当前 term 持有才能释放（CAS）。
   * 返回 true = 释放了；false = 不持有 / 已过期 / 已被抢占（noop）。
   *
   * **不删 row** —— 而是 mark lease_expires_at=epoch。
   * [范-r1 P1 修正] 删 row 会让 reject_stale_leader 触发器 WHEN EXISTS 跳过，
   * release 后 zombie 旧 term 写就能绕过校验。同时 reacquire 重置 term=1，
   * 单调性被打破（旧 term 都 ≥1 通过）。修：UPDATE expires=epoch 保留 row+term。
   * 后续 acquireLeader 走 ON CONFLICT 抢占路径 → term++。
   */
  releaseLeader(input: ReleaseLeaderInput): boolean {
    // 用一个固定的远古 epoch ISO 字符串表示"已释放"，触发器和 isCurrent 都会
    // 视为 expired（lease_expires_at <= any now）
    const result = this.db.run(
      sql`UPDATE compiler_leader
          SET lease_expires_at = '1970-01-01T00:00:00.000Z'
          WHERE id = 1 AND current_term = ${input.currentTerm}`,
    )
    return result.changes > 0
  }

  /** 读当前 leader 状态。null = 无 leader（启动期）。 */
  getCurrent(): CompilerLeader | null {
    const row = this.db.get<LeaderRow>(sql`SELECT * FROM compiler_leader WHERE id = 1`)
    return row ? hydrate(row) : null
  }

  /** 当前 term 是否仍是有效 leader（持有 + 未过期）。leaderTerm() injection 用。 */
  isLeader(currentTerm: string, now?: string): boolean {
    const nowIso = now ?? new Date().toISOString()
    const row = this.db.get<{ x: number }>(
      sql`SELECT 1 AS x FROM compiler_leader WHERE id = 1 AND current_term = ${currentTerm} AND lease_expires_at > ${nowIso}`,
    )
    return !!row
  }
}

function isoAdd(nowIso: string, seconds: number): string {
  return new Date(new Date(nowIso).getTime() + seconds * 1000).toISOString()
}

function hydrate(row: LeaderRow): CompilerLeader {
  return {
    id: 1 as const,
    currentTerm: row.current_term,
    leaderAlias: row.leader_alias,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    leaseExpiresAt: row.lease_expires_at,
  }
}
