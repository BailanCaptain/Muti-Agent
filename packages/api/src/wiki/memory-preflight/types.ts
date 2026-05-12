/**
 * F027 P11 · memory_preflight 类型
 * 真相源：docs/plans/V16.5-final.md chap 10 行 1090-1182
 *
 * 设计 4 入口：
 *   - generateRecallQueries  ── 2-5 query 生成（rule-based）
 *   - WikiSearchProvider     ── searchWiki 抽象（P14/P15 接真 backend，P11 用 in-memory stub）
 *   - applyQualityGate       ── score floor + dedupe + 高/中置信分桶 + token 预算
 *   - renderTaskMemoryPack   ── 800-1200 tok cap markdown（Inspector 看）
 *   - detectRecallTrigger    ── Hard Gate（chap 12 行 1369-1395）
 *   - loadTaskMemoryPack     ── 主入口 composer
 *
 * Phase 1 边界（小孙拍）：
 *   - searchWiki backend 用 InMemoryStub（embedding 真生成 + cosine 内存搜）
 *   - P14 (Day 25) 加 wiki entity FTS5 + indexer 后回头补 P11.b 接真 backend
 *   - LLM judge（Hard Gate 第二层 edge case）留接口 + Phase 1 stub
 */

// ─── Recall query / hit ────────────────────────────────────────────────

export type RecallQuerySource =
  | "task_summary"
  | "capability_digest"
  | "recent_messages"
  | "unresolved_threads"

export interface RecallQuery {
  /** 查询字符串（送 search backend） */
  query: string
  /** 来源（debug + Inspector 透明显示） */
  source: RecallQuerySource
  /** score 下限（< floor 直接丢；默认 0.6） */
  expectedScoreFloor: number
  /** topK 上限（默认 2，最大 3，V16.5 chap 10 行 1133） */
  topK: number
}

export interface RecallHit {
  /** 命中 wiki 实体路径（wiki/concepts/F011-xxx.md） */
  path: string
  /** cosine 相似度（已含时间衰减权重，若 backend 算了的话） */
  score: number
  /** 摘录（注入 prompt 用 + Inspector 看；上限 ~200 char） */
  excerpt: string
  /** sha256 source hash（防漂移核验，可选） */
  sourceHash?: string
}

export interface RecallResult {
  query: RecallQuery
  hits: RecallHit[]
}

// ─── Quality gate ──────────────────────────────────────────────────────

export interface QualityGateBuckets {
  /** ≥ 0.75 高置信 → 注入 prompt（[Recall Pack — Reference Only]） */
  injected: RecallHit[]
  /** 0.6 ≤ score < 0.75 中置信 → 仅 Inspector 看（chap 10 行 1148） */
  inspectorOnly: RecallHit[]
  /** 被 reject 的 hit + 原因（schema prompt_audit.recall_rejected_reasons） */
  rejected: Array<{ hit: RecallHit; reason: RejectReason }>
}

/**
 * 范-r1 P2-1 修：token_budget_exceeded 不再做 reject 原因——超 cap 的高置信 hit
 * 走单一状态降级到 inspectorOnly + budgetExceeded flag。rejected 只承担"真丢弃"
 * 语义（floor 砍 + 同源 dedup 截）。
 */
export type RejectReason = "below_floor" | "duplicate_source"

export interface QualityGateOptions {
  /** < scoreFloor 直接 reject (默认 0.6 — chap 10 行 1146) */
  scoreFloor: number
  /** ≥ injectFloor 进 prompt；scoreFloor ≤ score < injectFloor 进 inspector（默认 0.75） */
  injectFloor: number
  /** 高置信合计 token 上限（默认 1200，chap 10 行 1150 800-1200 cap） */
  totalTokenCap: number
  /** 估算 token：默认 ceil(text.length / 4) — Phase 1 简化（不依赖 tokenizer） */
  estimateTokens: (text: string) => number
}

// ─── Hard Gate（chap 12 行 1369-1395） ─────────────────────────────────

export type RecallScenario = "wake_up" | "a2a_handoff" | "session_bootstrap" | "turn"

export interface TriggerContext {
  scenario: RecallScenario
  /** agent 即将发出的 draft（如有，turn 用） */
  draft?: string
  /** draft 已 cite 的 message_id（已带证据 → not required） */
  citedMessageIds?: string[]
  /** draft 已 cite 的 decision_id（已带证据 → not required） */
  citedDecisionIds?: string[]
}

export interface TriggerResult {
  required: boolean
  /** 命中的规则名（写 prompt_audit.recall_trigger） */
  trigger: string
  /** deterministic | llm_judge | none */
  source: "deterministic" | "llm_judge" | "none"
}

/** LLM judge backend 抽象 — Phase 1 留接口，stub 默认 required=true（保守） */
export interface RecallJudgeProvider {
  judge(input: {
    draft: string
    context: TriggerContext
  }): Promise<{ required: boolean; reason: string }>
}

// ─── search backend 抽象 ───────────────────────────────────────────────

export interface SearchOptions {
  topK: number
  /** 'all' | 'concepts' | 'memories' | 'agent-sessions' — Phase 1 backend 自由实现 */
  scope?: string
}

export interface WikiSearchProvider {
  search(query: string, opts: SearchOptions): Promise<RecallHit[]>
}

// ─── 主入口输入/输出 ───────────────────────────────────────────────────

export interface TaskContext {
  roomId: string
  alias: string
  scenario: RecallScenario
  /** task summary（来源 a2a envelope.task_summary / wake-up trigger desc） */
  taskSummary: string
  /** capability digest 关键词（P9 capability registry tags 派生） */
  capabilityDigestKeywords?: string[]
  /** 最近 N 条 messages 抽出的关键概念（P14 后由 query_messages 生成；Phase 1 caller 传） */
  recentMessageConcepts?: string[]
  /** ledger.openThreads（P8 agent-sessions current.md 派生） */
  unresolvedThreads?: string[]
}

export interface MemoryPreflightOutput {
  queries: RecallQuery[]
  results: RecallResult[]
  buckets: QualityGateBuckets
  /** 高置信合计估算 token（写 prompt_audit.recall_total_tokens） */
  totalTokens: number
  /** 是否 cap 触发（写 prompt_audit.recall_budget_exceeded 兼容字段） */
  budgetExceeded: boolean
  /** 给 assemblePrompt input.memoryPreflight 的 shape */
  prompt: { hits: Array<{ score: number; summary: string; path?: string }> }
  /** task_memory_pack 完整 markdown（chap 10 行 1156-1173 格式；Inspector 看） */
  packMarkdown: string
}
