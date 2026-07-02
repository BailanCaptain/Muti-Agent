import type {
  DecisionRecord,
  DecisionRecordStatus,
  DecisionVerdict,
} from "@multi-agent/shared"
import { and, asc, eq, sql } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { decisionRecords } from "../schema"

type DrizzleDb = BetterSQLite3Database<typeof import("../schema")>

// payload 列承载的不常查字段（结构列只留高频查询用的）
type DecisionRecordPayload = {
  title: string
  description?: string
  options: DecisionRecord["options"]
  multiSelect?: boolean
  anchorMessageId?: string
  sourceProvider?: DecisionRecord["sourceProvider"]
  sourceAlias?: string
}

export type PendingDecisionRecord = Omit<
  DecisionRecord,
  "status" | "verdicts" | "userInput" | "resolvedAt"
>

/**
 * F033 · request_decision 决策卡生命周期账本。
 * pending 的 blocking promise 只活在 DecisionManager 内存里；本表是渲染与审计真相源。
 * 状态机：pending → resolved | timeout | orphaned（boot 兜底），单向不可逆。
 */
export class DecisionRecordRepository {
  constructor(private readonly db: DrizzleDb) {}

  insertPending(record: PendingDecisionRecord): void {
    const payload: DecisionRecordPayload = {
      title: record.title,
      description: record.description,
      options: record.options,
      multiSelect: record.multiSelect,
      anchorMessageId: record.anchorMessageId,
      sourceProvider: record.sourceProvider,
      sourceAlias: record.sourceAlias,
    }
    this.db
      .insert(decisionRecords)
      .values({
        requestId: record.requestId,
        sessionGroupId: record.sessionGroupId,
        kind: record.kind,
        payload: JSON.stringify(payload),
        status: "pending",
        createdAt: record.createdAt,
      })
      .run()
  }

  /**
   * pending → resolved/timeout。幂等门：WHERE status='pending' 条件更新，
   * respond 与 timeout 竞态时后到者返回 false（DecisionManager 内存 Map 互斥之外的第二道保险）。
   */
  markResolved(
    requestId: string,
    status: Extract<DecisionRecordStatus, "resolved" | "timeout">,
    verdicts: DecisionVerdict[],
    userInput: string,
  ): boolean {
    const result = this.db
      .update(decisionRecords)
      .set({
        status,
        verdicts: JSON.stringify(verdicts),
        userInput,
        resolvedAt: new Date().toISOString(),
      })
      .where(and(eq(decisionRecords.requestId, requestId), eq(decisionRecords.status, "pending")))
      .run()
    return result.changes > 0
  }

  /** boot 兜底：上一进程留下的 pending 行全部标 orphaned（promise 已死，fail-closed 不恢复）。 */
  orphanAllPending(): number {
    const result = this.db
      .update(decisionRecords)
      .set({ status: "orphaned", resolvedAt: new Date().toISOString() })
      .where(eq(decisionRecords.status, "pending"))
      .run()
    return result.changes
  }

  listBySessionGroup(
    sessionGroupId: string,
    opts?: { excludePending?: boolean; limit?: number },
  ): DecisionRecord[] {
    const conditions = [eq(decisionRecords.sessionGroupId, sessionGroupId)]
    if (opts?.excludePending) {
      conditions.push(sql`${decisionRecords.status} != 'pending'`)
    }
    const rows = this.db
      .select()
      .from(decisionRecords)
      .where(and(...conditions))
      .orderBy(asc(decisionRecords.createdAt))
      .limit(opts?.limit ?? 200)
      .all()
    return rows.map((row) => this.toRecord(row))
  }

  private toRecord(row: typeof decisionRecords.$inferSelect): DecisionRecord {
    const payload = JSON.parse(row.payload) as DecisionRecordPayload
    return {
      requestId: row.requestId,
      sessionGroupId: row.sessionGroupId,
      kind: row.kind as DecisionRecord["kind"],
      title: payload.title,
      description: payload.description,
      options: payload.options,
      multiSelect: payload.multiSelect,
      anchorMessageId: payload.anchorMessageId,
      sourceProvider: payload.sourceProvider,
      sourceAlias: payload.sourceAlias,
      status: row.status as DecisionRecordStatus,
      verdicts: row.verdicts ? (JSON.parse(row.verdicts) as DecisionVerdict[]) : undefined,
      userInput: row.userInput ?? undefined,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt ?? undefined,
    }
  }
}
