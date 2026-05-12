/**
 * F027 P8 · RoomAgentSessionsRepository
 * 真相源：docs/plans/V16.5-final.md chap 9 行 984-1003
 *
 * 职责：
 *   - createSession(input)：分配 session_seq（per-room+alias 自增）+ INSERT，返回 row
 *   - endSession(sessionId, input)：补 ended_at + exit_reason + digest 等
 *   - getLatestActive(roomId, alias)：current.md 派生用（最新 archived='N' 行）
 *   - listForYearlyPack(year)：扫所有 ended_at 在 <year> 且 archived='N' 的行
 *   - markArchived(sessionIds, year)：yearly pack 写盘后批量改 archived='Y'
 *   - countActivePerRoomAlias()：100k sharding stress test 用（active < 1k AC）
 */

import { and, asc, desc, eq, like, lt } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { roomAgentSessions } from "../../db/schema"
import type * as schema from "../../db/schema"
import type { CreateSessionInput, EndSessionInput, OpenThread, RoomAgentSession } from "./types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export class RoomAgentSessionsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * 创建 session 行：session_seq = max(同 room/alias) + 1。
   * 并发安全：UNIQUE(room_id, alias, session_seq) 防重复；冲突时调用方重试。
   */
  createSession(input: CreateSessionInput): RoomAgentSession {
    const next = this.nextSessionSeq(input.roomId, input.alias)
    const row = this.db
      .insert(roomAgentSessions)
      .values({
        roomId: input.roomId,
        alias: input.alias,
        sessionSeq: next,
        startedAt: input.startedAt,
        endedAt: null,
        entryReason: input.entryReason,
        exitReason: null,
        lastSeenCommitSeq: input.lastSeenCommitSeq ?? null,
        openThreads: null,
        closedThreads: null,
        privateNotesHash: null,
        sessionDigest: null,
        archived: "N",
        archivedAt: null,
        archivedYear: null,
      })
      .returning()
      .get()
    return hydrate(row)
  }

  /**
   * 结束 session：补 ended_at + exit_reason + digest 等。
   * 不允许 endSession 一个 archived='Y' 的 row（spec：archive 是末态）。
   */
  endSession(sessionId: number, input: EndSessionInput): boolean {
    const result = this.db
      .update(roomAgentSessions)
      .set({
        endedAt: input.endedAt,
        exitReason: input.exitReason,
        lastSeenCommitSeq: input.lastSeenCommitSeq ?? null,
        openThreads: input.openThreads ? JSON.stringify(input.openThreads) : null,
        closedThreads: input.closedThreads ? JSON.stringify(input.closedThreads) : null,
        privateNotesHash: input.privateNotesHash ?? null,
        sessionDigest: input.sessionDigest ?? null,
      })
      .where(and(eq(roomAgentSessions.sessionId, sessionId), eq(roomAgentSessions.archived, "N")))
      .run()
    return Number(result.changes) > 0
  }

  /** 按 ID 拿（含 archived 行；archive/debug 用）。 */
  get(sessionId: number): RoomAgentSession | null {
    const row = this.db
      .select()
      .from(roomAgentSessions)
      .where(eq(roomAgentSessions.sessionId, sessionId))
      .get()
    return row ? hydrate(row) : null
  }

  /**
   * current.md 派生 hot path：拿最新一条 archived='N' 行。
   * chap 9 行 1083：wake-up 注入 current；不扫 S 文件。
   */
  getLatestActive(roomId: string, alias: string): RoomAgentSession | null {
    const row = this.db
      .select()
      .from(roomAgentSessions)
      .where(
        and(
          eq(roomAgentSessions.roomId, roomId),
          eq(roomAgentSessions.alias, alias),
          eq(roomAgentSessions.archived, "N"),
        ),
      )
      .orderBy(desc(roomAgentSessions.sessionSeq))
      .limit(1)
      .get()
    return row ? hydrate(row) : null
  }

  /** 列 active S-XXXX 行（按 sessionSeq asc）—— ledger writer + 100k 测试用。 */
  listActiveForRoomAlias(roomId: string, alias: string): RoomAgentSession[] {
    const rows = this.db
      .select()
      .from(roomAgentSessions)
      .where(
        and(
          eq(roomAgentSessions.roomId, roomId),
          eq(roomAgentSessions.alias, alias),
          eq(roomAgentSessions.archived, "N"),
        ),
      )
      .orderBy(asc(roomAgentSessions.sessionSeq))
      .all()
    return rows.map(hydrate)
  }

  /**
   * Yearly pack 扫描：所有 ended_at < <yearStart>-01-01 且 archived='N' 的行。
   * 用 lt(ended_at, cutoffIso) + LIKE pattern 双保险（防 ended_at 字符串排序坑）。
   */
  listForYearlyPack(year: number): RoomAgentSession[] {
    // chap 9 行 1068："上一年 S-XXXX.md 合并成 <year>.md"
    // 实施时 year = 当前 - 1；cutoff = (year + 1) 年初；archived='N' + ended_at non-null
    const cutoffIso = `${year + 1}-01-01T00:00:00Z`
    const rows = this.db
      .select()
      .from(roomAgentSessions)
      .where(
        and(
          eq(roomAgentSessions.archived, "N"),
          // ended_at 非空且 < cutoff（drizzle 没 isNotNull helper 这里用 like '%' 兜底）
          like(roomAgentSessions.endedAt, "%"),
          lt(roomAgentSessions.endedAt, cutoffIso),
        ),
      )
      .orderBy(
        asc(roomAgentSessions.roomId),
        asc(roomAgentSessions.alias),
        asc(roomAgentSessions.sessionSeq),
      )
      .all()
    return rows.map(hydrate)
  }

  /** Yearly pack 写盘后批量改 archived='Y'。 */
  markArchived(sessionIds: number[], year: number, archivedAt: string): number {
    if (sessionIds.length === 0) return 0
    let total = 0
    // SQLite IN clause 安全：caller 控数（yearly pack ≤ 100k/year 也能跑）
    // 拆批 500 防 SQL 长度限
    const BATCH = 500
    for (let i = 0; i < sessionIds.length; i += BATCH) {
      const slice = sessionIds.slice(i, i + BATCH)
      for (const id of slice) {
        const r = this.db
          .update(roomAgentSessions)
          .set({ archived: "Y", archivedAt, archivedYear: year })
          .where(and(eq(roomAgentSessions.sessionId, id), eq(roomAgentSessions.archived, "N")))
          .run()
        total += Number(r.changes)
      }
    }
    return total
  }

  /**
   * 100k sharding stress test 用：返 (roomId, alias) → active count map。
   * AC-P1-8：100k session 模拟 + active < 1k（yearly pack 后）。
   */
  countActivePerRoomAlias(): Map<string, number> {
    const rows = this.db
      .select({
        roomId: roomAgentSessions.roomId,
        alias: roomAgentSessions.alias,
        sessionId: roomAgentSessions.sessionId,
      })
      .from(roomAgentSessions)
      .where(eq(roomAgentSessions.archived, "N"))
      .all()
    const m = new Map<string, number>()
    for (const r of rows) {
      const key = `${r.roomId}::${r.alias}`
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
  }

  /** Active 总数 —— AC-P1-8 直接断言。 */
  countAllActive(): number {
    const rows = this.db
      .select({ sessionId: roomAgentSessions.sessionId })
      .from(roomAgentSessions)
      .where(eq(roomAgentSessions.archived, "N"))
      .all()
    return rows.length
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private nextSessionSeq(roomId: string, alias: string): number {
    const row = this.db
      .select({ sessionSeq: roomAgentSessions.sessionSeq })
      .from(roomAgentSessions)
      .where(and(eq(roomAgentSessions.roomId, roomId), eq(roomAgentSessions.alias, alias)))
      .orderBy(desc(roomAgentSessions.sessionSeq))
      .limit(1)
      .get()
    return (row?.sessionSeq ?? 0) + 1
  }
}

function hydrate(row: typeof roomAgentSessions.$inferSelect): RoomAgentSession {
  return {
    sessionId: row.sessionId,
    roomId: row.roomId,
    alias: row.alias,
    sessionSeq: row.sessionSeq,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    entryReason: row.entryReason,
    exitReason: row.exitReason,
    lastSeenCommitSeq: row.lastSeenCommitSeq,
    openThreads: parseJsonOrEmpty<OpenThread>(row.openThreads),
    closedThreads: parseJsonOrEmpty<string>(row.closedThreads),
    privateNotesHash: row.privateNotesHash,
    sessionDigest: row.sessionDigest,
    archived: row.archived as "N" | "Y",
    archivedAt: row.archivedAt,
    archivedYear: row.archivedYear,
  }
}

function parseJsonOrEmpty<T>(value: string | null): T[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}
