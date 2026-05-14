/**
 * F027 P12 · viewfinder anti-drift 类型
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1186-1364
 *
 * 设计要点（小孙 2026-05-13 拍 + 范-r2 GO）：
 *   - viewfinder 6 段 = rule-based 模板填空（不调 LLM 编 — 高频确定性活）
 *   - decision extractor = 关键词宽召 + Haiku yes/no 短判（低频语义活，复用 HaikuRunner）
 *   - revoke 机制 = append-only ledger 不能改，新决策 superseded_by 旧决策
 *   - §4 SQL 防御性兜底：deadline_at > now() - 24h（防 B024 F026 sweep 漏扫）
 *   - Coverage Check 三集合（范-r2 Q2）：broad / resolved / unresolved，
 *     分母太小标 coverage=unknown，避免"关键词命中即写入"自圆其说
 */

// ─── Decision ledger ──────────────────────────────────────────────────

export type DecisionType = "spec" | "pivot" | "commit" | "reject"

/**
 * P4 C-auto-2 (小孙 2026-05-13 拍)：决策生命周期 status
 *   - active: 还在执行中 / 还没被覆盖（viewfinder §3 候选）
 *   - completed: 后续 commit 决策 sweep 时由 extractor 标 done
 *   - superseded: 被 revoke 写新行覆盖（原行 supersededBy 也会写值）
 */
export type DecisionStatus = "active" | "completed" | "superseded"

export interface DecisionRow {
  decisionId: number
  roomId: string
  decidedAt: string
  decidedBy: string // alias
  decisionType: DecisionType
  content: string
  sourceMessageIds: string[] // JSON array
  sourceQuote: string // 原文 quote，不可改
  sourceHash: string // sha256(sourceQuote)
  tombstone: boolean
  supersededBy: number | null
  fencingToken: string
  extractorConfidence: number | null
  coverageCheckPassed: boolean | null
  status: DecisionStatus
}

export interface AppendDecisionInput {
  roomId: string
  decidedBy: string
  decisionType: DecisionType
  content: string
  sourceMessageIds: string[]
  sourceQuote: string
  fencingToken: string
  extractorConfidence?: number
  tombstone?: boolean
}

export interface RevokeDecisionInput {
  /** 被撤销的旧 decision_id（不能改原行，写新行 + 设原行 superseded_by） */
  oldDecisionId: number
  /** 撤销原因（写入新行 content，便于审计） */
  reason: string
  decidedBy: string
  fencingToken: string
}

// ─── Decision extractor ────────────────────────────────────────────────

/**
 * 宽召候选：从 messages 抓出"可能是决策"的短消息（不一定真是决策，需 LLM 二判）。
 * 关键词扫 + 上下文 join 上一条 assistant message。
 */
export interface BroadCandidate {
  messageId: string
  authorAlias: string
  createdAt: string
  /** 候选消息原文（≤ 500 字截断） */
  content: string
  /** 命中的关键词（debug 用） */
  matchedKeyword: string
  /** 上一条 assistant 消息（短指令"go"/"A" 必须 join 上下文判定） */
  prevAssistantContent: string | null
  prevAssistantId: string | null
}

/** Haiku 判定结果：是否决策 + 类型 + 抽取的决策内容 */
export interface CandidateJudgment {
  isDecision: boolean
  /** is_decision=true 时必填 */
  type?: DecisionType
  /** 抽取的决策内容（短指令需结合上下文补全：如 "批准合 F026" 而不是 "go"） */
  content?: string
  /** Haiku 自评 confidence 0-1（接 P11.b r2 Q4 教训：不天然校准） */
  confidence?: number
  /** 失败/超时时填，is_decision=false 时也可填 reason */
  reason?: string
  /**
   * P4 C-auto-2: 本次新决策（is_decision=true 时）完成了哪些旧 active commit 决策。
   * extractor LLM 在 prompt 里收到 active commit decisions 列表，判定本次消息
   * （如"F026 已合"）是否表示某些旧 commit 决策（如"进 merger-gate"）的完成。
   * 写入 ledger 时调用 markCompleted(supersedesDecisionIds) sweep 旧 commit。
   */
  supersedesDecisionIds?: number[]
}

/** Extractor 跑一轮的完整产出（写 ledger + Coverage Check 用） */
export interface ExtractorRun {
  broadCandidates: BroadCandidate[]
  /** 判定为 decision 的候选 + Haiku 输出，调用方写入 ledger */
  resolvedDecisions: Array<{ candidate: BroadCandidate; judgment: CandidateJudgment }>
  /** 判定为非 decision 的候选（Haiku 明确返 is_decision=false） */
  resolvedNonDecisions: Array<{ candidate: BroadCandidate; reason: string }>
  /** Haiku 失败 / 解析失败 / 超时的候选（unresolved，冒泡到 viewfinder warning） */
  unresolved: Array<{ candidate: BroadCandidate; error: string }>
}

// ─── Coverage Check（范-r2 Q2 三集合） ──────────────────────────────────

export type CoverageStatus = "pass" | "warn" | "unknown"

export interface CoverageReport {
  /** broad_candidates 总数（宽扫拿到的候选数） */
  broad: number
  /** resolved 总数（写入 ledger + 显式判 non-decision 之和） */
  resolved: number
  /** unresolved 数（Haiku 失败或解析错） */
  unresolved: number
  /** resolved / broad（broad=0 时为 null → status=unknown） */
  coverage: number | null
  status: CoverageStatus
  /** 触发 warn/unknown 的原因（写入 viewfinder frontmatter） */
  reason: string
  /** unresolved 候选 message_id（让用户手动确认入口） */
  unresolvedMessageIds: string[]
}

export interface CoverageOptions {
  /** coverage < passThreshold → status=warn（默认 0.95，plan chap 11 行 1247） */
  passThreshold?: number
  /** broad < minBroad → status=unknown（默认 3，分母太小不下结论） */
  minBroad?: number
}

// ─── Viewfinder renderer 输入输出 ──────────────────────────────────────

/** §4 等谁/blocker：F026 a2a_calls 实时查（含 B024 兜底 deadline_at 过滤） */
export interface BlockerCallRow {
  callId: string
  issuerId: string
  status: "pending" | "working" | "failed" | "timeout" | "cancelled"
  deadlineAt: string
  /** failed/timeout 时 LEFT JOIN messages.retry_reasons / content 提取的一句话 reason */
  reason?: string
}

export interface RenderViewfinderInput {
  roomId: string
  /** 当前 active 决策（status != superseded, ORDER BY decided_at DESC） */
  activeDecisions: DecisionRow[]
  /** tombstone=1 的决策（永久 §1 主题 + §6 不要再做候选） */
  tombstoneDecisions: DecisionRow[]
  /** 最近 N 条 messages（§2 进度关键词扫） */
  recentMessages: Array<{
    messageId: string
    authorAlias: string
    role: string
    content: string
    createdAt: string
  }>
  /** §4 实时查（已 deadline_at 24h 过滤） */
  blockerCalls: BlockerCallRow[]
  /** 房间标题 fallback（§1 主题无 spec 决策时用） */
  sessionGroupTitle: string
  /** Coverage Check 报告（写 frontmatter） */
  coverage: CoverageReport
  /** 编译时间戳（生成 viewfinder_id 用） */
  generatedAt: string
  /** 可选：last_committed_cursor message_id（写 frontmatter） */
  lastCommittedCursor?: string | null
}

export interface ViewfinderArtifact {
  /** viewfinder.md 完整内容（含 frontmatter + 6 段） */
  markdown: string
  /** §5 关键决策列表的 hash（MonthlySnapshot drift 比对用） */
  decisionsSummaryHash: string
  /** §5 关键决策列表的 token set（jaccard 算漂移用） */
  decisionsSummaryTokens: Set<string>
}

// ─── MonthlySnapshot drift（jaccard） ──────────────────────────────────

export interface DriftResult {
  /** jaccard(old_tokens, new_tokens) ∈ [0, 1] */
  jaccard: number
  /** drift = 1 - jaccard ∈ [0, 1] */
  drift: number
  /** drift > replaceThreshold（默认 0.3 = 30% — AC-P1-10 字面要求） */
  shouldReplace: boolean
  /** 旧 / 新 tokens 数 + 交集 / 并集 size（debug + 审计通知用） */
  details: {
    oldTokenCount: number
    newTokenCount: number
    intersectionSize: number
    unionSize: number
  }
}

export interface MonthlySnapshotInput {
  oldDecisionsSummaryTokens: Set<string>
  newDecisionsSummaryTokens: Set<string>
  /** 默认 0.3（30% 漂移触发 auto-replace） */
  replaceThreshold?: number
}

// ─── HaikuRunner 抽象（注入 + 测试 stub） ──────────────────────────────

/**
 * P4 C-auto-2: 活跃 commit 决策上下文 — 喂给 extractor LLM 判定本次新决策
 * 是否完成（supersede）哪些旧 commit。caller 从 ledger.getActiveByType('commit') 拉。
 */
export interface ActiveCommitForSweep {
  decisionId: number
  content: string
  decidedAt: string
}

export interface DecisionJudgeProvider {
  judge(input: {
    candidate: BroadCandidate
    timeoutMs?: number
    /** P4 C-auto-2: 注入 active commit decisions 让 LLM 判 supersedes */
    activeCommits?: ReadonlyArray<ActiveCommitForSweep>
  }): Promise<CandidateJudgment>
}

// ─── Errors ────────────────────────────────────────────────────────────

export class ViewfinderError extends Error {
  constructor(
    public readonly stage:
      | "extract"
      | "ledger_append"
      | "ledger_revoke"
      | "coverage"
      | "render"
      | "drift",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = "ViewfinderError"
  }
}
