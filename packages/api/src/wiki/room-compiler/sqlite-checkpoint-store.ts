/**
 * F027 P7 · CheckpointStore SQLite 实现
 * 真相源：docs/plans/V16.5-final.md chap 8 行 865-878 + 911-925
 *
 * 用 drizzle adapter 的 prepare/run/all/get（与 createNodeSqliteAdapter 兼容；
 * 同时也可直接接受 better-sqlite3 Database —— 两边 API surface 相同）。
 */

import type { CheckpointStore } from "./room-compiler"
import type { RoomCheckpointRow } from "./types"

/**
 * 结构性类型 —— 既匹配 `node:sqlite` adapter（`createNodeSqliteAdapter` 的返回值）
 * 也匹配 `better-sqlite3 Database`。两者的 prepare/run/all/get API 完全兼容。
 */
export interface SqliteAdapterLike {
  prepare(sql: string): {
    // node:sqlite 返 `number | bigint`，better-sqlite3 返 `number` —— 取并集
    run(...params: any[]): { changes: number | bigint; lastInsertRowid?: number | bigint }
    all(...params: any[]): unknown[]
    get(...params: any[]): unknown
  }
}

interface RawRow {
  room_id: string
  cursor_commit_seq: number
  cursor_message_id: string
  sealed_cursor_seq: number
  viewfinder_hash: string
  decisions_hash: string
  log_hash: string
  thread_seal_id: string | null
  compiled_at: string
  committed_at: string | null
  fencing_token: string
  leader_term: string
}

function mapRow(r: RawRow): RoomCheckpointRow {
  return {
    roomId: r.room_id,
    cursorCommitSeq: r.cursor_commit_seq,
    cursorMessageId: r.cursor_message_id,
    sealedCursorSeq: r.sealed_cursor_seq,
    viewfinderHash: r.viewfinder_hash,
    decisionsHash: r.decisions_hash,
    logHash: r.log_hash,
    threadSealId: r.thread_seal_id,
    compiledAt: r.compiled_at,
    committedAt: r.committed_at,
    fencingToken: r.fencing_token,
    leaderTerm: r.leader_term,
  }
}

export class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly db: SqliteAdapterLike) {}

  read(roomId: string): RoomCheckpointRow | null {
    const row = this.db.prepare("SELECT * FROM room_checkpoints WHERE room_id = ?").get(roomId) as
      | RawRow
      | undefined
    return row ? mapRow(row) : null
  }

  /**
   * 范-r1 P2-1 修：Bootstrap 侧读 —— SQL 层 filter committed_at IS NOT NULL，
   * 防 SessionBootstrap 误读 prepare 行（V16.5 chap 8 行 924）。
   */
  readForBootstrap(roomId: string): RoomCheckpointRow | null {
    const row = this.db
      .prepare("SELECT * FROM room_checkpoints WHERE room_id = ? AND committed_at IS NOT NULL")
      .get(roomId) as RawRow | undefined
    return row ? mapRow(row) : null
  }

  prepare(row: Omit<RoomCheckpointRow, "committedAt">): void {
    // Upsert：同 room 已有 row（无论 committed 与否）→ 覆盖 prepare
    // 不变量：committed_at 强制写回 NULL
    this.db
      .prepare(`
        INSERT INTO room_checkpoints (
          room_id, cursor_commit_seq, cursor_message_id,
          sealed_cursor_seq, viewfinder_hash, decisions_hash, log_hash,
          thread_seal_id, compiled_at, committed_at, fencing_token, leader_term
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          cursor_commit_seq = excluded.cursor_commit_seq,
          cursor_message_id = excluded.cursor_message_id,
          sealed_cursor_seq = excluded.sealed_cursor_seq,
          viewfinder_hash = excluded.viewfinder_hash,
          decisions_hash = excluded.decisions_hash,
          log_hash = excluded.log_hash,
          thread_seal_id = excluded.thread_seal_id,
          compiled_at = excluded.compiled_at,
          committed_at = NULL,
          fencing_token = excluded.fencing_token,
          leader_term = excluded.leader_term
      `)
      .run(
        row.roomId,
        row.cursorCommitSeq,
        row.cursorMessageId,
        row.sealedCursorSeq,
        row.viewfinderHash,
        row.decisionsHash,
        row.logHash,
        row.threadSealId,
        row.compiledAt,
        row.fencingToken,
        row.leaderTerm,
      )
  }

  commit(roomId: string, compiledAt: string, committedAt: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE room_checkpoints
           SET committed_at = ?
         WHERE room_id = ? AND compiled_at = ? AND committed_at IS NULL
      `)
      .run(committedAt, roomId, compiledAt)
    return Number(result.changes) > 0
  }

  listIncomplete(): RoomCheckpointRow[] {
    const rows = this.db
      .prepare("SELECT * FROM room_checkpoints WHERE committed_at IS NULL")
      .all() as RawRow[]
    return rows.map(mapRow)
  }

  deletePrepare(roomId: string, compiledAt: string): boolean {
    const result = this.db
      .prepare(`
        DELETE FROM room_checkpoints
         WHERE room_id = ? AND compiled_at = ? AND committed_at IS NULL
      `)
      .run(roomId, compiledAt)
    return Number(result.changes) > 0
  }
}
