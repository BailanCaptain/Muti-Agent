/**
 * F027 Phase 3 P20 · drizzle DB → SqliteAdapterLike helper（Week 1 r2 — 范-r1 P2-6）
 *
 * 真相源：F027 Phase 3 plan v3.1 §3 Week 1 + 范-r1 P2-6
 *
 * Phase 3 read endpoint（viewfinder / prompt-inspector）需要走原生 SQL 直读 prompt_audit /
 * room_decisions 等表（drizzle 高级查询接口在 raw 表查询上有 unknown cast 问题）。
 *
 * 之前 viewfinder.ts / prompt-inspector.ts 各自 cast `(db as unknown as ...).$client`，
 * 重复 + 易脱节。本 helper 集中 cast 一处，复用 P12 已有的 SqliteAdapterLike 结构性类型，
 * 保证 prepare/run/all/get API surface 与 better-sqlite3 / node:sqlite 都兼容。
 *
 * drizzle better-sqlite3 driver 的 `$client` 字段就是底层 better-sqlite3 Database，
 * 与 SqliteAdapterLike 接口形状一致。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import type { SqliteAdapterLike } from "../../wiki/room-compiler/sqlite-checkpoint-store"

type DrizzleDb = BetterSQLite3Database<typeof schema>

/**
 * 拿到底层 better-sqlite3 Database（兼容 SqliteAdapterLike）。
 *
 * 用于 routes/phase3/* 内只读 SQL 直查（prompt_audit / room_decisions 等）；
 * 不用于 drizzle ORM 高级查询。
 */
export function getSqliteClient(db: DrizzleDb): SqliteAdapterLike {
  return (
    db as unknown as {
      $client: SqliteAdapterLike
    }
  ).$client
}
