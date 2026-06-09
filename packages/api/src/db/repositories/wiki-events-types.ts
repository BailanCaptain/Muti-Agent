/**
 * F027 P1 · wiki_events 域类型 + 状态机契约
 * 真相源：docs/plans/V16.5-final.md chap 5
 *
 * 状态机：
 *   appendPending ──► pending ──commit──► committed
 *                              └─abort──► aborted
 *
 * 重复的 commit/abort 是 noop（CAS WHERE state='pending'）；
 * commit-on-aborted / abort-on-committed 不会改 row（caller 看 false 自决）。
 */

export type WikiEventState = "pending" | "committed" | "aborted"

export type WikiEventAction =
  | "write"
  | "append"
  | "patch"
  | "ingest"
  | "promote"
  | "demote"
  | "delete"
  /**
   * F027 Phase 3 P20 Day 9 c (AC-P3-9 c) — Adaptive Recall L5 escalate audit。
   * 不写文件、不改 wiki entity；纯 audit row，path 用 `audit/recall/<roomId>/<ts>` 约定。
   * 由 ProductionLevel5Sink (wiki/adaptive-recall/level5-escalate-sink.ts) 写入：
   * appendPending → 立即 commit（contentHash = attemptedHash = sha256(reason)）。
   */
  | "recall_escalate"
  /**
   * F027 Phase 4 AC-P4-9 a — DriftDetector / ChainedAlertNotifier / V14PromoteAuditService
   * 等 jobs/services 落 wiki/warnings/*.md 时写 audit row。
   * 由 WarningsTab merge wiki_events action='warning_raised' 显示 (plan line 253)。
   */
  | "warning_raised"

/**
 * V16.5 chap 5 列表：write 流程的 result 枚举（写意图的结局）。
 * "ok" = 落 pending 时认定可写；reconciler / commit 阶段才决定 state。
 */
export type WikiEventResult =
  | "ok"
  | "conflict"
  | "denied_acl"
  | "lease_expired"
  | "schema_invalid"
  | "stale_token"
  | "leader_changed"

/** Hydrated row（JSON 字段已解析）。db row 通过 hydrate() 转过来。 */
export interface WikiEvent {
  id: number
  ts: string
  alias: string
  action: WikiEventAction
  path: string
  baseHash: string | null
  contentHash: string | null
  attemptedHash: string | null
  diffSummary: string | null
  sourceMessageIds: string[] | null
  promotionTarget: string | null
  reason: string | null
  fencingToken: string
  leaderTerm: string
  result: WikiEventResult
  error: string | null
  state: WikiEventState
  resultManifestVersion: string | null
}

/**
 * PREPARE 阶段输入。attemptedHash 必填 —— reconciler 启动时拿它对比文件
 * 实际 hash 决定 commit/abort（V16.5 chap 5 Startup Reconciler）。
 */
export interface AppendPendingInput {
  ts: string
  alias: string
  action: WikiEventAction
  path: string
  baseHash?: string | null
  attemptedHash: string
  diffSummary?: string | null
  sourceMessageIds?: string[] | null
  promotionTarget?: string | null
  reason?: string | null
  fencingToken: string
  leaderTerm: string
  result?: WikiEventResult
}

export interface CommitInput {
  contentHash: string
  resultManifestVersion?: string | null
}

export interface AbortInput {
  error?: string | null
  reason?: string | null
}
