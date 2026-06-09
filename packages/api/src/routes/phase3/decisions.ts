/**
 * F027 Phase 3 P20 · POST /api/rooms/:id/decisions + GET /api/rooms/:id/decisions/coverage
 * Week 2 Day 6 — AC-P3-8 manual confirm decision API
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 2 Day 6
 *   + Phase 1 P12 DecisionLedger（packages/api/src/wiki/viewfinder/decision-ledger.ts）
 *   + contracts.ts §5 / §6
 *
 * 设计要点：
 *   1. POST /api/rooms/:id/decisions 三分支：
 *      - kind=commit/reject + 无 supersedesDecisionId → ledger.append（写新行）
 *      - kind=commit/reject + 有 supersedesDecisionId → ledger.revoke（写新行 + UPDATE 旧行）
 *      - kind=tombstone → ledger.markTombstone（UPDATE 旧行 tombstone=1，不写新行）
 *   2. evidence chain 映射 sourceMessageIds：
 *      - message ref → "msg:<id>" 前缀
 *      - decision ref → "decision:<id>" 前缀（与 P12 revoke() 内部约定一致）
 *   3. sourceQuote = content（manual confirm 无 LLM 抽取的原文，原话即 content 本身）；
 *      sha256 自动由 ledger.append 算
 *   4. fencingToken：服务侧生成（manual confirm 不要求前端拿 leader lease；防 LLM 误标的
 *      场景在 extractor 流程，manual 路径下 token 起审计追溯用）
 *   5. GET /api/rooms/:id/decisions/coverage：从 ledger SQL 直查三集合
 *      - 不调 viewfinder（避免拉 markdown 重 parse + 与 LLM extractor 解耦）
 *      - DecisionLedger 没有 listAll API，直读 raw SQL
 *
 * Phase 4 留挂位：
 *   - Coverage Check 候选层（Haiku 没判 message）需要 Phase 1 P12 viewfinder.md frontmatter
 *     写入 unresolvedMessageIds，Day 6 暂未接（GetCoverageResponse 只反映 decision row 层）
 *   - Inspector Coverage warning UI click → POST 这俩 endpoint 在 Week 3-4 前端实施
 */

import { randomUUID } from "node:crypto"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import { DecisionLedger } from "../../wiki/viewfinder/decision-ledger"
import {
  type DecisionKind,
  type DecisionRef,
  ErrorCode,
  type GetCoverageResponse,
  HTTP_STATUS_BY_ERROR,
  type PostDecisionBody,
  type PostDecisionResponse,
  toErrorResponse,
  validateGetCoverage,
  validatePostDecision,
} from "./contracts"
import { getSqliteClient } from "./sqlite-helper"

type DrizzleDb = BetterSQLite3Database<typeof schema>

const SUMMARY_LEN = 100
const COVERAGE_PASS = 0.95
const MIN_BROAD_FOR_PASS = 3

interface RawDecisionRow {
  decision_id: number
  decision_type: string
  content: string
  decided_by: string
  decided_at: string
  tombstone: number
  superseded_by: number | null
  status: string
}

export interface DecisionServiceDeps {
  db: DrizzleDb
  /** 注入 clock（测试用；默认 () => new Date()）。 */
  clock?: () => Date
  /** 注入 fencing token 生成器（测试用；默认 randomUUID）。 */
  newFencingToken?: () => string
}

export class DecisionService {
  private readonly ledger: DecisionLedger
  private readonly client: ReturnType<typeof getSqliteClient>
  private readonly clock: () => Date
  private readonly newFencingToken: () => string

  constructor(deps: DecisionServiceDeps) {
    this.client = getSqliteClient(deps.db)
    this.clock = deps.clock ?? (() => new Date())
    this.newFencingToken = deps.newFencingToken ?? (() => randomUUID())
    this.ledger = new DecisionLedger(this.client, () => this.clock().toISOString())
  }

  commitDecision(roomId: string, body: PostDecisionBody): PostDecisionResponse {
    const fencingToken = this.newFencingToken()
    const sourceMessageIds = body.evidence.map((e) =>
      e.kind === "message" ? `msg:${e.ref}` : `decision:${e.ref}`,
    )
    const supersedesId = body.supersedesDecisionId ? Number(body.supersedesDecisionId) : null

    if (body.kind === "tombstone") {
      // contracts 已保证 supersedesDecisionId 非空
      if (supersedesId === null) {
        throw new Error("tombstone branch: supersedesDecisionId required (contracts bug)")
      }
      // 取目标行的 fencing_token（markTombstone 要求 token 一致才 UPDATE）
      const target = this.client
        .prepare("SELECT fencing_token FROM room_decisions WHERE decision_id = ? AND room_id = ?")
        .get(supersedesId, roomId) as { fencing_token: string } | undefined
      if (!target) {
        throw new DecisionNotFoundError(supersedesId, roomId)
      }
      const marked = this.ledger.markTombstone(supersedesId, target.fencing_token)
      if (!marked) {
        throw new Error(`markTombstone failed: decision_id=${supersedesId} (race / token mismatch)`)
      }
      return {
        decisionId: String(supersedesId),
        ledgerCursor: this.queryLedgerCursor(roomId),
        appendedAt: this.clock().toISOString(),
        action: "tombstone",
      }
    }

    // F027 final-vision P1-1 P2 修：extraSourceMessageIds = body.evidence 里的 message refs
    // (revoke/supersede 内部会自动加 `decision:<oldId>` 在前；这里只挑 message 类型)
    const extraSourceMessageIds = body.evidence
      .filter((e) => e.kind === "message")
      .map((e) => `msg:${e.ref}`)

    if (body.kind === "supersede") {
      // F027 final-vision P1-1 P1 修：supersede 走 ledger.supersede (新 commit 行 + 旧行 superseded_by)
      // contracts 已保证 supersedesDecisionId 非空
      if (supersedesId === null) {
        throw new Error("supersede branch: supersedesDecisionId required (contracts bug)")
      }
      this.assertDecisionInRoom(supersedesId, roomId)
      const newId = this.ledger.supersede({
        oldDecisionId: supersedesId,
        reason: body.content,
        decidedBy: body.callerAlias,
        fencingToken,
        extraSourceMessageIds,
      })
      return {
        decisionId: String(newId),
        ledgerCursor: this.queryLedgerCursor(roomId),
        appendedAt: this.clock().toISOString(),
        action: "supersede",
      }
    }

    if (supersedesId !== null) {
      // commit/reject + supersedesDecisionId → revoke 旧行 + 写新行 (Day 6 backward compat)
      this.assertDecisionInRoom(supersedesId, roomId)
      const newId = this.ledger.revoke({
        oldDecisionId: supersedesId,
        reason: body.content,
        decidedBy: body.callerAlias,
        fencingToken,
        extraSourceMessageIds,
      })
      return {
        decisionId: String(newId),
        ledgerCursor: this.queryLedgerCursor(roomId),
        appendedAt: this.clock().toISOString(),
        action: "revoke",
      }
    }

    // append 新决策（kind=commit/reject 直接映射 decision_type）
    const newId = this.ledger.append({
      roomId,
      decidedBy: body.callerAlias,
      decisionType: body.kind, // "commit" | "reject" — types.ts DecisionType 已覆盖
      content: body.content,
      sourceMessageIds,
      sourceQuote: body.content,
      fencingToken,
    })
    return {
      decisionId: String(newId),
      ledgerCursor: this.queryLedgerCursor(roomId),
      appendedAt: this.clock().toISOString(),
      action: "append",
    }
  }

  getCoverage(roomId: string): GetCoverageResponse {
    const rows = this.client
      .prepare(
        `SELECT decision_id, decision_type, content, decided_by, decided_at,
                tombstone, superseded_by, status
           FROM room_decisions
          WHERE room_id = ?
          ORDER BY decided_at DESC`,
      )
      .all(roomId) as RawDecisionRow[]

    const broad: DecisionRef[] = rows.map(toDecisionRef)
    const resolved = broad.filter((d) => d.state !== "active")
    const unresolved = broad.filter((d) => d.state === "active")

    const coverage = broad.length === 0 ? null : resolved.length / broad.length
    let status: GetCoverageResponse["status"]
    if (broad.length === 0) {
      status = "fail"
    } else if (broad.length < MIN_BROAD_FOR_PASS) {
      status = "warn"
    } else if (coverage !== null && coverage >= COVERAGE_PASS) {
      status = "pass"
    } else {
      status = "warn"
    }

    return {
      broad,
      resolved,
      unresolved,
      coverage,
      status,
      generatedAt: this.clock().toISOString(),
    }
  }

  // ─── 内部 helpers ─────────────────────────────────────────────────

  private queryLedgerCursor(roomId: string): number {
    const row = this.client
      .prepare("SELECT MAX(decision_id) AS cursor FROM room_decisions WHERE room_id = ?")
      .get(roomId) as { cursor: number | null } | undefined
    return row?.cursor ?? 0
  }

  private assertDecisionInRoom(decisionId: number, roomId: string): void {
    const row = this.client
      .prepare("SELECT 1 AS exists_flag FROM room_decisions WHERE decision_id = ? AND room_id = ?")
      .get(decisionId, roomId) as { exists_flag: number } | undefined
    if (!row) {
      throw new DecisionNotFoundError(decisionId, roomId)
    }
  }
}

class DecisionNotFoundError extends Error {
  constructor(
    public readonly decisionId: number,
    public readonly roomId: string,
  ) {
    super(`decision_id=${decisionId} not found in room=${roomId}`)
    this.name = "DecisionNotFoundError"
  }
}

function toDecisionRef(r: RawDecisionRow): DecisionRef {
  const summary = r.content.length > SUMMARY_LEN ? `${r.content.slice(0, SUMMARY_LEN)}…` : r.content
  let state: DecisionRef["state"]
  if (r.tombstone === 1) {
    state = "tombstone"
  } else if (r.status === "completed") {
    state = "completed"
  } else if (r.status === "superseded" || r.superseded_by !== null) {
    state = "superseded"
  } else {
    state = "active"
  }
  return {
    decisionId: String(r.decision_id),
    summary,
    state,
    decisionType: r.decision_type,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  }
}

// ─── Route registration ────────────────────────────────────────────

export function registerDecisionsRoute(app: FastifyInstance, service: DecisionService): void {
  app.post("/api/rooms/:id/decisions", async (request, reply) => {
    const validation = validatePostDecision(request.params, request.body)
    if (!validation.ok) {
      reply.code(HTTP_STATUS_BY_ERROR[validation.error])
      return toErrorResponse(validation)
    }
    try {
      return service.commitDecision(validation.value.roomId, validation.value.body)
    } catch (err) {
      if (err instanceof DecisionNotFoundError) {
        reply.code(HTTP_STATUS_BY_ERROR[ErrorCode.DECISION_INVALID])
        return toErrorResponse({
          ok: false,
          error: ErrorCode.DECISION_INVALID,
          message: err.message,
          detail: { reason: "decision_not_found", decisionId: err.decisionId },
        })
      }
      request.log.error({ err }, "POST /api/rooms/:id/decisions threw")
      reply.code(HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR])
      return toErrorResponse({
        ok: false,
        error: ErrorCode.INTERNAL_ERROR,
        message: (err as Error).message,
      })
    }
  })

  app.get("/api/rooms/:id/decisions/coverage", async (request, reply) => {
    const validation = validateGetCoverage(request.params)
    if (!validation.ok) {
      reply.code(HTTP_STATUS_BY_ERROR[validation.error])
      return toErrorResponse(validation)
    }
    try {
      return service.getCoverage(validation.value.roomId)
    } catch (err) {
      request.log.error({ err }, "GET /api/rooms/:id/decisions/coverage threw")
      reply.code(HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR])
      return toErrorResponse({
        ok: false,
        error: ErrorCode.INTERNAL_ERROR,
        message: (err as Error).message,
      })
    }
  })
}

// Type re-exports for index barrel
export type { DecisionKind }
