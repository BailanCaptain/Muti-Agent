/**
 * F027 P12 · Decision Ledger
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1194-1235
 *
 * Append-only 协议：
 *   - 决策原文（content / source_quote / source_hash）写入后永久不改
 *   - metadata（tombstone / superseded_by）可 UPDATE（V16.5 chap 11 行 1222 设计）
 *
 * Revoke 机制（范-r2 Q-B-4 必做 — Phase 1 LLM 误判纠错通道）：
 *   - 不能改原决策内容
 *   - 写新 decision row（type=reject, content=reason）+ UPDATE 旧行 superseded_by = new_id
 *   - 老决策 SQL 查时通过 superseded_by IS NULL 自然过滤
 *
 * Tombstone 协议（chap 11 行 1198-1200）：
 *   - 关键决策（user 拍板 / spec 立项 / 否决某方案）显式标 tombstone=1
 *   - viewfinder §1 主题 / §6 不要再做 优先取 tombstone 决策（永久投影）
 *   - markTombstone 需带 fencingToken（防 LLM extractor 误标）
 */

import { createHash } from "node:crypto"
import type { SqliteAdapterLike } from "../room-compiler/sqlite-checkpoint-store"
import type {
  AppendDecisionInput,
  DecisionRow,
  DecisionStatus,
  DecisionType,
  RevokeDecisionInput,
} from "./types"
import { ViewfinderError } from "./types"

interface RawDecisionRow {
  decision_id: number
  room_id: string
  decided_at: string
  decided_by: string
  decision_type: string
  content: string
  source_message_ids: string
  source_quote: string
  source_hash: string
  tombstone: number
  superseded_by: number | null
  fencing_token: string
  extractor_confidence: number | null
  coverage_check_passed: number | null
  status: string
}

function mapRow(r: RawDecisionRow): DecisionRow {
  return {
    decisionId: r.decision_id,
    roomId: r.room_id,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionType: r.decision_type as DecisionType,
    content: r.content,
    sourceMessageIds: safeParseJsonArray(r.source_message_ids),
    sourceQuote: r.source_quote,
    sourceHash: r.source_hash,
    tombstone: r.tombstone === 1,
    supersededBy: r.superseded_by,
    fencingToken: r.fencing_token,
    extractorConfidence: r.extractor_confidence,
    coverageCheckPassed: r.coverage_check_passed === null ? null : r.coverage_check_passed === 1,
    status: (r.status as DecisionStatus) ?? "active",
  }
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

export class DecisionLedger {
  constructor(
    private readonly db: SqliteAdapterLike,
    private readonly nowFn: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Append 一条新决策。返回 decisionId（auto increment）。
   * sourceHash 自动算（防 source_quote 被外部改篡）。
   */
  append(input: AppendDecisionInput): number {
    const decidedAt = this.nowFn()
    const sourceHash = sha256(input.sourceQuote)
    const tombstone = input.tombstone ? 1 : 0
    // P4 C-auto-2: 新决策默认 status='active'（schema default 也是 active，显式写更清楚）
    const result = this.db
      .prepare(`
        INSERT INTO room_decisions (
          room_id, decided_at, decided_by, decision_type, content,
          source_message_ids, source_quote, source_hash,
          tombstone, superseded_by, fencing_token,
          extractor_confidence, coverage_check_passed, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'active')
      `)
      .run(
        input.roomId,
        decidedAt,
        input.decidedBy,
        input.decisionType,
        input.content,
        JSON.stringify(input.sourceMessageIds),
        input.sourceQuote,
        sourceHash,
        tombstone,
        input.fencingToken,
        input.extractorConfidence ?? null,
      )
    const id = Number(result.lastInsertRowid ?? 0)
    if (id <= 0) {
      throw new ViewfinderError(
        "ledger_append",
        `INSERT room_decisions returned no lastInsertRowid (room=${input.roomId})`,
      )
    }
    return id
  }

  /**
   * P4 C-auto-2: 把一批 decision 标 completed（status='active' → 'completed'）。
   *
   * 用途：extractor LLM 判定新 commit 决策（如"F026 已合"）完成了哪些旧 active commit
   * 决策（如"进 merger-gate"），sweep 旧的 → 让 viewfinder §3 不显示已完成承诺。
   *
   * 安全性：
   *   - 只改 status='active' 行（防重复标 / 防 superseded 行被误改）
   *   - 校验 fencingToken（防 race / 错 leader 误改）
   *   - 返回实际改成功的 id 列表（caller 可对比 input 校验 LLM 没 hallucinate 出不存在的 id）
   */
  markCompleted(decisionIds: ReadonlyArray<number>, fencingToken: string): number[] {
    if (decisionIds.length === 0) return []
    const placeholders = decisionIds.map(() => "?").join(",")
    // 先查实际能改的 id（status='active' AND fencing_token 一致）
    const eligible = this.db
      .prepare(`
        SELECT decision_id FROM room_decisions
         WHERE decision_id IN (${placeholders})
           AND status = 'active'
           AND fencing_token = ?
      `)
      .all(...decisionIds, fencingToken) as Array<{ decision_id: number }>
    if (eligible.length === 0) return []
    const eligibleIds = eligible.map((r) => r.decision_id)
    const updatePlaceholders = eligibleIds.map(() => "?").join(",")
    this.db
      .prepare(`
        UPDATE room_decisions SET status = 'completed'
         WHERE decision_id IN (${updatePlaceholders})
      `)
      .run(...eligibleIds)
    return eligibleIds
  }

  /**
   * 撤销旧决策。Append-only：旧行不动，写新行 + UPDATE 旧行 superseded_by。
   *
   * 新行作为 reject 类决策，content = reason，sourceQuote = reason（自洽 sha）。
   * 返回新决策 id。
   */
  revoke(input: RevokeDecisionInput): number {
    const old = this.getById(input.oldDecisionId)
    if (!old) {
      throw new ViewfinderError(
        "ledger_revoke",
        `revoke: old decision_id=${input.oldDecisionId} not found`,
      )
    }
    if (old.supersededBy !== null) {
      throw new ViewfinderError(
        "ledger_revoke",
        `revoke: old decision_id=${input.oldDecisionId} already superseded by ${old.supersededBy}`,
      )
    }

    // 1. 写新 reject 决策（解释撤销原因 + 引用旧 decision）
    const newId = this.append({
      roomId: old.roomId,
      decidedBy: input.decidedBy,
      decisionType: "reject",
      content: `撤销 D-${input.oldDecisionId}: ${input.reason}`,
      sourceMessageIds: [`decision:${input.oldDecisionId}`],
      sourceQuote: input.reason,
      fencingToken: input.fencingToken,
    })

    // 2. UPDATE 旧行 superseded_by = newId + status='superseded'（metadata 可改）
    //    P4 C-auto-2: status 与 superseded_by 同步更新 → 让 viewfinder §3 status='active' 过滤生效
    const result = this.db
      .prepare(`
        UPDATE room_decisions
           SET superseded_by = ?, status = 'superseded'
         WHERE decision_id = ? AND superseded_by IS NULL
      `)
      .run(newId, input.oldDecisionId)
    if (Number(result.changes) === 0) {
      throw new ViewfinderError(
        "ledger_revoke",
        `revoke: race? superseded_by UPDATE affected 0 rows for decision_id=${input.oldDecisionId}`,
      )
    }

    return newId
  }

  /**
   * 标记 tombstone。需带 fencingToken 校验（防 LLM extractor 误标关键决策）。
   * 仅匹配 fencing_token 一致的行（防跨 leader/race 误改）。
   */
  markTombstone(decisionId: number, fencingToken: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE room_decisions
           SET tombstone = 1
         WHERE decision_id = ? AND fencing_token = ?
      `)
      .run(decisionId, fencingToken)
    return Number(result.changes) > 0
  }

  /** 标记 coverage_check_passed（写入端 Coverage Check 跑完后回填）。 */
  markCoverageChecked(decisionId: number, passed: boolean): boolean {
    const result = this.db
      .prepare(`
        UPDATE room_decisions
           SET coverage_check_passed = ?
         WHERE decision_id = ?
      `)
      .run(passed ? 1 : 0, decisionId)
    return Number(result.changes) > 0
  }

  // ─── 查询 API（viewfinder renderer 用） ────────────────────────────

  getById(decisionId: number): DecisionRow | null {
    const row = this.db
      .prepare("SELECT * FROM room_decisions WHERE decision_id = ?")
      .get(decisionId) as RawDecisionRow | undefined
    return row ? mapRow(row) : null
  }

  /**
   * Active = status='active' (P4 C-auto-2)。
   * - 未被 revoke（status != 'superseded'）
   * - 未被 sweep（status != 'completed'）
   * 最新在前。
   */
  getActiveDecisions(roomId: string, limit?: number): DecisionRow[] {
    const sql = limit
      ? `SELECT * FROM room_decisions
         WHERE room_id = ? AND status = 'active'
         ORDER BY decided_at DESC LIMIT ?`
      : `SELECT * FROM room_decisions
         WHERE room_id = ? AND status = 'active'
         ORDER BY decided_at DESC`
    const rows = limit
      ? (this.db.prepare(sql).all(roomId, limit) as RawDecisionRow[])
      : (this.db.prepare(sql).all(roomId) as RawDecisionRow[])
    return rows.map(mapRow)
  }

  /**
   * Tombstone 决策（永久投影到 viewfinder §1 主题 / §6 不要再做）。
   * 包含被 supersede 或 completed 的 tombstone（关键决策原文不会因 status 变化消失）。
   */
  getTombstoneDecisions(roomId: string): DecisionRow[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM room_decisions
         WHERE room_id = ? AND tombstone = 1
         ORDER BY decided_at DESC
      `)
      .all(roomId) as RawDecisionRow[]
    return rows.map(mapRow)
  }

  /**
   * 按 type 取 active 决策（P4 C-auto-2: status='active'）。最新在前。
   * viewfinder §3 "下一步"用 getActiveByType('commit') 自动过滤掉已 sweep 的 commit。
   */
  getActiveByType(roomId: string, type: DecisionType, limit?: number): DecisionRow[] {
    const sql = limit
      ? `SELECT * FROM room_decisions
         WHERE room_id = ? AND decision_type = ? AND status = 'active'
         ORDER BY decided_at DESC LIMIT ?`
      : `SELECT * FROM room_decisions
         WHERE room_id = ? AND decision_type = ? AND status = 'active'
         ORDER BY decided_at DESC`
    const rows = limit
      ? (this.db.prepare(sql).all(roomId, type, limit) as RawDecisionRow[])
      : (this.db.prepare(sql).all(roomId, type) as RawDecisionRow[])
    return rows.map(mapRow)
  }
}
