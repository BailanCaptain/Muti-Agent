/**
 * F027 Phase 4 (hotfix Week 5 Day 23 — 小孙浏览器实测发现):
 * createProductionRoomCompileExecutor — 真业务接入 RoomCompilerTick
 *
 * 真相源:
 *   - plan §1.4 主线 B go-live "AdaptiveRecallCoordinator production boot" 同精神
 *   - scheduler-bootstrap.ts:19 注释 "Phase 4 P19/22 接 room compile" (本次接入)
 *   - V16.5 chap 11 (viewfinder) + chap 8 (room-compiler 二阶段提交)
 *   - 复用: createViewfinderCompileFn (P12) + SqliteCheckpointStore + DecisionLedger + HaikuDecisionJudge
 *
 * Before (noop):
 *   compileExecutor: async () => ({ roomsProcessed: 0 })
 *   → viewfinder.md 不生成 → GET /api/rooms/:id/viewfinder 永返 viewfinder=null
 *   → coverage.status="fail" + lastCompiledAt=null → system prompt 无 viewfinder section
 *
 * After (真业务):
 *   compileExecutor: scan active rooms → 对每个 newMessages 非空 → RoomCompiler.run()
 *   → 生成 wiki/rooms/<roomId>/{viewfinder,decisions,log}.md
 *   → viewfinder endpoint 返真内容 + system prompt 注入 viewfinder section
 *
 * 设计 (最小可工作 — minimum viable wire):
 *   1. 扫所有 session_groups (distinct id, 即 room id)
 *   2. 对每个 room:
 *      a. read prev checkpoint (SqliteCheckpointStore.read)
 *      b. 查 newMessages (cursor > prev?.cursorCommitSeq, 或全部 if no prev)
 *      c. newMessages.length === 0 → skip (避免无意义 LLM call)
 *      d. newMessages > 0 → RoomCompiler.run(roomId, newMessages, newSeals)
 *   3. 返 { roomsProcessed: N (真编译数) }
 *
 * Judge runner:
 *   - 复用 P4-8 createRunnerWithFallback (primary Sonnet + Haiku fallback)
 *   - 失败时 HaikuDecisionJudge.judge() throw → extractor 标 unresolved → 不阻塞 RoomCompiler
 *
 * Fail-soft (per existing RoomCompiler 行为):
 *   - 单 room compile 失败 → 抛 RoomCompilerError, 但不影响其他 room (caller 加 try/catch)
 *   - 全 room compile 失败 → executor 返 { roomsProcessed: 0 }, 不抛错 (per RoomCompilerTick spec)
 */

import path from "node:path"

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyBaseLogger } from "fastify"

import type * as schema from "../db/schema"
import type { HaikuRunner } from "../runtime/haiku-runner"
import {
  HaikuDecisionJudge,
  type HaikuLike,
} from "../wiki/viewfinder/decision-extractor"
import { DecisionLedger } from "../wiki/viewfinder/decision-ledger"
import { createViewfinderCompileFn } from "../wiki/viewfinder/compile-fn"
import { RoomCompiler } from "../wiki/room-compiler/room-compiler"
import { SqliteCheckpointStore } from "../wiki/room-compiler/sqlite-checkpoint-store"
import type {
  MessageCommitRow,
  ThreadSealRow,
} from "../wiki/room-compiler/types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

/** Per-room compile attempt outcome (logged, 不抛). */
interface RoomCompileAttempt {
  roomId: string
  newMessagesCount: number
  status: "ok" | "skipped_no_messages" | "failed"
  error?: string
}

export interface ProductionRoomCompileExecutorOptions {
  db: DrizzleDb
  /** wiki root (e.g. .runtime/wiki/ or worktree preview /.runtime/worktree-preview/data/wiki/) */
  wikiRoot: string
  /** judge runner (Sonnet + Haiku fallback wrap). Will be used by HaikuDecisionJudge. */
  judgeRunner: HaikuRunner
  /** Leader context — fencingToken + leaderTerm getter. */
  leaderContext: {
    currentLeaderTerm(): string
    newFencingToken(): string
  }
  logger?: FastifyBaseLogger
  /** Judge timeout ms (default 30000, Sonnet 比 Haiku 慢). */
  judgeTimeoutMs?: number
  /** Judge concurrency limit (default 4 — 防 spawn 风暴). */
  judgeConcurrency?: number
  /** rootDir for git log spawn (compile-fn 内 phase coord), 默认 process.cwd(). */
  rootDir?: string
}

export interface CompileExecutorResult {
  roomsProcessed: number
}

/**
 * Wrap drizzle db 成 SqliteAdapterLike 接口 (compile-fn / store 期望).
 * Drizzle 内部用 better-sqlite3, db 实例本身有 .prepare/.run/.all/.get.
 */
function adaptDrizzleDb(db: DrizzleDb): {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint }
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
} {
  // drizzle BetterSQLite3Database 有 `$client` 是真 better-sqlite3 Database
  // 但有些版本暴露不一样, 走 generic unknown cast 拿底层
  const dbAny = db as unknown as {
    $client?: ReturnType<typeof adaptDrizzleDb>
    session?: { client?: ReturnType<typeof adaptDrizzleDb> }
  }
  const underlying =
    dbAny.$client ??
    dbAny.session?.client ??
    (db as unknown as ReturnType<typeof adaptDrizzleDb>)
  return underlying
}

/**
 * 扫活跃 rooms — 取 session_groups.room_id (alias 如 "R-001", 不是 UUID primary key id).
 * 注意: session_groups.id = UUID (DB 主键), session_groups.room_id = "R-001" (display alias).
 * viewfinder endpoint + ViewfinderService + querySessionGroupByRoomId 全用 alias 查.
 * future optimization: 加 last_activity_at 过滤 (过去 30min 活跃才扫).
 */
function scanActiveRoomIds(
  adapter: ReturnType<typeof adaptDrizzleDb>,
): string[] {
  const rows = adapter
    .prepare("SELECT DISTINCT room_id FROM session_groups WHERE room_id IS NOT NULL")
    .all() as ReadonlyArray<{ room_id: string }>
  return rows.map((r) => r.room_id)
}

/**
 * Backfill message_commit_seq from existing messages (一次性, idempotent).
 * 解决: F027 P7 chap 8 spec 要求 message-service 同事务 INSERT message_commit_seq,
 * 但 Phase 1-3 没接 → message_commit_seq 一直空 → RoomCompileExecutor 每个 room
 * newMessages=0 → viewfinder 永 null.
 *
 * INSERT OR IGNORE 防 conflict (已有的 msg_id 跳过).
 * 用 messages.created_at 作 committed_at — 保留时序信息.
 * ORDER BY created_at ASC 让 commit_seq autoincrement 跟创建时序一致.
 */
export function backfillMessageCommitSeq(
  adapter: ReturnType<typeof adaptDrizzleDb>,
): { backfilled: number } {
  const before = (adapter.prepare("SELECT COUNT(*) AS n FROM message_commit_seq").get() as {
    n: number
  }).n
  adapter
    .prepare(
      "INSERT OR IGNORE INTO message_commit_seq (message_id, committed_at) " +
        "SELECT m.id, m.created_at FROM messages m " +
        "WHERE NOT EXISTS (SELECT 1 FROM message_commit_seq mcs WHERE mcs.message_id = m.id) " +
        "ORDER BY m.created_at ASC, m.rowid ASC",
    )
    .run()
  const after = (adapter.prepare("SELECT COUNT(*) AS n FROM message_commit_seq").get() as {
    n: number
  }).n
  return { backfilled: after - before }
}

/**
 * 查给定 room 的新消息 (seq > prevCursor).
 * 用 message_commit_seq 表 (F027 P7 chap 8), JOIN messages + threads + session_groups.
 * roomId 是 alias (如 "R-001"), JOIN session_groups.room_id 拿到 session_groups.id (UUID).
 */
function queryNewMessages(
  adapter: ReturnType<typeof adaptDrizzleDb>,
  roomId: string,
  prevCursor: number,
): MessageCommitRow[] {
  const rows = adapter
    .prepare(
      "SELECT mcs.seq, mcs.message_id, mcs.committed_at, m.role " +
        "FROM message_commit_seq mcs " +
        "JOIN messages m ON m.id = mcs.message_id " +
        "JOIN threads t ON t.id = m.thread_id " +
        "JOIN session_groups sg ON sg.id = t.session_group_id " +
        "WHERE sg.room_id = ? AND mcs.seq > ? " +
        "ORDER BY mcs.seq ASC LIMIT 200",
    )
    .all(roomId, prevCursor) as ReadonlyArray<{
    seq: number
    message_id: string
    committed_at: string
    role: string
  }>
  return rows.map((r) => ({
    seq: r.seq,
    messageId: r.message_id,
    committedAt: r.committed_at,
    role: (r.role === "user" || r.role === "assistant" || r.role === "system" || r.role === "tool"
      ? r.role
      : undefined) as MessageCommitRow["role"],
  }))
}

/**
 * 查给定 room 的新 seals (seq > prevSealedCursor).
 * 用 thread_seal_events 表 (F027 P7 chap 8); room_id 直接列, 无需 JOIN.
 */
function queryNewSeals(
  adapter: ReturnType<typeof adaptDrizzleDb>,
  roomId: string,
  prevSealedCursor: number,
): ThreadSealRow[] {
  try {
    const rows = adapter
      .prepare(
        "SELECT seq, thread_id, room_id, sealed_at, fencing_token " +
          "FROM thread_seal_events " +
          "WHERE room_id = ? AND seq > ? " +
          "ORDER BY seq ASC LIMIT 200",
      )
      .all(roomId, prevSealedCursor) as ReadonlyArray<{
      seq: number
      thread_id: string
      room_id: string
      sealed_at: string
      fencing_token: string
    }>
    return rows.map((r) => ({
      seq: r.seq,
      threadId: r.thread_id,
      roomId: r.room_id,
      sealedAt: r.sealed_at,
      fencingToken: r.fencing_token,
    }))
  } catch {
    // thread_seal_events 表不存在 (老 schema) → 返空 (compile-fn 允许 empty seals)
    return []
  }
}

/**
 * F027 P4 hotfix · 单 room 强制重编 (小孙浏览器手动触发).
 *
 * scheduler 5min tick 间隔太长 + 新房间没等 boot tick → "取景器还是没有".
 * 加 UI 按钮调本 helper → 后端立刻编单 room → 5s 内 viewfinder.md 落盘.
 *
 * force=true: 清 store cursor → RoomCompiler 重跑该 room 所有历史 messages (LIMIT 200).
 * force=false: 同 executor — 按 cursor 增量, newMessages=0 则 skip.
 *
 * 用 same deps (judge / ledger / store / compileFn) — 不重新 init.
 */
export function createSingleRoomRecompiler(
  opts: ProductionRoomCompileExecutorOptions,
): (roomId: string, opts?: { force?: boolean }) => Promise<RoomCompileAttempt> {
  const adapter = adaptDrizzleDb(opts.db)
  const store = new SqliteCheckpointStore(adapter)
  const ledger = new DecisionLedger(adapter)
  const judge = new HaikuDecisionJudge(
    opts.judgeRunner as HaikuLike,
    opts.judgeTimeoutMs ?? 30_000,
  )

  return async (
    roomId: string,
    callOpts: { force?: boolean } = {},
  ): Promise<RoomCompileAttempt> => {
    try {
      backfillMessageCommitSeq(adapter)
    } catch (err) {
      opts.logger?.warn(
        { err: (err as Error).message },
        "[single-room-recompile] backfill failed (continue)",
      )
    }

    let prevCursor = 0
    let prevSealedCursor = 0
    if (!callOpts.force) {
      const prev = store.read(roomId)
      prevCursor = prev?.cursorCommitSeq ?? 0
      prevSealedCursor = prev?.sealedCursorSeq ?? 0
    }

    const newMessages = queryNewMessages(adapter, roomId, prevCursor)
    const newSeals = queryNewSeals(adapter, roomId, prevSealedCursor)

    if (newMessages.length === 0) {
      return {
        roomId,
        newMessagesCount: 0,
        status: "skipped_no_messages",
      }
    }

    try {
      const compileFn = createViewfinderCompileFn({
        db: adapter,
        ledger,
        judge,
        fencingToken: opts.leaderContext.newFencingToken(),
        leaderTerm: opts.leaderContext.currentLeaderTerm(),
        judgeTimeoutMs: opts.judgeTimeoutMs,
        judgeConcurrency: opts.judgeConcurrency,
        rootDir: opts.rootDir,
      })
      const compiler = new RoomCompiler({
        store,
        wikiRoot: opts.wikiRoot,
        compileFn,
        fencingToken: opts.leaderContext.newFencingToken(),
        leaderTerm: opts.leaderContext.currentLeaderTerm(),
      })
      await compiler.run({ roomId, newMessages, newSeals })
      opts.logger?.info(
        { roomId, newMessagesCount: newMessages.length, force: callOpts.force ?? false },
        "[single-room-recompile] ok",
      )
      return { roomId, newMessagesCount: newMessages.length, status: "ok" }
    } catch (err) {
      const error = (err as Error).message
      opts.logger?.warn({ roomId, err: error }, "[single-room-recompile] failed")
      return { roomId, newMessagesCount: -1, status: "failed", error }
    }
  }
}

export function createProductionRoomCompileExecutor(
  opts: ProductionRoomCompileExecutorOptions,
): () => Promise<CompileExecutorResult> {
  const adapter = adaptDrizzleDb(opts.db)
  const store = new SqliteCheckpointStore(adapter)
  const ledger = new DecisionLedger(adapter)
  const judge = new HaikuDecisionJudge(
    opts.judgeRunner as HaikuLike,
    opts.judgeTimeoutMs ?? 30_000,
  )

  return async (): Promise<CompileExecutorResult> => {
    const attempts: RoomCompileAttempt[] = []
    let processed = 0

    // 每次 tick 前 backfill (idempotent; INSERT OR IGNORE 跳已有)
    try {
      const { backfilled } = backfillMessageCommitSeq(adapter)
      if (backfilled > 0) {
        opts.logger?.info(
          { backfilled },
          "[room-compile-executor] backfilled message_commit_seq from messages",
        )
      }
    } catch (err) {
      opts.logger?.warn(
        { err: (err as Error).message },
        "[room-compile-executor] backfill failed (continue tick)",
      )
    }

    let roomIds: string[]
    try {
      roomIds = scanActiveRoomIds(adapter)
    } catch (err) {
      opts.logger?.warn(
        { err: (err as Error).message },
        "[room-compile-executor] scan active rooms failed; skip tick",
      )
      return { roomsProcessed: 0 }
    }

    if (roomIds.length === 0) {
      return { roomsProcessed: 0 }
    }

    for (const roomId of roomIds) {
      try {
        const prev = store.read(roomId)
        const prevCursor = prev?.cursorCommitSeq ?? 0
        const prevSealedCursor = prev?.sealedCursorSeq ?? 0

        const newMessages = queryNewMessages(adapter, roomId, prevCursor)
        const newSeals = queryNewSeals(adapter, roomId, prevSealedCursor)

        if (newMessages.length === 0) {
          attempts.push({
            roomId,
            newMessagesCount: 0,
            status: "skipped_no_messages",
          })
          continue
        }

        const compileFn = createViewfinderCompileFn({
          db: adapter,
          ledger,
          judge,
          fencingToken: opts.leaderContext.newFencingToken(),
          leaderTerm: opts.leaderContext.currentLeaderTerm(),
          judgeTimeoutMs: opts.judgeTimeoutMs,
          judgeConcurrency: opts.judgeConcurrency,
          rootDir: opts.rootDir,
        })

        const compiler = new RoomCompiler({
          store,
          wikiRoot: opts.wikiRoot,
          compileFn,
          fencingToken: opts.leaderContext.newFencingToken(),
          leaderTerm: opts.leaderContext.currentLeaderTerm(),
        })

        await compiler.run({ roomId, newMessages, newSeals })
        processed++
        attempts.push({ roomId, newMessagesCount: newMessages.length, status: "ok" })
      } catch (err) {
        attempts.push({
          roomId,
          newMessagesCount: -1,
          status: "failed",
          error: (err as Error).message,
        })
        opts.logger?.warn(
          { roomId, err: (err as Error).message },
          "[room-compile-executor] room compile failed; continue with next room",
        )
      }
    }

    if (attempts.length > 0) {
      opts.logger?.info(
        { processed, attempts: attempts.length, breakdown: attempts },
        "[room-compile-executor] tick complete",
      )
    }
    return { roomsProcessed: processed }
  }
}
