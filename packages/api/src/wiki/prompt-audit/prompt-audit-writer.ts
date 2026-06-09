/**
 * F027 Phase 3 P20 · PromptAuditWriter — Week 2 Day 8 b (AC-P3-9 b)
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 2 Day 8 b
 *   + db/schema.ts:362-400 promptAudit (26 fields, V15.1+V15.2)
 *   + routes/phase3/prompt-inspector.ts (Day 4 读取 10 fields 已对接)
 *
 * 职责：把每次 prompt 拼装（A2A handoff / wake_up）的结果落 prompt_audit 一行：
 *   - 基础字段（alias / room_id / scenario / total_tokens / parts_json / raw_text 等）
 *   - V15.1 memory_preflight 5 字段（recall_queries / results / total_tokens / rejected_reasons / top_score）
 *   - V15.2 adaptive_recall 9 字段（recall_required / trigger / path / satisfied / escalate_reason /
 *     total_ms / critique_calls / budget_exceeded / + top_score 与 V15.1 共用一字段）
 *
 * Day 8 b 重点（plan 字面 "prompt_audit 9 字段真写入"）：
 *   - 9 recall fields 真落（caller from AdaptiveRecallCoordinator output 派生 patch）
 *   - 基础字段 best-effort（totalTokens 用 content.length 估算；cap=0；partsJson='[]' 占位；
 *     精细化 prompt 分块度量留 Phase 4 / Phase 5）
 *
 * 不做（Day 8 b 范围外）：
 *   - 不接 P11 loadTaskMemoryPack 真 wire（caller 当前不调；P11 5 字段留空 null，
 *     Phase 4 wire 后从 deriveAuditPatch 合并）
 *   - 不接 RoomCompiler 写入（compile 后台 job，无 prompt 拼装语义）
 *   - 不做 retention / purge（runtime 一直累积；Phase 4 加 nightly purge job）
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import type { ExecuteOutput } from "../adaptive-recall/types"
import type { RecallHit } from "../memory-preflight/types"
import type { SqliteAdapterLike } from "../room-compiler/sqlite-checkpoint-store"

type DrizzleDb = BetterSQLite3Database<typeof schema>

/** 26 字段 INSERT 输入。基础字段必填；recall / V15.1 字段可选（null = 未跑）。 */
export interface PromptAuditInput {
  // ── base fields（schema notNull） ─────────────────────────────────
  createdAt: string // ISO timestamp
  alias: string
  scenario: "session_bootstrap" | "wake_up" | "a2a_handoff" | "direct_turn" | string
  totalTokens: number
  cap: number
  partsJson: string
  ironLawsCount: number
  rawText: string

  // ── 可选 metadata ─────────────────────────────────────────────────
  roomId?: string | null
  notInjectedJson?: string | null
  sourceEventIds?: string | null // JSON array of msg ids
  agentSessionRef?: string | null

  // ── V15.1 memory_preflight（caller 可选传，Day 8 b 默认 null） ────
  recallQueries?: string | null // JSON
  recallResults?: string | null // JSON
  recallTotalTokens?: number | null
  recallRejectedReasons?: string | null // JSON

  // ── V15.2 adaptive_recall 9 fields（AC-P3-9 b 核心） ─────────────
  recallRequired?: boolean
  recallTrigger?: string | null
  recallPath?: 1 | 2 | 3 | 4 | 5 | null
  topScore?: number | null
  recallSatisfied?: boolean
  escalateReason?: string | null
  recallTotalMs?: number | null
  recallCritiqueCalls?: number | null
  recallBudgetExceeded?: boolean
}

export interface PromptAuditWriteResult {
  id: number
}

export interface PromptAuditWriterDeps {
  db: DrizzleDb
}

export class PromptAuditWriter {
  private readonly client: SqliteAdapterLike

  constructor(deps: PromptAuditWriterDeps) {
    this.client = (
      deps.db as unknown as {
        $client: SqliteAdapterLike
      }
    ).$client
  }

  write(input: PromptAuditInput): PromptAuditWriteResult {
    const result = this.client
      .prepare(`
        INSERT INTO prompt_audit (
          created_at, alias, room_id, scenario,
          total_tokens, cap, parts_json, not_injected_json,
          iron_laws_count, raw_text, source_event_ids,
          recall_queries, recall_results, recall_total_tokens, recall_rejected_reasons,
          recall_required, recall_trigger, recall_path, top_score,
          recall_satisfied, escalate_reason,
          recall_total_ms, recall_critique_calls, recall_budget_exceeded,
          agent_session_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.createdAt,
        input.alias,
        input.roomId ?? null,
        input.scenario,
        input.totalTokens,
        input.cap,
        input.partsJson,
        input.notInjectedJson ?? null,
        input.ironLawsCount,
        input.rawText,
        input.sourceEventIds ?? null,
        // V15.1
        input.recallQueries ?? null,
        input.recallResults ?? null,
        input.recallTotalTokens ?? null,
        input.recallRejectedReasons ?? null,
        // V15.2 Adaptive Recall
        input.recallRequired ? 1 : 0,
        input.recallTrigger ?? null,
        input.recallPath ?? null,
        input.topScore ?? null,
        input.recallSatisfied ? 1 : 0,
        input.escalateReason ?? null,
        input.recallTotalMs ?? null,
        input.recallCritiqueCalls ?? null,
        input.recallBudgetExceeded === undefined ? null : input.recallBudgetExceeded ? 1 : 0,
        input.agentSessionRef ?? null,
      )
    return { id: Number(result.lastInsertRowid ?? 0) }
  }
}

// ─── 辅助 builders ───────────────────────────────────────────────────

/**
 * 从 AdaptiveRecallCoordinator 输出派生 9 recall fields patch（不含 base / V15.1 字段）。
 *
 * - executor 真跑过（output 非空）→ 9 fields 全填
 * - executor 未跑（disabled / scenario_skip / deps_missing / executor_error）→ 全填 null/false/0
 *   (recall_required 取 caller 传入；其他 default)
 */
export function buildRecallAuditPatch(args: {
  output?: ExecuteOutput
  /** caller 派生：本次 turn 是否需要触发 recall（Hard Gate）—— Day 8 b 默认 = output 非空。 */
  recallRequired?: boolean
  /** caller 派生：trigger 字符串（Coordinator input.trigger 透传）。 */
  trigger?: string | null
}): {
  recallRequired: boolean
  recallTrigger: string | null
  recallPath: 1 | 2 | 3 | 4 | 5 | null
  topScore: number | null
  recallSatisfied: boolean
  escalateReason: string | null
  recallTotalMs: number | null
  recallCritiqueCalls: number | null
  recallBudgetExceeded: boolean
} {
  const out = args.output
  if (!out) {
    return {
      recallRequired: args.recallRequired ?? false,
      recallTrigger: args.trigger ?? null,
      recallPath: null,
      topScore: null,
      recallSatisfied: false,
      escalateReason: null,
      recallTotalMs: null,
      recallCritiqueCalls: null,
      recallBudgetExceeded: false,
    }
  }
  return {
    recallRequired: args.recallRequired ?? true,
    recallTrigger: args.trigger ?? null,
    recallPath: out.recallPath,
    topScore: maxScore(out.hits),
    recallSatisfied: out.recallSatisfied,
    escalateReason: out.escalateReason ?? null,
    recallTotalMs: out.totalMs,
    recallCritiqueCalls: out.critiqueCalls,
    recallBudgetExceeded: out.budgetExceeded,
  }
}

function maxScore(hits: ReadonlyArray<RecallHit>): number | null {
  if (hits.length === 0) return null
  let m = hits[0].score
  for (let i = 1; i < hits.length; i += 1) {
    if (hits[i].score > m) m = hits[i].score
  }
  return m
}

/**
 * F027 #286 FU-3 · 冷启（session_bootstrap）loadTaskMemoryPack 结果 → 9 recall fields patch。
 *
 * 背景（B1-b-2 receive P3-6）：冷启支不走 Coordinator（spec V16.5 line 95 轻量 Pack），
 * directRecall 恒 null → audit 行 recall 结构化字段全空，Prompt Inspector 只能从 partsJson
 * 看到 [Recall Pack] 内容、无法程序化追溯「冷启召回触发没/命中没」。
 *
 * 字段语义：
 *   - attempted = search backend 已注入且冷启 gate（nativeSessionId===null）触发
 *     → recallRequired=true + trigger="session_bootstrap"
 *   - hits = resolveColdStartRecall 注入 prompt 的高置信 hits（null = 无命中/fail-soft）
 *   - recallPath 恒 null：轻量 Pack 不是 coordinator 5-level executor，不冒充 path
 *   - 未 attempted → 与 buildRecallAuditPatch({}) 全默认一致（不破坏现状语义）
 */
/** deriveAuditPatch（memory-preflight.ts）产物形状 —— 冷启完整 preflight 审计数据。 */
export interface ColdStartPreflightAudit {
  recallQueries: string
  recallResults: string
  recallTotalTokens: number
  recallRejectedReasons: string
  topScore: number | null
  recallBudgetExceeded: number
}

export function buildColdStartRecallAuditPatch(args: {
  attempted: boolean
  hits: ReadonlyArray<{ score: number }> | null
  /**
   * receive 德彪 r1 P2-2：完整 preflight audit（loadTaskMemoryPack 输出过 deriveAuditPatch）。
   * 不传（fail-soft crash / 旧 caller）退回 hits 派生。传入时：
   *   - topScore 用 deriveAuditPatch 语义（injected[0] ?? inspectorOnly[0]）——
   *     0.6-0.75 inspector-only 命中不丢；
   *   - recallBudgetExceeded 用真值（不硬编码 false）；
   *   - V15.1 4 字段（queries/results/totalTokens/rejectedReasons）一并透传落 audit 行。
   */
  audit?: ColdStartPreflightAudit | null
}): ReturnType<typeof buildRecallAuditPatch> &
  // topScore 已在 base（number|null 同型）；recallBudgetExceeded 排除 —— audit 侧是 0/1
  // number（deriveAuditPatch SQLite 习惯），patch 侧统一 boolean（writer 落库再转）。
  Partial<Omit<ColdStartPreflightAudit, "topScore" | "recallBudgetExceeded">> {
  if (!args.attempted) {
    return buildRecallAuditPatch({ output: undefined })
  }
  const hits = args.hits ?? []
  const base = {
    recallRequired: true,
    recallTrigger: "session_bootstrap",
    recallPath: null,
    topScore: hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : null,
    recallSatisfied: hits.length > 0,
    escalateReason: null,
    recallTotalMs: null,
    recallCritiqueCalls: null,
    recallBudgetExceeded: false,
  } satisfies ReturnType<typeof buildRecallAuditPatch>
  if (!args.audit) return base
  return {
    ...base,
    topScore: args.audit.topScore,
    recallBudgetExceeded: args.audit.recallBudgetExceeded === 1,
    recallQueries: args.audit.recallQueries,
    recallResults: args.audit.recallResults,
    recallTotalTokens: args.audit.recallTotalTokens,
    recallRejectedReasons: args.audit.recallRejectedReasons,
  }
}

/**
 * noop writer — 测试 / 老路径（未 wire）不写 audit 时用。
 * 行为：write() 返回 id=0，不真 INSERT；caller 透明。
 */
export class NoopPromptAuditWriter {
  write(input: PromptAuditInput): PromptAuditWriteResult {
    void input
    return { id: 0 }
  }
}

/** 等价接口（caller 注 PromptAuditWriter | NoopPromptAuditWriter 都行）。 */
export type PromptAuditWriterLike = Pick<PromptAuditWriter, "write">
