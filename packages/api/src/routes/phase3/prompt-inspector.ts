/**
 * F027 Phase 3 P20 · GET /api/rooms/:id/prompt-inspector — Week 1 Day 4
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1 Day 4
 *   + contracts.ts §3 GetPromptInspectorResponse
 *
 * 数据源：`prompt_audit` 表（V15.1+V15.2 一次性入表的 26 字段）
 *   - 取该 room 最新一行（ORDER BY id DESC LIMIT 1）
 *   - 解析 parts_json → injectedParts
 *   - 解析 recall_queries / recall_results → recallQueries[]
 *   - 解析 recall_* 字段 → recallState
 *   - 解析 recall_trigger → wakeUpTrigger
 *
 * Day 4 是 **占位读**：
 *   - prompt_audit 真写入是 AC-P3-9 Week 2 Day 8 接通（orchestrator/RoomCompiler wiring）
 *   - 当前表可能空（room 还没产生过 assembler 调用）→ 返 empty arrays + defaults
 *   - parts_json 实际 schema 由 P11 memory_preflight 写盘时决定；本 service 用宽容解析
 *     兼容 { name, bytes?, tokens?, source? } 或 { name, byteLength?, tokenCount?, kind? }
 *
 * 不做（Day 4 范围）：
 *   - 不实现 wake-up 触发因 WS 协议（Week 2 Day 10）
 *   - 不实现 inspector force-recompile
 *   - 不接 Adaptive Recall executor 真触发（AC-P3-9 Week 2 Day 7-9）
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import {
  type AdaptiveRecallState,
  ErrorCode,
  type GetPromptInspectorResponse,
  HTTP_STATUS_BY_ERROR,
  type InjectedPart,
  type NotInjectedPart,
  type RecallGate,
  type RecallQueryItem,
  toErrorResponse,
  validateGetPromptInspector,
} from "./contracts"
import { getSqliteClient } from "./sqlite-helper"

type DrizzleDb = BetterSQLite3Database<typeof schema>

/**
 * prompt_audit 行的子集（只取 inspector endpoint 真正用到的列）。
 *
 * 范-r1 P1-1 收敛：之前 SELECT 17 列但只用 12 列；剪掉 `not_injected_json` /
 * `iron_laws_count` / `recall_rejected_reasons` / `top_score` / `recall_budget_exceeded`
 * 5 个未消费列。
 *
 * `top_score`（audit 行级单值，跨所有 query 的 max）**不参与** per-query topScore 计算；
 * per-query topScore 走 hits[].score（更准确，且 audit.top_score 在多 query 场景下
 * 等价于 max(hits[i].score for i in queries)，per-query 推算更细）。
 */
interface PromptAuditRow {
  scenario: string
  parts_json: string
  recall_queries: string | null
  recall_results: string | null
  recall_total_tokens: number | null
  recall_required: number
  recall_trigger: string | null
  recall_path: number | null
  recall_satisfied: number
  escalate_reason: string | null
  // F027 P4 hotfix · raw text / iron_laws_count 给 BottomButtonsBar "查看 raw text" + "复制全文"
  raw_text: string
  iron_laws_count: number
  // P4 hotfix · created_at 给 previousAudits 时间标识
  created_at: string
  // F027 v3 G1 · V16.5 chap 20 token cap + 未注入 parts JSON (drop reducer 输出)
  cap: number
  not_injected_json: string | null
  // F027 v3 G4 · 行 alias (前端 dropdown 当前选中状态显示用)
  alias: string
}

const DEFAULT_RECALL_BUDGET_MAX = 4000

export interface PromptInspectorServiceDeps {
  db: DrizzleDb
  /** Per-turn budget 上限（默认 4000 token；Phase 2 Adaptive Recall 配 — AC-P1-12 锁 budget）。 */
  recallBudgetMax?: number
}

export class PromptInspectorService {
  private readonly db: DrizzleDb
  private readonly recallBudgetMax: number

  constructor(deps: PromptInspectorServiceDeps) {
    this.db = deps.db
    this.recallBudgetMax = deps.recallBudgetMax ?? DEFAULT_RECALL_BUDGET_MAX
  }

  getInspector(
    roomId: string,
    _threadId: string | undefined,
    limit = 1,
    alias?: string,
  ): GetPromptInspectorResponse {
    // _threadId 当前不参与 prompt_audit 过滤（assembler 写入只标 roomId + alias）；
    // Phase 4 P22 接 thread 维度 inspector 时再扩。
    // P4 hotfix · limit ≥ 1 用于「对比上次注入」按钮，最新一条进 head fields，
    // 余下进 previousAudits 数组。clamp 在 contracts.validateGetPromptInspector 已做。
    //
    // F027 v3 G4 · alias 可选过滤（多 agent room 看 per-agent prompt）。
    // 之前 WHERE 只 room_id → 多 agent 触发时只显示"最后写入的 agent"；
    // 加 alias 后 caller (Inspector tab dropdown) 选 alias 取该 agent 的 audit row。
    const client = getSqliteClient(this.db)
    const sql = alias
      ? `SELECT scenario, parts_json,
                recall_queries, recall_results, recall_total_tokens,
                recall_required, recall_trigger, recall_path,
                recall_satisfied, escalate_reason,
                raw_text, iron_laws_count, created_at,
                cap, not_injected_json, alias
           FROM prompt_audit
          WHERE room_id = ? AND alias = ?
          ORDER BY id DESC
          LIMIT ?`
      : `SELECT scenario, parts_json,
                recall_queries, recall_results, recall_total_tokens,
                recall_required, recall_trigger, recall_path,
                recall_satisfied, escalate_reason,
                raw_text, iron_laws_count, created_at,
                cap, not_injected_json, alias
           FROM prompt_audit
          WHERE room_id = ?
          ORDER BY id DESC
          LIMIT ?`
    const rows = (
      alias
        ? client.prepare(sql).all(roomId, alias, limit)
        : client.prepare(sql).all(roomId, limit)
    ) as PromptAuditRow[]

    // F027 v3 G4 · 查 room 内所有 distinct alias (前端 dropdown 列出选项)
    const aliasRows = client
      .prepare(
        `SELECT DISTINCT alias FROM prompt_audit
          WHERE room_id = ?
          ORDER BY alias ASC`,
      )
      .all(roomId) as Array<{ alias: string }>
    const availableAliases = aliasRows.map((r) => r.alias)

    if (rows.length === 0) {
      // 空 audit → selectedAlias=null (即使 caller 传了 alias, alias filter 没匹配到任何 row，
      // 也算"没数据"，UI 应反映这点而非显示 caller 一厢情愿的 alias)
      return emptyInspectorResponse(this.recallBudgetMax, availableAliases, null)
    }

    const [row, ...prev] = rows

    return {
      injectedParts: parseInjectedParts(row.parts_json),
      recallQueries: parseRecallQueries(row.recall_queries, row.recall_results),
      recallState: parseRecallState(row, this.recallBudgetMax),
      wakeUpTrigger: parseWakeUpTrigger(row.recall_trigger, row.scenario),
      rawText: row.raw_text ?? null,
      ironLawsCount: row.iron_laws_count ?? 0,
      scenario: row.scenario ?? null,
      previousAudits: prev.map((r) => ({
        injectedParts: parseInjectedParts(r.parts_json),
        rawText: r.raw_text ?? "",
        ironLawsCount: r.iron_laws_count ?? 0,
        scenario: r.scenario ?? "",
        createdAt: r.created_at,
      })),
      // F027 v3 G1 · V16.5 chap 20 cap + drop reducer not_injected_json
      cap: row.cap ?? 0,
      notInjectedParts: parseNotInjectedParts(row.not_injected_json),
      // F027 v3 G4 · 当前 row 的 alias (即使 caller 没传 alias，也透出本行真实 alias)
      // + room 内 distinct alias 列表 (前端 dropdown 选项)
      selectedAlias: row.alias ?? null,
      availableAliases,
    }
  }
}

function emptyInspectorResponse(
  budgetMax: number,
  availableAliases: string[] = [],
  selectedAlias: string | null = null,
): GetPromptInspectorResponse {
  return {
    injectedParts: [],
    recallQueries: [],
    recallState: {
      recallRequired: false,
      recallPath: null,
      recallSatisfied: false,
      escalateReason: null,
      budgetConsumed: 0,
      budgetMax,
    },
    wakeUpTrigger: { kind: null, ref: null },
    rawText: null,
    ironLawsCount: 0,
    scenario: null,
    previousAudits: [],
    // F027 v3 G1 · 空 audit → cap=0 (前端 fallback 显 "—") + 无未注入 part
    cap: 0,
    notInjectedParts: [],
    // F027 v3 G4 · 空 audit → 无 alias info；前端 dropdown 显 "—"
    selectedAlias,
    availableAliases,
  }
}

/**
 * F027 v3 G1 · 解析 prompt_audit.not_injected_json (drop reducer 输出)。
 * 容错：null / 非数组 / 非对象项 / 缺字段 → 跳过，不抛。
 */
function parseNotInjectedParts(raw: string | null | undefined): NotInjectedPart[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: NotInjectedPart[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue
    const obj = item as Record<string, unknown>
    const name = takeString(obj.name)
    if (!name) continue
    const tokens = takeNumber(obj.tokens) ?? 0
    const reason = takeString(obj.reason) ?? "over_cap_drop_order"
    out.push({ name, tokens, reason })
  }
  return out
}

function parseInjectedParts(raw: string | null | undefined): InjectedPart[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: InjectedPart[] = []
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue
    const obj = item as Record<string, unknown>
    const name = takeString(obj.name) ?? takeString(obj.kind)
    if (!name) continue
    const bytes = takeNumber(obj.bytes) ?? takeNumber(obj.byteLength) ?? 0
    const tokens =
      takeNumber(obj.tokensEstimated) ??
      takeNumber(obj.tokens) ??
      takeNumber(obj.tokenCount) ??
      Math.ceil(bytes / 4)
    const source = takeString(obj.source) ?? takeString(obj.from) ?? "unknown"
    out.push({ name, bytes, tokensEstimated: tokens, source })
  }
  return out
}

function parseRecallQueries(
  queriesRaw: string | null,
  resultsRaw: string | null,
): RecallQueryItem[] {
  if (!queriesRaw) return []
  let queries: unknown
  try {
    queries = JSON.parse(queriesRaw)
  } catch {
    return []
  }
  if (!Array.isArray(queries)) return []

  let results: unknown[] = []
  if (resultsRaw) {
    try {
      const parsed = JSON.parse(resultsRaw)
      if (Array.isArray(parsed)) results = parsed
    } catch {
      // ignore — results 解析失败时 hits=0
    }
  }

  const out: RecallQueryItem[] = []
  for (let i = 0; i < queries.length; i += 1) {
    const q = queries[i]
    const queryText =
      typeof q === "string"
        ? q
        : typeof q === "object" && q !== null
          ? (takeString((q as Record<string, unknown>).query) ?? "")
          : ""
    if (!queryText) continue

    // results 按 index 对齐；每条 result 是 array of hits
    const hitsRaw = results[i]
    const hits = Array.isArray(hitsRaw) ? hitsRaw.length : 0
    const topScore =
      typeof q === "object" && q !== null
        ? (takeNumber((q as Record<string, unknown>).topScore) ?? 0)
        : extractTopScore(hitsRaw)
    const gate = classifyGate(topScore)
    out.push({ query: queryText, hits, gate, topScore })
  }
  return out
}

function parseRecallState(row: PromptAuditRow, budgetMax: number): AdaptiveRecallState {
  const recallPath = clampRecallPath(row.recall_path)
  return {
    recallRequired: row.recall_required === 1,
    recallPath,
    recallSatisfied: row.recall_satisfied === 1,
    escalateReason: row.escalate_reason ?? null,
    budgetConsumed: row.recall_total_tokens ?? 0,
    budgetMax,
  }
}

function parseWakeUpTrigger(
  trigger: string | null,
  scenario: string,
): GetPromptInspectorResponse["wakeUpTrigger"] {
  // recall_trigger 例：'a2a_call=R-201-call-001' / 'user_msg=msg-042' / 'scheduler_tick'
  // 不存在 → 从 scenario 兜底（scenario='wake-up.a2a' / 'wake-up.user' 等）
  if (typeof trigger === "string" && trigger.length > 0) {
    const eqIdx = trigger.indexOf("=")
    if (eqIdx > 0) {
      const kind = trigger.slice(0, eqIdx)
      const ref = trigger.slice(eqIdx + 1)
      if (kind === "a2a_call" || kind === "user_message") {
        return { kind, ref }
      }
      if (kind === "user_msg") {
        return { kind: "user_message", ref }
      }
    }
    if (trigger === "scheduler_tick") {
      return { kind: "scheduler_tick", ref: null }
    }
  }
  // scenario 兜底
  if (scenario.includes("a2a")) {
    return { kind: "a2a_call", ref: null }
  }
  if (scenario.includes("user")) {
    return { kind: "user_message", ref: null }
  }
  if (scenario.includes("scheduler") || scenario.includes("tick")) {
    return { kind: "scheduler_tick", ref: null }
  }
  return { kind: null, ref: null }
}

// ── helpers ─────────────────────────────────────────────────────────

function clampRecallPath(raw: number | null): AdaptiveRecallState["recallPath"] {
  if (raw === null || raw === undefined) return null
  if (raw === 1 || raw === 2 || raw === 3 || raw === 4 || raw === 5) return raw
  return null
}

function classifyGate(score: number): RecallGate {
  if (score >= 0.75) return "high"
  if (score >= 0.6) return "mid"
  return "low"
}

function extractTopScore(hitsRaw: unknown): number {
  if (!Array.isArray(hitsRaw) || hitsRaw.length === 0) return 0
  let top = 0
  for (const h of hitsRaw) {
    if (typeof h !== "object" || h === null) continue
    const obj = h as Record<string, unknown>
    // 范-r1 P2-4：与 V16.5 P14 hybrid retriever 输出对齐。优先级：
    //   score（通用）> hybridScore（hybrid retriever 总分）
    //   > hybrid_score（snake_case 兼容）> cosine（fallback）
    //   > cosineScore / bm25Score / bm25_score（各 score 子项 fallback）
    const score =
      takeNumber(obj.score) ??
      takeNumber(obj.hybridScore) ??
      takeNumber(obj.hybrid_score) ??
      takeNumber(obj.cosine) ??
      takeNumber(obj.cosineScore) ??
      takeNumber(obj.bm25Score) ??
      takeNumber(obj.bm25_score)
    if (score !== undefined && score > top) top = score
  }
  return top
}

function takeString(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined
  return raw
}

function takeNumber(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
  return raw
}

export function registerPromptInspectorRoute(
  app: FastifyInstance,
  service: PromptInspectorService,
): void {
  app.get("/api/rooms/:id/prompt-inspector", async (request, reply) => {
    const validation = validateGetPromptInspector(request.params, request.query)
    if (!validation.ok) {
      reply.code(HTTP_STATUS_BY_ERROR[validation.error])
      return toErrorResponse(validation)
    }
    try {
      const body = service.getInspector(
        validation.value.roomId,
        validation.value.threadId,
        validation.value.limit ?? 1,
        // F027 v3 G4 · alias 可选过滤
        validation.value.alias,
      )
      return body
    } catch (err) {
      request.log.error({ err, roomId: validation.value.roomId }, "prompt-inspector threw")
      reply.code(HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR])
      return toErrorResponse({
        ok: false,
        error: ErrorCode.INTERNAL_ERROR,
        message: (err as Error).message,
      })
    }
  })
}
