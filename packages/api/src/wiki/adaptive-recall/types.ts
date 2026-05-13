/**
 * F027 P13 · Adaptive Recall Policy types
 * 真相源：docs/plans/V16.5-final.md chap 12（行 1367-1444）
 * 实施 plan：docs/plans/F027-P13-adaptive-recall-plan.md
 *
 * 5 级 fallback 状态机 + per-turn budget + 每级 audit。
 * Critique Agent 评估每级是否 satisfied / continue / escalate。
 */

import type { RecallHit } from "../memory-preflight/types"

// ─── Recall budget ──────────────────────────────────────────────────────

export interface RecallBudget {
  /** 默认最多走 Level 3（V16.5 chap 12 行 1416） */
  maxLevels: 1 | 2 | 3 | 4 | 5
  /** 总耗时 cap (ms)，默认 5000 */
  maxTotalMs: number
  /** Critique LLM 调用 cap，默认 2 */
  maxCritiqueCalls: number
  /** Level 2/3 是否并行查询，默认 true */
  queryParallel: boolean
  /** 是否复用 caller 传入的 task memory pack 作 L1，默认 true */
  reuseTaskMemoryPack: boolean
}

export const DEFAULT_RECALL_BUDGET: RecallBudget = {
  maxLevels: 3,
  maxTotalMs: 5000,
  maxCritiqueCalls: 2,
  queryParallel: true,
  reuseTaskMemoryPack: true,
}

// ─── Critique Agent 抽象 ────────────────────────────────────────────────

export type CritiqueVerdict =
  | { satisfied: true; reason: string }
  | { satisfied: false; nextLevel: 2 | 3 | 4 | 5; specificPath?: string; reason: string }
  | { satisfied: false; escalate: true; reason: string }

export interface CritiqueInput {
  /** 原始触发 trigger（如 history_keyword / a2a_handoff） */
  trigger: string
  /** 当前查询主题 */
  query: string
  /** 当前 level (1-4) */
  level: 1 | 2 | 3 | 4
  /** 当前 level 召回的 hits */
  hits: ReadonlyArray<RecallHit>
  /** 已经走过的 level（防 critique 反复推同一 level） */
  visitedLevels: ReadonlyArray<number>
}

export interface CritiqueAgent {
  evaluate(input: CritiqueInput): Promise<CritiqueVerdict>
}

// ─── 5 级 backend 抽象（P13.3+ 接真 backend） ──────────────────────────

export interface Level2Backend {
  /** Level 2: search_wiki — BM25 + cosine hybrid（复用 P11 HybridSearchProvider） */
  searchWiki(query: string, topK: number): Promise<RecallHit[]>
}

export interface Level3Backend {
  /** Level 3: query_messages — FTS5 全文搜（复用 P14.b MessagesFtsRepository） */
  queryMessages(query: string, opts: { roomId: string; topK: number }): Promise<RecallHit[]>
}

export interface Level4Backend {
  /** Level 4: read_wiki(具体 path) — 严格模式仅 critique 输出 exact path 时触发 */
  readWiki(path: string): Promise<RecallHit | null>
}

export interface Level5Sink {
  /** Level 5: escalate to user — 写 wiki_events action='recall_escalate' */
  escalate(info: EscalateInfo): Promise<void>
}

export interface EscalateInfo {
  roomId: string
  alias: string
  trigger: string
  query: string
  visitedLevels: ReadonlyArray<number>
  reason: string
  totalMs: number
  critiqueCalls: number
}

// ─── Executor 输入 / 输出 ──────────────────────────────────────────────

export interface ExecuteInput {
  roomId: string
  alias: string
  /** 触发原因（来自 detectRecallTrigger.trigger） */
  trigger: string
  /** 召回主题 query（agent draft 摘要 / capability digest 派生） */
  query: string
  /** L1 注入：caller 传入的 task memory pack hits（来自 P11 loadTaskMemoryPack） */
  taskMemoryPack?: ReadonlyArray<RecallHit>
  /** Optional budget override（测试 / 高优先级 turn 用） */
  budget?: Partial<RecallBudget>
}

export interface LevelAttempt {
  level: 1 | 2 | 3 | 4 | 5
  hitsCount: number
  satisfied: boolean
  ms: number
  reason: string
  /** Level 4 specific path / Level 5 escalate reason 等附加信息 */
  meta?: Record<string, string>
}

export interface ExecuteOutput {
  /** 最终命中级别（1-5） */
  recallPath: 1 | 2 | 3 | 4 | 5
  /** 是否 satisfied（false → escalate） */
  recallSatisfied: boolean
  /** 命中 hits（最后一个 satisfied level 的 hits；escalate 时是 [] 或最后一级 hits） */
  hits: ReadonlyArray<RecallHit>
  /** 总耗时 (ms) */
  totalMs: number
  /** Critique LLM 实际调用次数 */
  critiqueCalls: number
  /** 是否 budget 触顶（任一维度 cap） */
  budgetExceeded: boolean
  /** Escalate reason（recallSatisfied=false 时非空） */
  escalateReason?: string
  /** 每级 audit trail */
  attempts: ReadonlyArray<LevelAttempt>
}

// ─── Executor 依赖 ─────────────────────────────────────────────────────

export interface ExecutorDeps {
  critique: CritiqueAgent
  level2: Level2Backend
  level3: Level3Backend
  level4: Level4Backend
  level5: Level5Sink
  /** 可选 clock 注入（测试用） */
  now?: () => number
}
