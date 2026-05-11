/**
 * F027 P3 · WikiLeasesRepository — chap 6 update_wiki 写入流程的 lease 表 repo。
 * 真相源：docs/plans/V16.5-final.md chap 6
 *
 * 职责：
 *   - 单调 fencing_token 分配（wiki_fencing_seq 原子 UPDATE RETURNING）
 *   - acquireLease（path 维度互斥锁，支持抢占 expired lease）
 *   - renewLease / releaseLease（CAS by fencing_token）
 *   - isCurrent / get（读路径，final-CAS fencing 二次校验用）
 *
 * 不做：
 *   - ACL 检查（caller 在 service 层做）
 *   - leader_term 校验（写入 wiki_events 时由 P3.5 DB 触发器拒绝旧 leader_term）
 *   - 自动 GC expired lease 行（acquireLease 抢占覆盖即可，老行直接被覆盖）
 *
 * 并发模型：
 *   better-sqlite3 是 single-process synchronous，写操作在 SQLite 内部 atomic。
 *   多 connection 场景靠 SQLite 的 file-level lock + WAL 串行化。
 *   acquireLease 的 INSERT-OR-CONDITIONAL-UPDATE 是单条 SQL，无 race。
 */

import { sql } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../schema"
import type {
  AcquireLeaseInput,
  AcquireLeaseSuccess,
  ReleaseLeaseInput,
  RenewLeaseInput,
  RenewLeaseSuccess,
  WikiLease,
} from "./wiki-leases-types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface LeaseRow {
  path: string
  fencing_token: string
  owner_alias: string
  acquired_at: string
  expires_at: string
  leader_term: string
}

export class WikiLeasesRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * 分配单调下一 fencing_token（bigint as decimal string）。
   * 单条 UPDATE ... SET v=v+1 RETURNING 原子。
   * 调用方应在 acquireLease 之前调（或由 acquireLease 内部调）。
   */
  nextFencingToken(): string {
    const row = this.db
      .get<{ next_value: string }>(
        sql`UPDATE wiki_fencing_seq SET next_value = CAST(CAST(next_value AS INTEGER) + 1 AS TEXT) WHERE id = 1 RETURNING next_value`,
      )
    if (!row) {
      throw new Error("wiki_fencing_seq missing — INIT_SQL seed not applied")
    }
    return row.next_value
  }

  /**
   * 抢 path 的 lease。
   * 返回 { fencingToken, expiresAt } 表示拿到（path 无 lease 或旧 lease 已过期）；
   * 返回 null 表示该 path 当前有 owner（caller 看 null = lease_held，不应继续写）。
   *
   * 抢占语义：旧 lease 已过期 → 直接覆盖（包括换 token + 换 owner）。
   * 防 ABA：每次抢占都分配新 token，旧 owner 即使时钟回拨也无法用旧 token 通过 final-CAS。
   */
  acquireLease(input: AcquireLeaseInput): AcquireLeaseSuccess | null {
    const now = input.now ?? new Date().toISOString()
    const expiresAt = isoAdd(now, input.ttlSeconds)
    const newToken = this.nextFencingToken()

    // INSERT 新 lease；若 path 已存在但 expires_at <= now（已过期）→ 覆盖；否则不动。
    // RETURNING 在 ON CONFLICT WHERE 不通过时不返回行 → null 表示当前有未过期 owner。
    const row = this.db.get<{ fencing_token: string; expires_at: string }>(
      sql`
        INSERT INTO wiki_leases (path, fencing_token, owner_alias, acquired_at, expires_at, leader_term)
        VALUES (${input.path}, ${newToken}, ${input.ownerAlias}, ${now}, ${expiresAt}, ${input.leaderTerm})
        ON CONFLICT(path) DO UPDATE SET
          fencing_token = excluded.fencing_token,
          owner_alias = excluded.owner_alias,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at,
          leader_term = excluded.leader_term
        WHERE wiki_leases.expires_at <= ${now}
        RETURNING fencing_token, expires_at
      `,
    )

    if (!row) return null
    return { fencingToken: row.fencing_token, expiresAt: row.expires_at }
  }

  /**
   * 续约：当前 token 持有且未过期才能延长。
   * 返回 success 或 null（caller 看 null 应 reacquire）。
   * 续约不换 fencing_token —— 同一 lease 周期内 token 稳定。
   */
  renewLease(input: RenewLeaseInput): RenewLeaseSuccess | null {
    const now = input.now ?? new Date().toISOString()
    const expiresAt = isoAdd(now, input.ttlSeconds)

    const row = this.db.get<{ fencing_token: string; expires_at: string }>(
      sql`
        UPDATE wiki_leases SET expires_at = ${expiresAt}
        WHERE path = ${input.path}
          AND fencing_token = ${input.fencingToken}
          AND expires_at > ${now}
        RETURNING fencing_token, expires_at
      `,
    )

    if (!row) return null
    return { fencingToken: row.fencing_token, expiresAt: row.expires_at }
  }

  /**
   * 释放：当前 token 持有才能释放（CAS）。
   * 返回 true = 释放了；false = 不持有 / 已过期 / 已被抢占（noop）。
   */
  releaseLease(input: ReleaseLeaseInput): boolean {
    const result = this.db.run(
      sql`DELETE FROM wiki_leases WHERE path = ${input.path} AND fencing_token = ${input.fencingToken}`,
    )
    return result.changes > 0
  }

  /**
   * final-CAS fencing 二次校验用：当前 lease 是否仍是给定 token + 未过期。
   * caller 在文件写入临界区开始时调，确保 acquire 之后 lease 没被抢占。
   */
  isCurrent(path: string, fencingToken: string, now?: string): boolean {
    const nowIso = now ?? new Date().toISOString()
    const row = this.db.get<{ x: number }>(
      sql`SELECT 1 AS x FROM wiki_leases WHERE path = ${path} AND fencing_token = ${fencingToken} AND expires_at > ${nowIso}`,
    )
    return !!row
  }

  /** 读单 lease 行（debug / observability）。返回 null 表示无 lease。 */
  get(path: string): WikiLease | null {
    const row = this.db.get<LeaseRow>(sql`SELECT * FROM wiki_leases WHERE path = ${path}`)
    return row ? hydrate(row) : null
  }
}

function isoAdd(nowIso: string, seconds: number): string {
  return new Date(new Date(nowIso).getTime() + seconds * 1000).toISOString()
}

function hydrate(row: LeaseRow): WikiLease {
  return {
    path: row.path,
    fencingToken: row.fencing_token,
    ownerAlias: row.owner_alias,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    leaderTerm: row.leader_term,
  }
}
