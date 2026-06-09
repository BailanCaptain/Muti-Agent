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
import { assertSafePathSegment } from "./path-segment"
import {
  type CreateSessionInput,
  type EndSessionInput,
  type OpenThread,
  type RoomAgentSession,
  sanitizeOpenThreads,
} from "./types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export class RoomAgentSessionsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * 创建 session 行：session_seq = max(同 room/alias) + 1。
   *
   * 范-r1 P1-1 修：roomId / alias 走 assertSafePathSegment 校验
   * （这两字段会直接拼到 wiki/rooms/<roomId>/agent-sessions/<alias>/...，
   * 防 alias='..' / 含路径分隔符 / Windows 非法字符）。
   *
   * 范-r1 P1-2 修：SELECT max + INSERT 包在 db.transaction()（drizzle 走 better-sqlite3
   * deferred 事务 + SQLite WAL 串行写入）。原 SELECT-then-INSERT 是 TOCTOU：两并发
   * createSession 读到同 max → 同 seq → 第二个 INSERT 撞 UNIQUE。包事务后串行化。
   */
  createSession(input: CreateSessionInput): RoomAgentSession {
    const safeRoomId = assertSafePathSegment("roomId", input.roomId)
    const safeAlias = assertSafePathSegment("alias", input.alias)
    // 范-r2 P1-2 修：必须 BEGIN IMMEDIATE，不是默认 BEGIN DEFERRED。
    //   DEFERRED：两连接都 BEGIN → 都 SELECT 拿 max=N → A INSERT(N+1) commit OK
    //             → B INSERT(N+1) 撞 SQLITE_BUSY_SNAPSHOT 或 UNIQUE 失败
    //   IMMEDIATE：BEGIN 时即拿 RESERVED 写锁 → 第二个 BEGIN 等到第一个 commit
    //              再读 max → 拿到 N+1 → INSERT(N+2) 串行成功
    // drizzle better-sqlite3 driver: { behavior: 'immediate' } 会路由到 wrapper.immediate
    // (drizzle-instance.ts createNodeSqliteAdapter 已暴露 wrapper.immediate)
    const row = this.db.transaction(
      (tx) => {
        const last = tx
          .select({ sessionSeq: roomAgentSessions.sessionSeq })
          .from(roomAgentSessions)
          .where(
            and(eq(roomAgentSessions.roomId, safeRoomId), eq(roomAgentSessions.alias, safeAlias)),
          )
          .orderBy(desc(roomAgentSessions.sessionSeq))
          .limit(1)
          .get()
        const next = (last?.sessionSeq ?? 0) + 1
        return tx
          .insert(roomAgentSessions)
          .values({
            roomId: safeRoomId,
            alias: safeAlias,
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
      },
      { behavior: "immediate" },
    )
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
    // F027 v3 G10 · sanitize 过滤格式错的 entry (老 DB row schema 漂时不 silent 传 UI)
    openThreads: sanitizeOpenThreadsField(row.openThreads),
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

/**
 * F027 v3 G10 · open_threads field 专用 hydrate (复用 parseJsonOrEmpty + 加 type guard 过滤)
 * sanitizeOpenThreads 只保留 valid entry (string or {text, a2a_call_id?}), 丢非法格式.
 */
function sanitizeOpenThreadsField(value: string | null): OpenThread[] {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  const { valid } = sanitizeOpenThreads(parsed)
  return valid
}
