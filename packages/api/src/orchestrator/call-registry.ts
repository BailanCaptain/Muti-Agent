import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { PendingChangePayload, RealtimeServerEvent } from "@multi-agent/shared"

/**
 * F026 ADR-002 · Call Tree 协议真相源
 *
 * Status 状态机：
 *   pending  → working                         (advance)
 *   working  → {done | failed | timeout | cancelled}   (settle)
 *   pending  → {done | failed | timeout | cancelled}   (settle, 直达终态)
 * 终态不可再转移（CAS 保证）。
 *
 * F026 P5 T4 · pending_change WS emit：
 *   每次 mutation (openCall / advance / settle / handleTimeout) 后 emit 一条
 *   `pending.change` 事件携带 rootCallId 下当前未结算 sibling pendingSet。前端
 *   F1 @pill / F6 Pulse / F10 /debug/a2a 视图据此实时刷新。无 broadcaster 注入时
 *   静默 skip（向后兼容旧 harness）。
 */

export type CallStatus = "pending" | "working" | "done" | "failed" | "timeout" | "cancelled"
export type TerminalStatus = "done" | "failed" | "timeout" | "cancelled"
export type IntermediateStatus = "pending" | "working"

const TERMINAL: ReadonlySet<CallStatus> = new Set(["done", "failed", "timeout", "cancelled"])

export interface OpenCallInput {
  parentCallId?: string
  issuerId: string
  convenerId: string
  onBehalfOf?: string | null
  replyTo: string
  sessionGroupId: string
  deadlineAt: string // ISO
  joinSetId?: string | null
}

export interface CallRow {
  callId: string
  parentCallId: string | null
  rootCallId: string
  issuerId: string
  convenerId: string
  onBehalfOf: string | null
  replyTo: string
  deadlineAt: string
  joinSetId: string | null
  status: CallStatus
  envelopeVersion: string
  sessionGroupId: string
  createdAt: string
  updatedAt: string
}

export interface CallRegistryOptions {
  db: DatabaseSync
  now?: () => string
  newId?: () => string
  /**
   * F026 P5 T4 · WS 广播器（可选）。每次 mutation 后 emit `pending.change` 携带
   * rootCallId 下未结算 sibling pendingSet。生产由 server.ts 注入，测试可缺省。
   */
  broadcaster?: { broadcast(event: RealtimeServerEvent): void }
}

export class CallRegistry {
  private readonly db: DatabaseSync
  private readonly now: () => string
  private readonly newId: () => string
  private readonly broadcaster: { broadcast(event: RealtimeServerEvent): void } | null

  constructor(options: CallRegistryOptions) {
    this.db = options.db
    this.now = options.now ?? (() => new Date().toISOString())
    this.newId = options.newId ?? (() => `call-${randomUUID()}`)
    this.broadcaster = options.broadcaster ?? null
  }

  /**
   * F026 P5 T4 · 计算指定 rootCallId 下当前未结算 sibling 的 pendingSet。
   * 用于 pending_change emit payload 携带的 alias[]。
   * 排除 root 自身（root 是 issuer 自家 call，不是被等待的 sibling）。
   */
  computePendingSet(rootCallId: string): PendingChangePayload["pendingSet"] {
    const rows = this.db
      .prepare(
        `SELECT call_id, issuer_id, status FROM a2a_calls
         WHERE root_call_id = ? AND call_id != ? AND status IN ('pending','working')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(rootCallId, rootCallId) as Array<{ call_id: string; issuer_id: string; status: string }>
    return rows.map((r) => ({
      callId: r.call_id,
      alias: r.issuer_id,
      status: r.status as "pending" | "working",
    }))
  }

  /**
   * F026 P5 T4 · 内部 helper — emit pending_change 事件（无 broadcaster 时 noop）。
   *
   * F026 review#4 fix（A'）· 当 row 已 terminal 时附带 settled = [{callId, alias, status}]，
   * 让前端 thread-store 维护 settledByRoot terminal cache，AtPill 在 pendingByRoot
   * 命不中时能反查终态——不再 fallback 到 message envelope 的 pending snapshot。
   */
  private emitPendingChange(callId: string): void {
    if (!this.broadcaster) return
    const row = this.db
      .prepare(
        "SELECT root_call_id, parent_call_id, session_group_id, issuer_id, status FROM a2a_calls WHERE call_id = ?",
      )
      .get(callId) as
      | {
          root_call_id: string
          parent_call_id: string | null
          session_group_id: string
          issuer_id: string
          status: string
        }
      | undefined
    if (!row) return
    const settled =
      TERMINAL.has(row.status as CallStatus)
        ? [
            {
              callId,
              alias: row.issuer_id,
              status: row.status as TerminalStatus,
            },
          ]
        : []
    const payload: PendingChangePayload = {
      sessionGroupId: row.session_group_id,
      rootCallId: row.root_call_id,
      parentCallId: row.parent_call_id ?? row.root_call_id,
      pendingSet: this.computePendingSet(row.root_call_id),
      settled,
      occurredAt: this.now(),
    }
    this.broadcaster.broadcast({ type: "pending.change", payload })
  }

  openCall(input: OpenCallInput): string {
    if (!input.issuerId) throw new Error("CallRegistry.openCall: issuerId required")
    if (!input.convenerId) throw new Error("CallRegistry.openCall: convenerId required")
    if (!input.replyTo) throw new Error("CallRegistry.openCall: replyTo required")
    if (!input.sessionGroupId) throw new Error("CallRegistry.openCall: sessionGroupId required")
    if (!input.deadlineAt) throw new Error("CallRegistry.openCall: deadlineAt required")

    let rootCallId: string
    const callId = this.newId()

    if (input.parentCallId) {
      const parent = this.db
        .prepare("SELECT root_call_id FROM a2a_calls WHERE call_id = ?")
        .get(input.parentCallId) as { root_call_id: string } | undefined
      if (!parent) {
        throw new Error(`CallRegistry.openCall: parent_call_id '${input.parentCallId}' not found`)
      }
      rootCallId = parent.root_call_id
    } else {
      rootCallId = callId
    }

    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO a2a_calls (
          call_id, parent_call_id, root_call_id,
          issuer_id, convener_id, on_behalf_of,
          reply_to, deadline_at, join_set_id,
          status, envelope_version, session_group_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'v1', ?, ?, ?)`,
      )
      .run(
        callId,
        input.parentCallId ?? null,
        rootCallId,
        input.issuerId,
        input.convenerId,
        input.onBehalfOf ?? null,
        input.replyTo,
        input.deadlineAt,
        input.joinSetId ?? null,
        input.sessionGroupId,
        now,
        now,
      )

    this.emitPendingChange(callId)
    return callId
  }

  /**
   * CAS advance within the non-terminal range (pending → working).
   * Returns true iff the row was actually updated.
   */
  advance(callId: string, to: IntermediateStatus): boolean {
    if (to !== "working") {
      // pending is the initial state; only working is a valid advance target
      throw new Error(`CallRegistry.advance: illegal target '${to}' (only 'working' allowed)`)
    }
    const result = this.db
      .prepare(
        "UPDATE a2a_calls SET status = 'working', updated_at = ? WHERE call_id = ? AND status = 'pending'",
      )
      .run(this.now(), callId)
    if (result.changes === 1) this.emitPendingChange(callId)
    return result.changes === 1
  }

  /**
   * CAS settle to terminal status. Returns true iff a row was actually settled
   * (i.e. it was in pending or working when we ran).
   */
  settle(callId: string, to: TerminalStatus): boolean {
    if (!TERMINAL.has(to)) {
      throw new Error(`CallRegistry.settle: '${to}' is not a terminal status`)
    }
    const result = this.db
      .prepare(
        `UPDATE a2a_calls SET status = ?, updated_at = ?
         WHERE call_id = ? AND status IN ('pending','working')`,
      )
      .run(to, this.now(), callId)
    if (result.changes === 1) this.emitPendingChange(callId)
    return result.changes === 1
  }

  pendingOf(parentCallId: string): CallRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM a2a_calls
         WHERE parent_call_id = ? AND status IN ('pending','working')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(parentCallId) as RawCallRow[]
    return rows.map(toCallRow)
  }

  getTree(rootCallId: string): CallRow[] {
    const rows = this.db
      .prepare("SELECT * FROM a2a_calls WHERE root_call_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(rootCallId) as RawCallRow[]
    return rows.map(toCallRow)
  }

  /**
   * F026 P4 T1 STALE 双档（spec line 373）：
   *   - working past deadline_at（processing 阈值，由 openCall deadline_at 决定）
   *   - pending older than stalePendingMs from createdAt（queued 阈值，
   *     默认 60s · 防 dispatch 失踪后 pending 永挂死）
   * 当 stalePendingMs 不传或 ≤0 时仅扫 working 那条 — 保留旧调用方语义。
   * 返回总扫到的行数（两档相加）。
   *
   * F026 P2 v2 review#2 P1（范德彪 finding）：pending 分支必须排除两类，
   * 否则 a2a_calls 与 a2a_worklists 状态分裂：
   *   1. root call（parent_call_id IS NULL）— root 语义是「召集闭环」，
   *      永不进 working，由 worklist drain-based settle 收敛，不存在 dispatch 失踪概念。
   *   2. 被 active worklist 承载的 child — dispatcher 仍在按 worklist 顺序排队，
   *      pending 60s+ 是合法的（前一个 sibling 还在 working）。
   * 真孤儿 pending（无 active worklist 承载，超阈值）才是真正的 dispatch 失踪 — 仍标 timeout。
   */
  timeoutScan(opts: { stalePendingMs?: number } = {}): number {
    const nowIso = this.now()

    // F026 review#4 fix · SELECT-then-UPDATE 取出受影响 callId 后逐个 emitPendingChange，
    // 让前端 thread-store.settledByRoot 收到终态广播；之前 batch UPDATE 不 emit，
    // AtPill 永远拿不到 timeout 状态。
    const workingRows = this.db
      .prepare(
        `SELECT call_id FROM a2a_calls
         WHERE status = 'working' AND deadline_at < ?`,
      )
      .all(nowIso) as Array<{ call_id: string }>
    if (workingRows.length > 0) {
      this.db
        .prepare(
          `UPDATE a2a_calls SET status = 'timeout', updated_at = ?
           WHERE status = 'working' AND deadline_at < ?`,
        )
        .run(nowIso, nowIso)
      for (const r of workingRows) this.emitPendingChange(r.call_id)
    }

    let staleCount = 0
    if (opts.stalePendingMs && opts.stalePendingMs > 0) {
      const cutoffIso = new Date(Date.parse(nowIso) - opts.stalePendingMs).toISOString()
      const pendingRows = this.db
        .prepare(
          `SELECT call_id FROM a2a_calls
           WHERE status = 'pending'
             AND created_at < ?
             AND parent_call_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM a2a_worklists w
               WHERE w.parent_call_id = a2a_calls.parent_call_id
                 AND w.status = 'active'
             )`,
        )
        .all(cutoffIso) as Array<{ call_id: string }>
      if (pendingRows.length > 0) {
        this.db
          .prepare(
            `UPDATE a2a_calls SET status = 'timeout', updated_at = ?
             WHERE status = 'pending'
               AND created_at < ?
               AND parent_call_id IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM a2a_worklists w
                 WHERE w.parent_call_id = a2a_calls.parent_call_id
                   AND w.status = 'active'
               )`,
          )
          .run(nowIso, cutoffIso)
        for (const r of pendingRows) this.emitPendingChange(r.call_id)
        staleCount = pendingRows.length
      }
    }

    return workingRows.length + staleCount
  }

  get(callId: string): CallRow | null {
    const row = this.db.prepare("SELECT * FROM a2a_calls WHERE call_id = ?").get(callId) as
      | RawCallRow
      | undefined
    return row ? toCallRow(row) : null
  }

  /**
   * F026 P5 T3 · /debug/a2a?status=… 全表过滤。
   * 跨 session 返回单一 status 的所有 calls（按 created_at 升序）。
   * spec line 380 + plan AC-P5-1：filter pending / working / done / failed / timeout / cancelled。
   */
  findByStatus(status: CallStatus): CallRow[] {
    const rows = this.db
      .prepare("SELECT * FROM a2a_calls WHERE status = ? ORDER BY created_at ASC, rowid ASC")
      .all(status) as RawCallRow[]
    return rows.map(toCallRow)
  }

  /**
   * F026 P5 T3 · /debug/a2a?session=&view=tree 该 session 全部 root call 树聚合。
   * 返回 Array<{ rootCallId, calls }>，每个 root 一棵 tree（按 root createdAt 升序）。
   * 空 session 返回 []，前端 F10 视图据此渲染「该房间无 A2A 派发」。
   */
  getSessionTrees(sessionGroupId: string): Array<{ rootCallId: string; calls: CallRow[] }> {
    const roots = this.db
      .prepare(
        `SELECT call_id FROM a2a_calls
         WHERE session_group_id = ? AND parent_call_id IS NULL
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionGroupId) as Array<{ call_id: string }>
    return roots.map((r) => ({
      rootCallId: r.call_id,
      calls: this.getTree(r.call_id),
    }))
  }
}

type RawCallRow = {
  call_id: string
  parent_call_id: string | null
  root_call_id: string
  issuer_id: string
  convener_id: string
  on_behalf_of: string | null
  reply_to: string
  deadline_at: string
  join_set_id: string | null
  status: CallStatus
  envelope_version: string
  session_group_id: string
  created_at: string
  updated_at: string
}

function toCallRow(r: RawCallRow): CallRow {
  return {
    callId: r.call_id,
    parentCallId: r.parent_call_id,
    rootCallId: r.root_call_id,
    issuerId: r.issuer_id,
    convenerId: r.convener_id,
    onBehalfOf: r.on_behalf_of,
    replyTo: r.reply_to,
    deadlineAt: r.deadline_at,
    joinSetId: r.join_set_id,
    status: r.status,
    envelopeVersion: r.envelope_version,
    sessionGroupId: r.session_group_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
