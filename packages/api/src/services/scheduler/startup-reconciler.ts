/**
 * F027 P19.5 · StartupReconciler — crash injection 清理
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-5
 *
 * 时机：scheduler runtime 起来 + acquireLeader 成功后、register/start jobs 之前。
 *
 * 清理范围：
 *   - `wiki_events.state='pending'` → UPDATE 'aborted'
 *     （旧 leader crash 留下的 PREPARE 没 COMMIT 的事件；schema state CHECK
 *     enum: pending/committed/aborted）
 *   - `room_checkpoints.committed_at IS NULL` → DELETE
 *     （二阶段提交 PREPARE 已写但 COMMIT 未跑；schema PK roomId 单行 →
 *     删除 = 该 room 回到无 checkpoint 状态，下次 compile 重做）
 *
 * 不做：
 *   - 不 backfill 已 aborted 行（一次性清理，不递归）
 *   - 不重试 PREPARE（reconciler 只删/标记，重做交给 normal scheduler tick）
 *   - 不动 wiki_events.state='committed' / 'aborted'（已终态行）
 *   - 不写 wiki_events 行（避开 reject_stale_leader 触发器；只 UPDATE/DELETE）
 *
 * 并发：reconciler 必须在所有 job 起步前跑。startup 期 owner election 已选定，
 * 不会有其他 leader 在写 wiki_events / room_checkpoints。
 */

import { sql } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"
import type * as schema from "../../db/schema"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface StartupReconcilerOptions {
  db: DrizzleDb
  logger?: FastifyBaseLogger
}

export interface ReconcileResult {
  /** wiki_events.state='pending' → 'aborted' 的行数。 */
  wikiEventsAborted: number
  /** room_checkpoints.committed_at IS NULL → DELETE 的行数。 */
  checkpointsDropped: number
}

export class StartupReconciler {
  private readonly db: DrizzleDb
  private readonly log: FastifyBaseLogger

  constructor(opts: StartupReconcilerOptions) {
    this.db = opts.db
    this.log = opts.logger ?? createLogger("startup-reconciler")
  }

  /**
   * 一次性清理。返回各类清理计数。
   * 调用时 scheduler 必须已 acquireLeader 成功，且 jobs 尚未注册启动。
   */
  reconcile(): ReconcileResult {
    const wiki = this.db.run(
      sql`UPDATE wiki_events SET state = 'aborted' WHERE state = 'pending'`,
    )
    const ckpt = this.db.run(
      sql`DELETE FROM room_checkpoints WHERE committed_at IS NULL`,
    )
    const result: ReconcileResult = {
      wikiEventsAborted: Number(wiki.changes ?? 0),
      checkpointsDropped: Number(ckpt.changes ?? 0),
    }
    this.log.info(result, "startup reconciliation done")
    return result
  }
}
