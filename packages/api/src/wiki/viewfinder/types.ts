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
  /**
   * F027 final-vision P1-1 P2 修：额外的 source message refs（人工 reject 时触发本次操作的对话消息）。
   * 写入新 reject 行的 source_message_ids（前缀 `decision:<oldId>` 自动加在前）。
   */
  extraSourceMessageIds?: ReadonlyArray<string>
}

/**
 * F027 final-vision P1-1 P1 修：supersede 与 revoke 语义分流。
 *
 * Plan §3.6 (F027-phase4-implementation-plan.md) "选 supersede → 写新 ledger 行
 * supersede_id=旧 spec id" — 新行作为 commit 类型决策（接力旧 spec），不是 reject。
 *
 * 与 revoke 区别：
 *   - revoke: 新行 decisionType="reject"，content="撤销 D-<id>: <reason>"，旧行 superseded_by
 *   - supersede: 新行 decisionType="commit"，content=<reason 原文>，旧行 superseded_by
 *
 * 目的：让 viewfinder §5 / coverage 把 supersede 后产生的新 commit 行作为 active 新决策呈现，
 * 而不是显示一条 reject 审计行（与 modal UI 文案"新 commit 覆盖旧 spec"一致）。
 */
export interface SupersedeDecisionInput {
  /** 被覆盖的旧 decision_id（旧行 superseded_by = 新行 id）。 */
  oldDecisionId: number
  /** 新决策内容（写入新 commit 行 content）。 */
  reason: string
  decidedBy: string
  fencingToken: string
  /** 额外 source message refs（前缀 `decision:<oldId>` 自动加在前）。 */
  extraSourceMessageIds?: ReadonlyArray<string>
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

/**
 * §2 当前进度：feature/bugfix phase 坐标（P12.b 小孙 2026-05-22 拍方案 Y）
 *
 * 数据流：
 *   1. compile-fn 扫 recentMessages 内出现的 feature ID (regex `F\d+|B\d+`)
 *   2. spawn `git log -1 --format=%s --grep="<featureId>"` 抓最新 commit subject
 *   3. regex parse subject："Phase \d+" / "Week \d+" / "Day \d+" / "AC-P\d+-\d+"
 *   4. 用 recentMessages 含相同 featureId 验证 "commit 属于这房间"
 *   5. 任意步骤失败/空 → phaseInfo = null → renderer fallback (A) 当前实施列表
 *
 * 渲染（renderer 内）：
 *   "F027 Phase 3 Week 2 Day 10 (commit 694fcc1)"
 *   "已完成：- ... - ..."  ← 接 commit decisions 列表
 */
export interface PhaseInfo {
  featureId: string // "F027" / "B023"
  phase?: number // Phase 3
  week?: number // Week 2
  day?: number // Day 10
  acs?: string[] // ["AC-P3-10"]
  commitShortSha?: string // "694fcc1"
  commitSubject: string // 完整 subject（debug 用）
}

/**
 * §2/§3 站会式进度（小孙 2026-05-31 拍 A）—— 真相源 = feature.md 的 AC checklist。
 * 数据流：compile-fn 已知 featureId → 读 docs/features/<F-id>-*.md → 数 `- [x]/[ ] **AC-P*`。
 * 铁律：% 永远只数 checkbox，commit 一律不算 AC 完成（commit 只做 §2 in-flight 指针 + 漂移交叉验证）。
 * null = 非 feature 房 / 抓不到清单 → renderer fallback。
 */
export interface FeatureProgress {
  featureId: string // "F027"
  total: number // 清单总 AC 数
  done: number // 已勾 [x] 数
  pct: number // Math.round(done/total*100)
  /** 第一条未勾 AC = §3 下一步；全勾完为 null */
  firstUndoneAC: { id: string; title: string } | null
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
  /**
   * §2 phase 坐标（compile-fn spawn git log + 房间 ID 验证后预查好）
   * null = 抓不到 / 验证失败 / git 不可用 → renderer fallback (A) commit decisions 列表
   */
  phaseInfo?: PhaseInfo | null
  /**
   * §2 进度% + §3 下一步数据源（站会式，小孙 2026-05-31 拍 A）
   * null = 非 feature 房 / 抓不到清单 → §2 不显进度行、§3 退 spec/pivot 方向
   */
  featureProgress?: FeatureProgress | null
  /**
   * §1 主题：feature/bug 文档 H1 标题（站会式，小孙 2026-05-31 拍 A）
   * null = 非 feature/bug 房 / 抓不到 → §1 退 tombstone spec > active spec > 房间标题
   */
  featureTopic?: string | null
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
