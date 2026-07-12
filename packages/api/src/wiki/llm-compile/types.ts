/**
 * F027 P4.6 · LLM 编译 3 阶段 · 共享类型
 * 真相源：docs/plans/V16.5-final.md chap 26 行 2684-2976
 * AC：AC-P1-3 —— LLM 编译 3 阶段端到端 PASS
 *   Phase 1 (Pre-compile)：embedding similarity + top-5 相似 entity + 轻量目录
 *   Phase 2 (LLM compile)：schema-only JSON 输出（compile-LLM = Opus 4.7）
 *   Phase 3 (Post-compile)：cross_refs 死链检测 + dedup 处理 + frontmatter fill 三段
 */

/** Phase 1 输入：raw drop 的 metadata（来自 sanitize-raw-drop 后的 ingestion event） */
export interface RawMetadata {
  /** wiki_events 写入时的 message id（追踪源头消息） */
  ingestMessageId: string
  /** 用户解释 ingest 这条 raw 的理由（可选，写 frontmatter.ingest_metadata.user_reason） */
  userReason?: string
  /** series_id（白名单 / multi-drop 续传用，与 P4.5 同字段） */
  seriesId?: string | null
  /** 是否来自 user-drop（决定 frontmatter.tainted_source） */
  fromUserDrop: boolean
  /** ingest 日期（YYYY-MM-DD，用于 draftPath 生成） */
  date: string
}

/** Phase 1 输入：agent 端预填的最低 3 字段 */
export interface AgentDraftFrontmatter {
  /** 标题（agent 拍的最初值；Phase 2 LLM 可改） */
  title: string
  /** 类型候选（Phase 2 LLM 最终拍 type） */
  type_candidate?: "concept" | "rule" | "method" | "lesson" | "external-ref"
  /** sources 列表（agent 写的 metadata；Phase 3 直接保留） */
  sources: Array<{
    type: string
    path?: string
    contributed_by: string
    added_at?: string
  }>
}

// ─── Phase 1: Pre-compile ──────────────────────────────────────────────

/** top-k 相似 entity（embedding 命中） */
export interface SimilarEntity {
  /** wiki entity name（不带 [[]]，如 "F018-context-resume-rebuild"） */
  path: string
  /** entity 标题 */
  title: string
  /** entity 1 句 summary（让 LLM 知道是关于啥） */
  summary: string
  /** cosine similarity score（保留 3 位小数） */
  score: number
  /**
   * F042 AC4 · 候选自身的 sources[0].path（从 wiki_entity_index body frontmatter 提取）。
   * 与本次收录来源相同 = 同一文档旧版本——prompt 据此给 LLM 确定性 dedup 信号。
   */
  sourcePath?: string
}

/** 轻量目录条目（concepts / rules 名 + 1 句 summary） */
export interface IndexLiteEntry {
  name: string
  summary: string
}

/** Phase 1 输出 */
export interface PreCompileContext {
  /** top-5 相似 entity（按 score 降序，已应用 score_floor=0.4 过滤） */
  similarEntities: SimilarEntity[]
  /** 轻量目录（concepts / rules 各最多 N 条，title + summary） */
  indexLite: {
    concepts: IndexLiteEntry[]
    rules: IndexLiteEntry[]
    methods?: IndexLiteEntry[]
  }
  /** 给 LLM 的参考上下文 token 预算（cap 1500） */
  totalContextTokens: number
}

// ─── Phase 2: LLM Compile ──────────────────────────────────────────────

/** cross_refs 5 种 relation（V16.5 chap 26 行 2956-2962） */
export type CrossRefRelation =
  | "extends"
  | "supersedes"
  | "references"
  | "contradicts"
  | "implements"

export interface CrossRef {
  /** 目标 entity 名（不带 [[]]） */
  target: string
  relation: CrossRefRelation
  /** LLM 给的 1 句 rationale（dev / lint 看） */
  rationale: string
}

/** dedup_decision 3 种 verdict（V16.5 chap 26 行 2965-2969 阈值） */
export type DedupVerdict = "new_entity" | "merge_into" | "supersedes"

export interface DedupDecision {
  verdict: DedupVerdict
  /** merge_into / supersedes 时填；new_entity 为 null */
  target_entity: string | null
  rationale: string
}

/** canonical_owner_suggestion 4 个固定值 */
export type CanonicalOwnerSuggestion =
  | "wiki/concepts/"
  | "wiki/rules/"
  | "wiki/methods/"
  | "wiki/people/"

export interface DraftQuality {
  completeness: number // 0-1
  clarity: number // 0-1
  has_actionable_facts: boolean
  structural_pass: boolean
}

/**
 * Phase 2 LLM 输出（schema-only JSON）。
 * compile-LLM 必须输出此 schema 严格 JSON；其它任何字段视为 invalid。
 * 真相源：V16.5 chap 26 行 2782-2814。
 */
export interface LLMCompileOutput {
  title: string
  type: "concept" | "rule" | "method" | "lesson" | "external-ref"
  summary: string
  facts: Array<{ text: string; source_span?: string }>
  /** sanitize 隔离段（让 LLM 知道这些是 quoted_spans，不可执行） */
  quoted_spans: string[]
  sources: Array<{
    type: string
    path?: string
    contributed_by: string
  }>
  cross_refs: CrossRef[]
  dedup_decision: DedupDecision
  canonical_owner_suggestion: CanonicalOwnerSuggestion
  draft_quality: DraftQuality
}

// ─── Phase 3: Post-compile ─────────────────────────────────────────────

/** 死链 cross_ref（target entity 不存在） */
export interface DeadCrossRef {
  ref: CrossRef
  reason: string
}

/**
 * 完整 frontmatter（V16.5 chap 26 行 2920-2953）。
 * 19 字段（agent 3 + LLM 13 + post derive 3，按 AC-P1-3 行 122）。
 */
export interface CompiledFrontmatter {
  // —— A. agent 写（3 字段） ——
  title: string
  /** Phase 3 derive：取 LLM type 而非 agent type_candidate（agent 只是候选） */
  type: LLMCompileOutput["type"]
  sources: AgentDraftFrontmatter["sources"]

  // —— B. compile-LLM 输出（V16.5 chap 26 行 2858-2863）——
  summary: string
  facts: LLMCompileOutput["facts"]
  cross_refs: CrossRef[] // 死链已过滤
  dedup_decision: DedupDecision
  draft_quality: DraftQuality
  canonical_owner_suggestion: CanonicalOwnerSuggestion

  // —— C. post 阶段 derive（V16.5 chap 26 行 2865-2873）——
  canonical_owner_path: string // = draftPath
  proposed_promote_to: string
  tainted_source: boolean
  ingest_metadata: {
    ingest_event_id: string
    user_reason?: string
    series_id?: string | null
  }

  // —— D. dedup 边角字段（仅 merge_into / supersedes case） ——
  merge_target?: string
  supersedes?: string[]

  // —— E. requires_user_review（仅 canonical_owner_suggestion = wiki/rules/ case） ——
  requires_user_review?: boolean
  suggested_promote_to?: string
}

/** Phase 3 整合输出（DraftResult） */
export interface DraftResult {
  /** wiki/concepts/draft/<date>-<slug>.md */
  draftPath: string
  /** wiki_events 行 id */
  eventId: string
  /** 死链列表（不阻塞编译，写 wiki/warnings/cross-ref-dead-<date>.md） */
  deadRefs: DeadCrossRef[]
  /** 完整 frontmatter（19 字段） */
  frontmatter: CompiledFrontmatter
  /** dedup verdict（caller 路由用） */
  dedupDecision: DedupDecision
  /**
   * F042 AC4 · dedup target 存在性校验未过（LLM 编造）→ 已降级 new_entity 的留痕。
   * 镜像 deadRefs（不阻塞编译，诚实透出）；undefined = 校验通过或本就 new_entity。
   */
  deadDedupTarget?: { target: string; reason: string }
}

// ─── 共用：LLM Client interface ─────────────────────────────────────────

/**
 * compile-LLM 接口（依赖注入，方便测试 + 切换 model）。
 * Phase 1 此 interface 定义结构，runtime 真实接 Opus 4.7 见 P5 / P6 整合阶段。
 * 测试默认用 mock 实现，按 LLMCompileOutput shape 返回。
 */
export interface CompileLLMClient {
  compile(input: {
    systemPrompt: string
    userMessage: string
    /** 可选：调用上下文（log / trace 用） */
    context?: { ingestMessageId: string }
  }): Promise<LLMCompileOutput>
}

/**
 * Index Lite Loader 接口（依赖注入；caller 决定从哪儿读 concepts.md / rules.md）。
 * P2 WikiCompiler 派生 index/sources/log，本接口对接 index/concepts.md + rules.md。
 */
export interface IndexLiteLoader {
  load(scopes: Array<"concepts" | "rules" | "methods">): Promise<{
    concepts: IndexLiteEntry[]
    rules: IndexLiteEntry[]
    methods?: IndexLiteEntry[]
  }>
}

/**
 * Entity Existence Checker 接口（Phase 3 死链检测用）。
 * runtime 实现 = grep wiki/{concepts,rules,methods,people}/<name>.md 是否存在。
 */
export interface EntityExistenceChecker {
  exists(entityName: string): Promise<boolean>
}

/**
 * wiki_events 写入接口（Phase 3 ingest 落 wiki_events 用）。
 * runtime 实现 = WikiEventsRepository.append。
 */
export interface WikiEventsWriter {
  append(input: {
    action: "ingest"
    path: string
    contentHash: string
    sourceMessageIds: string[]
    reason?: string
  }): Promise<{ eventId: string }>
}

// ─── 错误类 ───────────────────────────────────────────────────────────

export class LLMCompileSchemaError extends Error {
  readonly invalidField: string
  constructor(invalidField: string, msg: string) {
    super(`LLM compile output schema invalid (field=${invalidField}): ${msg}`)
    this.name = "LLMCompileSchemaError"
    this.invalidField = invalidField
  }
}

export class CompilePipelineError extends Error {
  readonly stage: "pre" | "compile" | "post"
  constructor(stage: "pre" | "compile" | "post", msg: string, cause?: unknown) {
    super(`P4.6 compile pipeline failed at ${stage}: ${msg}`)
    this.name = "CompilePipelineError"
    this.stage = stage
    if (cause !== undefined) this.cause = cause
  }
}
