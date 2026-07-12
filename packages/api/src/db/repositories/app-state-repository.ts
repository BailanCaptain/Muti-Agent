/**
 * F042 AC2/D10 · AppStateRepository — 通用一次性标志/轻量状态 KV。
 *
 * 用途：影子观察窗小结「只发一次」标志（f042_shadow_summary_sent）、rerank 攒够提示标志
 * （f042_rerank_hint_sent）之类的跨重启一次性保证。重置 = 人工删行。
 *
 * 边界：只放标志与游标（string 值），别塞业务大对象——业务数据归各自领域表。
 * 表归 drizzle-instance.ts INIT_SQL + MIGRATIONS 单点管；$client 取法对齐 PromptAuditWriter。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../schema"
import type { SqliteAdapterLike } from "../../wiki/room-compiler/sqlite-checkpoint-store"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface AppStateRepositoryDeps {
  db: DrizzleDb
}

export class AppStateRepository {
  private readonly client: SqliteAdapterLike

  constructor(deps: AppStateRepositoryDeps) {
    this.client = (deps.db as unknown as { $client: SqliteAdapterLike }).$client
  }

  get(key: string): string | null {
    const row = this.client.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  set(key: string, value: string): void {
    this.client
      .prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString())
  }
}
