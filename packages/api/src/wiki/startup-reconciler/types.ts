/**
 * F027 P7.5 · Startup Reconciler 类型
 * 真相源：docs/plans/V16.5-final.md chap 5 行 506-517 + chap 8 行 918-925
 *
 * 启动时一次性跑：
 *   - wiki_events.state='pending' → 比 attempted/base 文件 hash → commit / aborted / aborted_dirty
 *   - room_checkpoints.committed_at IS NULL → 委托 P7 RoomCompiler.recoverIncomplete()
 *
 * AC：kill -9 后重启状态恢复（fixture 模拟 crash）。
 */

import type { ReconcileReport as RoomCheckpointReconcileReport } from "../room-compiler/types"

export type WikiEventReconcileVerdict =
  /** file_hash == attemptedHash → write 已落盘但 commit 失败 → 改 state='committed' */
  | "committed_via_attempted"
  /**
   * file_hash == baseHash（含 null==null 即"新文件未写"场景） → write 没生效 →
   * state='aborted'，reason='clean_rollback'
   */
  | "aborted_clean"
  /**
   * file_hash 既不是 attempted 也不是 base → 第三方污染 / 半写残留 / 误操作 →
   * state='aborted'，reason='aborted_dirty'。logger 告警，不自动恢复（V16.5 chap 5）。
   */
  | "aborted_dirty"
  /** CAS 失败（race：被并发 settle 了）→ noop */
  | "noop_race_settled"

export interface WikiEventReconcileDetail {
  eventId: number
  path: string
  action: string
  alias: string
  verdict: WikiEventReconcileVerdict
  fileHash: string | null
  attemptedHash: string | null
  baseHash: string | null
}

export interface WikiEventReconcileSummary {
  scanned: number
  committed: number
  abortedClean: number
  abortedDirty: number
  noopRaceSettled: number
  details: WikiEventReconcileDetail[]
}

export interface StartupReconcileReport {
  startedAt: string
  finishedAt: string
  wikiEvents: WikiEventReconcileSummary
  roomCheckpoints: RoomCheckpointReconcileReport
  /** 高危事件计数（dirty 触发外部告警）—— P11 evidence pack 拉这个数 */
  alerts: {
    abortedDirtyCount: number
  }
}

export class StartupReconcilerError extends Error {
  constructor(
    public readonly stage: "wiki_events" | "room_checkpoints",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = "StartupReconcilerError"
  }
}
