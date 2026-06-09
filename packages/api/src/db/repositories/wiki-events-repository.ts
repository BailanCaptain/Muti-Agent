/**
 * F027 P1 · WikiEventsRepository — wiki entity 的事件源 DB 层。
 * 真相源：docs/plans/V16.5-final.md chap 5（单一提交协议三阶段 + 状态机）
 *
 * 职责：
 *   - append-only insert（PREPARE 阶段，state='pending'）
 *   - state CAS：pending → committed / aborted（重复 settle 是 noop）
 *   - 按 path / alias / state 查询（compiler 重放只读 state='committed'）
 *   - JSON 字段（source_message_ids）在 boundary 序列化
 *
 * 不做：
 *   - 文件 IO（temp + rename）—— P2 WikiCompiler 负责
 *   - leader lease 校验 —— P3.5 在 INSERT 触发器里加 reject_stale_leader
 *   - reconciler 扫 pending —— P3.5 实施 Startup Reconciler
 *   - ACL 检查 —— P3 update_wiki MCP service 入口处做
 *
 * 状态机不变量：
 *   1. 只能从 pending 跳到 committed 或 aborted（CAS WHERE state='pending'）
 *   2. 重复 commit / abort = 0 rows changed = false（idempotent，caller 自决）
 *   3. committed 行 contentHash 必非空；aborted 行可空（事件未生效）
 */

import { and, desc, eq } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../schema"
import { wikiEvents } from "../schema"
import type {
  AbortInput,
  AppendPendingInput,
  CommitInput,
  WikiEvent,
  WikiEventAction,
  WikiEventResult,
  WikiEventState,
} from "./wiki-events-types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export class WikiEventsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** PREPARE 阶段：写 state='pending' 行，返回新 row 的 id（用于后续 commit/abort）。 */
  appendPending(input: AppendPendingInput): WikiEvent {
    const row = this.db
      .insert(wikiEvents)
      .values({
        ts: input.ts,
        alias: input.alias,
        action: input.action,
        path: input.path,
        baseHash: input.baseHash ?? null,
        contentHash: null,
        attemptedHash: input.attemptedHash,
        diffSummary: input.diffSummary ?? null,
        sourceMessageIds: serializeJson(input.sourceMessageIds),
        promotionTarget: input.promotionTarget ?? null,
        reason: input.reason ?? null,
        fencingToken: input.fencingToken,
        leaderTerm: input.leaderTerm,
        result: input.result ?? "ok",
        error: null,
        state: "pending",
        resultManifestVersion: null,
      })
      .returning()
      .get()
    return hydrate(row)
  }

  /**
   * COMMIT 阶段：state='pending' → 'committed'，落 contentHash + manifest 版本。
   * CAS：only if state='pending'。返回 true = 真改了；false = 已经 committed/aborted。
   * 重复 commit 同一 row = false（idempotent retry safe）。
   */
  commit(eventId: number, input: CommitInput): boolean {
    const result = this.db
      .update(wikiEvents)
      .set({
        state: "committed",
        contentHash: input.contentHash,
        resultManifestVersion: input.resultManifestVersion ?? null,
      })
      .where(and(eq(wikiEvents.id, eventId), eq(wikiEvents.state, "pending")))
      .run()
    return result.changes > 0
  }

  /**
   * ABORT 阶段：state='pending' → 'aborted'，记录 error / reason。
   * CAS：only if state='pending'。重复 abort = false（idempotent）。
   * Reconciler 第三方污染场景调 abort 时填 reason='aborted_dirty'（V16.5 chap 5 Startup Reconciler）。
   */
  abort(eventId: number, input: AbortInput = {}): boolean {
    const result = this.db
      .update(wikiEvents)
      .set({
        state: "aborted",
        error: input.error ?? null,
        reason: input.reason ?? null,
      })
      .where(and(eq(wikiEvents.id, eventId), eq(wikiEvents.state, "pending")))
      .run()
    return result.changes > 0
  }

  /** 按 id 拿单 row（含已 settle 的）。reconciler / debug 用。 */
  get(eventId: number): WikiEvent | null {
    const row = this.db.select().from(wikiEvents).where(eq(wikiEvents.id, eventId)).get()
    return row ? hydrate(row) : null
  }

  /** 拿全部 state='pending' 行（reconciler 启动时扫）。按 ts ASC 处理保证顺序。 */
  getPending(): WikiEvent[] {
    const rows = this.db
      .select()
      .from(wikiEvents)
      .where(eq(wikiEvents.state, "pending"))
      .all()
    return rows
      .map(hydrate)
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  }

  /** 按 path 查最近 limit 条事件（compiler 重放某条 wiki 文件的历史）。 */
  getByPath(path: string, limit = 100): WikiEvent[] {
    const rows = this.db
      .select()
      .from(wikiEvents)
      .where(eq(wikiEvents.path, path))
      .orderBy(desc(wikiEvents.ts))
      .limit(limit)
      .all()
    return rows.map(hydrate)
  }

  /** 按 alias 查最近 limit 条事件（人/agent 的 wiki 操作 audit）。 */
  getByAlias(alias: string, limit = 100): WikiEvent[] {
    const rows = this.db
      .select()
      .from(wikiEvents)
      .where(eq(wikiEvents.alias, alias))
      .orderBy(desc(wikiEvents.ts))
      .limit(limit)
      .all()
    return rows.map(hydrate)
  }

  /** 按 state 查最近 limit 条事件（observability：committed 重放 / aborted 排错）。 */
  getByState(state: WikiEventState, limit = 100): WikiEvent[] {
    const rows = this.db
      .select()
      .from(wikiEvents)
      .where(eq(wikiEvents.state, state))
      .orderBy(desc(wikiEvents.ts))
      .limit(limit)
      .all()
    return rows.map(hydrate)
  }

  /**
   * 按 action 查最近 limit 条事件 (AC-P4-9 a Week 4 Day 17 mid-r1 P2 修).
   *   - 给 WarningsTab merge wiki_events action='warning_raised' rows 用
   *   - 仅返 committed state (跳过 pending/aborted, 防 in-flight 操作误显示)
   */
  getByAction(action: string, limit = 100): WikiEvent[] {
    const rows = this.db
      .select()
      .from(wikiEvents)
      .where(and(eq(wikiEvents.action, action), eq(wikiEvents.state, "committed")))
      .orderBy(desc(wikiEvents.ts))
      .limit(limit)
      .all()
    return rows.map(hydrate)
  }
}

function serializeJson<T>(value: T[] | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return JSON.stringify(value)
}

function parseJsonArray(value: string | null): string[] | null {
  if (value === null || value === "") return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

type RawRow = typeof wikiEvents.$inferSelect

function hydrate(row: RawRow): WikiEvent {
  return {
    id: row.id,
    ts: row.ts,
    alias: row.alias,
    action: row.action as WikiEventAction,
    path: row.path,
    baseHash: row.baseHash,
    contentHash: row.contentHash,
    attemptedHash: row.attemptedHash,
    diffSummary: row.diffSummary,
    sourceMessageIds: parseJsonArray(row.sourceMessageIds),
    promotionTarget: row.promotionTarget,
    reason: row.reason,
    fencingToken: row.fencingToken,
    leaderTerm: row.leaderTerm,
    result: row.result as WikiEventResult,
    error: row.error,
    state: row.state as WikiEventState,
    resultManifestVersion: row.resultManifestVersion,
  }
}
