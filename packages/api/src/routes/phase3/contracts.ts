/**
 * F027 Phase 3 P20 · Backend Contract 层 — Week 1 Day 2
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1 Day 2
 *   + 范-r1 P2-1 mitigation
 *
 * 职责：Phase 3 全部 8 个 HTTP endpoint 的 DTO / 错误码 enum / validate helper
 *   集中定义。Day 3-10 真 route 实施时 import 此处契约，**前端只认 HTTP 契约**。
 *
 * 8 endpoints（plan §3 Week 1 + Week 2）：
 *   - GET  /api/rooms/:id/viewfinder           (Week 1 Day 3)
 *   - GET  /api/wiki/drafts                    (Week 1 Day 3)
 *   - GET  /api/rooms/:id/prompt-inspector     (Week 1 Day 4)
 *   - POST /api/wiki/ingest/preview            (Week 1 Day 5)
 *   - POST /api/rooms/:id/decisions            (Week 2 Day 6 — AC-P3-8)
 *   - GET  /api/rooms/:id/decisions/coverage   (Week 2 Day 6 — AC-P3-8)
 *   - POST /api/wiki/ingest/commit             (Week 2 Day 10 — AC-P3-10)
 *   - GET  /api/scheduler/job-traces           (Week 2 Day 10)
 *
 * 设计原则：
 *   - 无新 deps：跟现有路由风格（手写 interface + validate 纯函数）
 *   - 序列化边界：date 用 ISO string，bigint 用 string
 *   - 错误码集中 ErrorCode enum；validate 返 `{ ok: true; value } | { ok: false; error; message }`
 *   - 空状态明示：用 null（单值）/ 空数组（列表）/ undefined（可选字段）
 *   - 权限/roomId 边界：validateRoomId 集中入口
 *
 * 不做：
 *   - 不写 fastify route 本体（Day 3-10 实施）
 *   - 不接 service / repository（contract 层纯类型 + 校验，无 IO）
 *   - 不引入 zod / typebox / 任何 runtime schema lib
 *
 * 范-r2 节奏复核 P2-1：本文件 + contracts.test.ts 是 Day 2 唯一交付。
 */

// ── 共享 ────────────────────────────────────────────────────────────

/** Phase 3 全部错误码（前端按 `code` 字段路由 UI 文案）。 */
export const ErrorCode = {
  /** roomId 格式不合法（如非 R-XXX 模式 / 空 / 含非法字符）。 */
  INVALID_ROOM_ID: "INVALID_ROOM_ID",
  /** room 不存在（已归档 / soft-deleted / 从未存在）。 */
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
  /** 当前请求未通过权限 / ACL 检查。 */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** Iron Laws 3 违反（如 wiki.config.yaml 未经 Gate 2 偷偷出现）。 */
  IRON_LAWS_3_BLOCKED: "IRON_LAWS_3_BLOCKED",
  /** Gate 2 未批准但请求路径要求真 wiki.config.yaml。 */
  GATE_2_NOT_APPROVED: "GATE_2_NOT_APPROVED",
  /** wiki lease/fencing 失败（CAS 冲突 / token stale）。 */
  LEASE_FENCING_FAILED: "LEASE_FENCING_FAILED",
  /** draft path 不存在 / 已被 promote / 已过期 _expired。 */
  DRAFT_NOT_FOUND: "DRAFT_NOT_FOUND",
  /** decision 内容不合法（必填字段缺 / type 越界 / evidence 链断）。 */
  DECISION_INVALID: "DECISION_INVALID",
  /** Adaptive Recall per-turn budget 触顶（Phase 1 AC-P1-12 配套）。 */
  RECALL_BUDGET_EXCEEDED: "RECALL_BUDGET_EXCEEDED",
  /** preview/commit endpoint 输入字段不合法（mimeType 不支持 / payload 过大 等）。 */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** 服务内部错误（DB / fs / 编译失败）兜底，前端走 generic 错误处理。 */
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const HTTP_STATUS_BY_ERROR: Record<ErrorCode, number> = {
  INVALID_ROOM_ID: 400,
  ROOM_NOT_FOUND: 404,
  UNAUTHORIZED: 403,
  IRON_LAWS_3_BLOCKED: 423, // Locked — 资源在合规锁定中（非典型 423，但语义最贴）
  GATE_2_NOT_APPROVED: 403,
  LEASE_FENCING_FAILED: 409, // Conflict
  DRAFT_NOT_FOUND: 404,
  DECISION_INVALID: 400,
  RECALL_BUDGET_EXCEEDED: 429, // Too Many Requests
  VALIDATION_FAILED: 400,
  INTERNAL_ERROR: 500,
}

/** 标准错误响应体（所有 endpoint 失败统一形态）。 */
export interface ErrorResponseBody {
  error: ErrorCode
  message: string
  /** 可选 detail（含 field/path/value 等机器可读补充；前端透传到 inspector）。 */
  detail?: Record<string, unknown>
}

/**
 * Preview / ingest 类警告条目（contract §4 PreviewIngestResponse.warnings 等用）。
 *
 * 范-r1 P2-3 锁定：`subkind` 透传 sanitize redLineTrigger.reason / quarantineSegment.reason
 * 的原始 enum，前端 UI 可按 subkind 渲染不同 icon / 颜色，不再 parse message string。
 */
export interface PreviewWarning {
  /** 大类（前端 UI 路由 4 色：sensitive_token 红 / size_truncated 黄 / encoding 灰 / binary_skipped 蓝）。 */
  kind:
    | "sensitive_token"
    | "size_truncated"
    | "encoding"
    | "binary_skipped"
    | "compile_failed"
    | "multi_drop"
  /**
   * 子类（透传 sanitize 内部 reason），如：
   *   - jailbreak_template / dangerous_html_tag / dangerous_url_scheme / encoded_jailbreak / size_exceeded（redline）
   *   - encoding_base64 / encoding_rot13 / encoding_high_entropy / control_char / invisible_format_char / ...
   *   - 缺省时 = undefined（前端只渲染 kind 大类）
   */
  subkind?: string
  message: string
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorCode; message: string; detail?: Record<string, unknown> }

/** roomId 格式：`R-` 后接 1-6 位数字，与 V16.5 P0 chap 4 命名规范一致。 */
const ROOM_ID_RE = /^R-\d{1,6}$/

export function validateRoomId(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "INVALID_ROOM_ID", message: "roomId required" }
  }
  if (!ROOM_ID_RE.test(raw)) {
    return {
      ok: false,
      error: "INVALID_ROOM_ID",
      message: `roomId must match ${ROOM_ID_RE}, got ${JSON.stringify(raw)}`,
    }
  }
  return { ok: true, value: raw }
}

function takeOptionalString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "string") return undefined
  if (raw.length === 0) return undefined
  return raw
}

function takeOptionalInt(
  raw: unknown,
  { min, max, field }: { min: number; max: number; field: string },
): ValidationResult<number | undefined> {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined }
  }
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return {
      ok: false,
      error: "VALIDATION_FAILED",
      message: `${field} must be an integer, got ${JSON.stringify(raw)}`,
    }
  }
  if (n < min || n > max) {
    return {
      ok: false,
      error: "VALIDATION_FAILED",
      message: `${field} must be in [${min}, ${max}], got ${n}`,
    }
  }
  return { ok: true, value: n }
}

// ── 1. GET /api/rooms/:id/viewfinder ────────────────────────────────

export interface GetViewfinderPath {
  roomId: string
}

/** ViewfinderArtifact 的 HTTP 边界版本（render 详情见 viewfinder-renderer.ts）。 */
export interface GetViewfinderResponse {
  /** rendered viewfinder markdown；null = 尚未编译（首次访问 + 后台任务未跑）。 */
  viewfinder: string | null
  /** Coverage report — Phase 1 AC-P1-10 三集合。 */
  coverage: {
    broad: number
    resolved: number
    unresolved: number
    /** broad 为 0 时 coverage = null；否则 = resolved/broad。 */
    coverage: number | null
    status: "pass" | "warn" | "fail"
  }
  /** Viewfinder 编译时刻 ISO；null = 未编译。 */
  lastCompiledAt: string | null
  /**
   * Decision ledger cursor（active 决策计数 + 最新 decision_id）。
   *
   * **`latestDecisionId` 语义**（范-r1 P1-2 锁定）：
   *   - 现阶段 = `room_decisions.decision_id`（INTEGER AUTO_INCREMENT PK）的 stringified 形式
   *   - 与 POST /api/rooms/:id/decisions 返回的 `decisionId: string` 同源（Week 2 Day 6 AC-P3-8 一致）
   *   - **不要**按 "dec-042" 之类的语义 ID 解释；它就是数字 ROWID stringified
   *   - 前端 ledger cursor invalidation 只需比对字符串相等性，不解析数字
   *
   * **`activeCount` 语义**（范-r1 P1-3 锁定）：
   *   - = WHERE status = 'active' AND superseded_by IS NULL AND tombstone = 0
   *   - tombstone=1 的"永久投影"决策**不算 active**（按 P12 viewfinder 语义）
   */
  ledger: {
    activeCount: number
    latestDecisionId: string | null
  }
}

export function validateGetViewfinder(pathParams: unknown): ValidationResult<GetViewfinderPath> {
  const obj = pathParams as Record<string, unknown> | null
  const idCheck = validateRoomId(obj?.id)
  if (!idCheck.ok) return idCheck
  return { ok: true, value: { roomId: idCheck.value } }
}

// ── 2. GET /api/wiki/drafts ──────────────────────────────────────────

export type DraftType = "feature" | "bug" | "lesson" | "concept" | "wiki-memory" | "session-archive"

export interface ListDraftsQuery {
  /** 过滤 draft 类型；不传 = 全部。 */
  type?: DraftType
  /** mtime 区间过滤（ISO）；不传 = 不限。 */
  mtimeFrom?: string
  mtimeTo?: string
  /** 分页：limit ∈ [1, 200]，默认 50；offset ≥ 0，默认 0。 */
  limit?: number
  offset?: number
}

export interface DraftSummary {
  /** 相对 wiki root 的路径，如 `concepts/draft/_auto/2026-05-20-foo.md`。 */
  path: string
  type: DraftType
  /** 标题（取 frontmatter.title 或文件名 fallback）。 */
  title: string
  /** mtime ISO。 */
  mtime: string
  /** 摘要前 200 字（无 frontmatter / 无 body 时返空串）。 */
  summary: string
  /** _backfill / _auto / user-drop 三类 origin（V16.5.3 D3）。 */
  origin: "user-drop" | "auto" | "backfill" | "expired"
  /**
   * F027 bucket-routing 补丁 · promote 目标路径建议：LLM 编译的 canonical_owner_suggestion
   * （合法桶白名单校验，非法/缺失 fallback wiki/concepts/）+ 文件名（去 -<13位unixMs> 版本后缀）。
   * PromoteModal 预填 / BatchPromoteModal 行初值用；用户可改。
   */
  suggestedDestPath: string
}

export interface ListDraftsResponse {
  drafts: DraftSummary[]
  /** 满足 filter 的总数（用于 client 分页 ui）。 */
  total: number
  /** 实际返回的分页参数（echo + clamp 后值）。 */
  limit: number
  offset: number
}

export function validateListDrafts(query: unknown): ValidationResult<ListDraftsQuery> {
  const q = (query ?? {}) as Record<string, unknown>
  const result: ListDraftsQuery = {}

  const typeRaw = takeOptionalString(q.type)
  if (typeRaw !== undefined) {
    const allowed: DraftType[] = [
      "feature",
      "bug",
      "lesson",
      "concept",
      "wiki-memory",
      "session-archive",
    ]
    if (!(allowed as string[]).includes(typeRaw)) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `type must be one of ${allowed.join(", ")}, got ${typeRaw}`,
      }
    }
    result.type = typeRaw as DraftType
  }

  const mtimeFrom = takeOptionalString(q.mtimeFrom)
  if (mtimeFrom !== undefined) {
    if (Number.isNaN(Date.parse(mtimeFrom))) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `mtimeFrom must be ISO timestamp, got ${mtimeFrom}`,
      }
    }
    result.mtimeFrom = mtimeFrom
  }
  const mtimeTo = takeOptionalString(q.mtimeTo)
  if (mtimeTo !== undefined) {
    if (Number.isNaN(Date.parse(mtimeTo))) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `mtimeTo must be ISO timestamp, got ${mtimeTo}`,
      }
    }
    result.mtimeTo = mtimeTo
  }
  if (
    result.mtimeFrom !== undefined &&
    result.mtimeTo !== undefined &&
    Date.parse(result.mtimeFrom) > Date.parse(result.mtimeTo)
  ) {
    return {
      ok: false,
      error: "VALIDATION_FAILED",
      message: "mtimeFrom must be <= mtimeTo",
    }
  }

  const limit = takeOptionalInt(q.limit, { min: 1, max: 200, field: "limit" })
  if (!limit.ok) return limit
  if (limit.value !== undefined) result.limit = limit.value

  const offset = takeOptionalInt(q.offset, { min: 0, max: 1_000_000, field: "offset" })
  if (!offset.ok) return offset
  if (offset.value !== undefined) result.offset = offset.value

  return { ok: true, value: result }
}

// ── 3. GET /api/rooms/:id/prompt-inspector ──────────────────────────

export interface GetPromptInspectorPath {
  roomId: string
}
export interface GetPromptInspectorQuery {
  /** 可选 threadId 过滤；不传 = room 内 active thread 默认。 */
  threadId?: string
  /**
   * F027 P4 hotfix · 可选 limit 控制返几条 audit row（默认 1，最新一条）。
   * limit=2 用于「对比上次注入」按钮：拿 [当前, 上一次] 做 part-by-part diff。
   * 范围 [1, 10]；越界回 1。
   */
  limit?: number
  /**
   * F027 v3 G4 · 可选 alias 过滤（多 agent room 看每个 agent 自己的 system prompt）。
   *
   * 不传 = room 内最新 audit（不限 alias，与 v3 之前行为兼容）。
   * 传 alias = 只取该 alias 的 audit row（黄仁勋/范德彪/桂芬 分开看）。
   *
   * 痛点 2 "反复教 agent" 闭环：之前 prompt-inspector.ts WHERE 只 room_id 不限 alias，
   * 多 agent 触发时 Inspector 只显示"最后写入的那个 agent"，看不到其他 agent。
   */
  alias?: string
}
export interface GetPromptInspectorRequest
  extends GetPromptInspectorPath,
    GetPromptInspectorQuery {}

export interface InjectedPart {
  /** 注入区段名（如 `IronLaws` / `RecallPack` / `Viewfinder` / `CapabilityRegistry`）。 */
  name: string
  /** 区段 byte 长度（前端按比例展示 token 占比）。 */
  bytes: number
  /** 估算 token 数（按 4 char ≈ 1 token 经验近似）。 */
  tokensEstimated: number
  /** 区段渲染源（拼装 commit / 注入时刻 ISO）。 */
  source: string
}

/**
 * F027 v3 G1 · 未注入 part（context-assembler.ts drop reducer 砍掉的）。
 *
 * V16.5 chap 20 token cap 溢出时按 DROP_ORDER 顺序丢弃；前端 NotInjectedSection
 * 渲染 "❌ {name} ({tokens} tok) — {reason}"。
 */
export interface NotInjectedPart {
  name: string
  tokens: number
  reason: "over_cap_drop_order" | string
}

export type RecallGate = "high" | "mid" | "low"

export interface RecallQueryItem {
  /** 自动召回的 query 文本（task summary 抽出的 2-5 query 之一）。 */
  query: string
  /** Hybrid 检索 hit 数（BM25 + cosine 合并后）。 */
  hits: number
  /** Quality Gate 三段分类。 */
  gate: RecallGate
  /** 高/中置信置信度（NoopReranker 透传时是 hybrid_score；真 LLM rerank 时是校准 confidence）。 */
  topScore: number
}

export interface AdaptiveRecallState {
  /** 触发了 recall 流程吗。 */
  recallRequired: boolean
  /** 走到哪个 Level（1-5）；null = 未触发。 */
  recallPath: 1 | 2 | 3 | 4 | 5 | null
  /** 是否在某 Level 拿到满意结果（Critique Agent 判定）。 */
  recallSatisfied: boolean
  /** 触发 Level 5 escalate 的原因（如 "Level 4 strict path 不存在"）。 */
  escalateReason: string | null
  /** Per-turn budget 消耗 token 数。 */
  budgetConsumed: number
  /** Per-turn budget 上限。 */
  budgetMax: number
}

export interface GetPromptInspectorResponse {
  /** 当前 prompt 注入的 part 列表（IronLaws / RecallPack / Viewfinder 等）。 */
  injectedParts: InjectedPart[]
  /** 自动召回 query 列表 + Quality Gate 三段。 */
  recallQueries: RecallQueryItem[]
  /** Adaptive Recall Policy 状态（依赖 AC-P3-9 wiring 真数据）。 */
  recallState: AdaptiveRecallState
  /** wake-up 触发因（AC-P3-5 数据，可能为空）。 */
  wakeUpTrigger: {
    kind: "a2a_call" | "user_message" | "scheduler_tick" | null
    ref: string | null
  }
  /**
   * F027 P4 hotfix · 完整 raw prompt 文本 (systemPrompt + content)。
   * V16.5 §18 line 2078 "[查看 raw text]" + "[复制全文]" 按钮源数据。
   * null = 当前 room 还没 audit row（没拼装过）。
   */
  rawText: string | null
  /**
   * F027 P4 hotfix · Iron Laws 出现次数 (B022 防回归 — V16.5 §2 line 246)。
   * runtime 端期望 = 1; ≥ 3 警告"4 源冗余回归"; 0 警告"base prompt 漏注"。
   */
  ironLawsCount: number
  /** F027 P4 hotfix · 最新 audit row 的 scenario，inspector header 显示用。 */
  scenario: string | null
  /**
   * F027 P4 hotfix · 历史 audit 行（按 id DESC 第 2 条起）。
   * limit=1 时为 []，limit=2 时长度 ≤ 1（如有上一次拼装）。
   * 用于「对比上次注入」按钮做 part-by-part diff。
   */
  previousAudits: Array<{
    injectedParts: InjectedPart[]
    rawText: string
    ironLawsCount: number
    scenario: string
    createdAt: string
  }>
  /**
   * F027 v3 G1 · V16.5 chap 20 wake-up runtime token cap (= WAKEUP_TOKEN_CAP, 默认 6700)。
   * 0 = 老 audit 行（v3 之前写的占位 cap=0）；前端 header 显示 "cap N tok"。
   */
  cap: number
  /**
   * F027 v3 G1 · drop reducer 砍掉的 part 列表（cap 溢出时按 DROP_ORDER 丢弃）。
   * [] = 全部注入成功；非空时前端 NotInjectedSection 列每条 "{name} ({tokens} tok) — {reason}"。
   */
  notInjectedParts: NotInjectedPart[]
  /**
   * F027 v3 G4 · 当前 audit row 的 alias（如 "黄仁勋"）；null = 空 audit。
   *
   * caller 显式传 alias 时即等于 query alias；不传时取最新 row 的实际 alias。
   * 前端 dropdown 同步显示当前选中 alias。
   */
  selectedAlias: string | null
  /**
   * F027 v3 G4 · room 内所有 distinct alias 列表（前端 dropdown 选项）。
   *
   * 用 `SELECT DISTINCT alias FROM prompt_audit WHERE room_id = ?` 查；按 alias asc 排。
   * 空数组 = room 内还没 audit row（前端 dropdown disabled）。
   */
  availableAliases: string[]
}

export function validateGetPromptInspector(
  pathParams: unknown,
  query: unknown,
): ValidationResult<GetPromptInspectorRequest> {
  const path = pathParams as Record<string, unknown> | null
  const idCheck = validateRoomId(path?.id)
  if (!idCheck.ok) return idCheck
  const q = (query ?? {}) as Record<string, unknown>
  const threadId = takeOptionalString(q.threadId)
  // F027 v3 G4 · alias 过滤可选参数（多 agent room 看 per-agent prompt）
  const alias = takeOptionalString(q.alias)
  // limit query 解析：未传/空/越界 → 默认 1；clamp [1, 10]
  let limit = 1
  const rawLimit = q.limit
  if (typeof rawLimit === "string" && rawLimit.length > 0) {
    const parsed = Number(rawLimit)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 10) limit = Math.floor(parsed)
  } else if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
    if (rawLimit >= 1 && rawLimit <= 10) limit = Math.floor(rawLimit)
  }
  return { ok: true, value: { roomId: idCheck.value, threadId, alias, limit } }
}

// ── 4. POST /api/wiki/ingest/preview ────────────────────────────────

/** 支持的 ingest mime 类型（V16.5.3 ingest pipeline 锁定）。 */
export const SUPPORTED_INGEST_MIME = ["text/markdown", "text/plain", "application/json"] as const

export type IngestMime = (typeof SUPPORTED_INGEST_MIME)[number]

export interface PreviewIngestBody {
  /** 来源路径标识（用户拖入文件的 fileName / slash 命令 args）；用于 frontmatter source_path。 */
  sourcePath: string
  /** 原始内容（限 ≤ 1 MB；contract 层只断长度，sanitize 在 service 层）。 */
  content: string
  mimeType: IngestMime
  /** 可选目标 type override；不传时由 service 推断。 */
  targetType?: DraftType
  /**
   * F027 P4 Day 10 (AC-P4-3 e) · Series 标记（防 chained 误检）。
   *
   * 真相源: V16.5 chap 25 line 2563-2564 "🔗 系列 (防 chained 误检)"
   *   + plan v5 line 42 "Series 标记走 IngestModal '加入系列'字段"
   *
   * 用户在 IngestModal "🔗 系列" 字段填写，表示这个 drop 是某系列的一部分
   * （e.g., 分多次 drop 长 paper 各章节）。落盘时写入 frontmatter `series_id: <id>`。
   * 后续 multi-drop cross-correlation chained_suspect 检测会跳过同 series_id 的命中
   * （避免连续 drop 同 series 触发误报）。
   *
   * 长度限制: 1-64 chars; allowed pattern [a-zA-Z0-9_-]+。
   * 不传 / 空 → 不写 series_id metadata。
   */
  seriesId?: string
}

export interface PreviewIngestResponse {
  /**
   * 预览 ID（commit endpoint 会引用此 ID 真落盘）。
   * blocked=true 时为 ""（从未入 store，发幽灵 id 会让 commit 误报 DRAFT_NOT_FOUND）。
   */
  previewId: string
  /**
   * F027 续 · sanitize 红线触发（jailbreak/危险 HTML/quarantine ratio 超阈值）→ true。
   * 消费方据此直报 sanitize_blocked，禁止再拿 previewId 去 commit。
   * 注意不能用 warnings 含 sensitive_token 推断（隔离段非红线也产同 kind warning）。
   */
  blocked: boolean
  /** Sanitize 后的内容（5 层 sanitize 过；不含 .env / Gemini cookie 等敏感 token）。 */
  sanitizedContent: string
  /** LLM 编译预览（建议落盘的 final markdown 草稿）。 */
  llmCompiledPreview: string
  /** Sanitize 阶段触发的 warning 列表（范-r1 P2-3：subkind 透传原始 reason）。 */
  warnings: PreviewWarning[]
  /** 预览过期时刻（commit 必须在此前调用，否则 previewId 失效）。 */
  expiresAt: string
}

const MAX_INGEST_CONTENT_BYTES = 1_048_576

export function validatePreviewIngest(body: unknown): ValidationResult<PreviewIngestBody> {
  const b = body as Record<string, unknown> | null
  if (!b) {
    return { ok: false, error: "VALIDATION_FAILED", message: "body required" }
  }
  const sourcePath = takeOptionalString(b.sourcePath)
  if (sourcePath === undefined) {
    return { ok: false, error: "VALIDATION_FAILED", message: "sourcePath required" }
  }
  const content = b.content
  if (typeof content !== "string") {
    return { ok: false, error: "VALIDATION_FAILED", message: "content must be string" }
  }
  if (content.length === 0) {
    return { ok: false, error: "VALIDATION_FAILED", message: "content must not be empty" }
  }
  const bytes = Buffer.byteLength(content, "utf-8")
  if (bytes > MAX_INGEST_CONTENT_BYTES) {
    return {
      ok: false,
      error: "VALIDATION_FAILED",
      message: `content exceeds ${MAX_INGEST_CONTENT_BYTES} bytes, got ${bytes}`,
    }
  }
  const mimeType = takeOptionalString(b.mimeType)
  if (mimeType === undefined) {
    return { ok: false, error: "VALIDATION_FAILED", message: "mimeType required" }
  }
  if (!(SUPPORTED_INGEST_MIME as readonly string[]).includes(mimeType)) {
    return {
      ok: false,
      error: "VALIDATION_FAILED",
      message: `mimeType must be one of ${SUPPORTED_INGEST_MIME.join(", ")}, got ${mimeType}`,
    }
  }
  const targetType = takeOptionalString(b.targetType)
  // F027 P4 Day 10 AC-P4-3 e · seriesId 校验 (1-64 chars + [a-zA-Z0-9_-]+ pattern)
  const seriesIdRaw = takeOptionalString(b.seriesId)
  let seriesId: string | undefined
  if (seriesIdRaw !== undefined && seriesIdRaw.length > 0) {
    if (seriesIdRaw.length > 64) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `seriesId max 64 chars, got ${seriesIdRaw.length}`,
      }
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(seriesIdRaw)) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `seriesId must match [a-zA-Z0-9_-]+ (no spaces / special chars), got: ${seriesIdRaw}`,
      }
    }
    seriesId = seriesIdRaw
  }
  return {
    ok: true,
    value: {
      sourcePath,
      content,
      mimeType: mimeType as IngestMime,
      targetType: targetType as DraftType | undefined,
      seriesId,
    },
  }
}

// ── 5. POST /api/rooms/:id/decisions （AC-P3-8 manual confirm） ──────

/**
 * Decision kind 语义（Day 6 Phase 1 P12 ledger 对接 + final-vision P1-1 P1 修）:
 *   - `commit`  → ledger.append({decisionType:'commit'})；可选 supersedesDecisionId → ledger.revoke
 *                (Day 6 backward compat — commit + supersedesDecisionId 仍写 reject 行覆盖)
 *   - `reject`  → ledger.append({decisionType:'reject'})；可选 supersedesDecisionId → ledger.revoke
 *   - `tombstone` → ledger.markTombstone(supersedesDecisionId, fencingToken)；
 *                   **不写新行**，UPDATE 旧行 tombstone=1（永久投影）；supersedesDecisionId 必填
 *   - `supersede` (F027 final-vision P1-1) → ledger.supersede；supersedesDecisionId 必填；
 *                   写新 commit 行 + UPDATE 旧行 superseded_by；语义 = 新决策接力旧 spec/commit
 *
 * 注：P12 schema 里 decision_type 取值是 spec|pivot|commit|reject（无 tombstone/supersede）；
 * tombstone 是 row 上独立的 0/1 字段。本契约 kind=tombstone 映射到 markTombstone 动作；
 * kind=supersede 映射到 ledger.supersede 新方法（写 decision_type='commit' 新行）。
 */
export type DecisionKind = "commit" | "reject" | "tombstone" | "supersede"

export interface PostDecisionPath {
  roomId: string
}
export interface PostDecisionBody {
  kind: DecisionKind
  /** decision 文本（人话描述）。kind=tombstone 时 content 是 mark 原因（仅审计用）。 */
  content: string
  /** Evidence chain — msg_id / decision_id 链 ref；至少 1 条。 */
  evidence: Array<{
    kind: "message" | "decision"
    /** msg_id 或 decision_id。 */
    ref: string
  }>
  /**
   * 撤销/tombstone 的目标 decision_id。
   *   - kind=commit/reject + 给 → ledger.revoke（写新行 + 标旧行 superseded）
   *   - kind=commit/reject + 不给 → ledger.append（新决策）
   *   - kind=tombstone + 必填 → ledger.markTombstone（UPDATE 旧行 tombstone=1）
   *   - kind=tombstone + 不给 → DECISION_INVALID
   */
  supersedesDecisionId?: string
  /**
   * 操作者 alias（manual confirm 真人/agent 谁拍的）。审计必填。
   * Day 6：服务侧无 auth middleware，前端在 body 显式带，与 §7 ingest commit 一致。
   */
  callerAlias: string
}
export interface PostDecisionRequest extends PostDecisionPath {
  body: PostDecisionBody
}

export interface PostDecisionResponse {
  /**
   * 操作结果对应的 decision_id（stringified ROWID）：
   *   - append → 新行 id
   *   - revoke → 新 reject 行 id（旧行 id 在 supersedesDecisionId 字段）
   *   - tombstone → 被 mark 的旧行 id（无新行）
   */
  decisionId: string
  /** 新 ledger cursor（client 拿来 invalidate viewfinder cache）。 */
  ledgerCursor: number
  /** 写盘时刻 ISO。 */
  appendedAt: string
  /** 本次执行的动作（前端 UI 区分 toast 文案）。 */
  action: "append" | "revoke" | "tombstone" | "supersede"
}

export function validatePostDecision(
  pathParams: unknown,
  body: unknown,
): ValidationResult<PostDecisionRequest> {
  const path = pathParams as Record<string, unknown> | null
  const idCheck = validateRoomId(path?.id)
  if (!idCheck.ok) return idCheck

  const b = body as Record<string, unknown> | null
  if (!b) {
    return { ok: false, error: "DECISION_INVALID", message: "body required" }
  }
  const kindRaw = takeOptionalString(b.kind)
  if (kindRaw === undefined || !["commit", "reject", "tombstone", "supersede"].includes(kindRaw)) {
    return {
      ok: false,
      error: "DECISION_INVALID",
      message: `kind must be commit|reject|tombstone|supersede, got ${kindRaw}`,
    }
  }
  const content = takeOptionalString(b.content)
  if (content === undefined) {
    return { ok: false, error: "DECISION_INVALID", message: "content required" }
  }
  if (content.length > 4000) {
    return { ok: false, error: "DECISION_INVALID", message: "content exceeds 4000 chars" }
  }
  const rawEvidence = b.evidence
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
    return {
      ok: false,
      error: "DECISION_INVALID",
      message: "evidence required (at least 1 ref)",
    }
  }
  const evidence: PostDecisionBody["evidence"] = []
  for (let i = 0; i < rawEvidence.length; i += 1) {
    const e = rawEvidence[i] as Record<string, unknown> | null
    if (!e) {
      return {
        ok: false,
        error: "DECISION_INVALID",
        message: `evidence[${i}] must be object`,
      }
    }
    const ek = takeOptionalString(e.kind)
    const ref = takeOptionalString(e.ref)
    if (ek === undefined || !["message", "decision"].includes(ek)) {
      return {
        ok: false,
        error: "DECISION_INVALID",
        message: `evidence[${i}].kind must be message|decision, got ${ek}`,
      }
    }
    if (ref === undefined) {
      return {
        ok: false,
        error: "DECISION_INVALID",
        message: `evidence[${i}].ref required`,
      }
    }
    evidence.push({ kind: ek as "message" | "decision", ref })
  }
  const supersedes = takeOptionalString(b.supersedesDecisionId)
  const callerAlias = takeOptionalString(b.callerAlias)
  if (callerAlias === undefined) {
    return {
      ok: false,
      error: "DECISION_INVALID",
      message: "callerAlias required (manual confirm 必须知道谁拍的)",
      detail: { reason: "caller_required" },
    }
  }
  if (kindRaw === "tombstone" && supersedes === undefined) {
    return {
      ok: false,
      error: "DECISION_INVALID",
      message: "kind=tombstone requires supersedesDecisionId (mark 哪条旧行)",
      detail: { reason: "tombstone_requires_target" },
    }
  }
  if (kindRaw === "supersede" && supersedes === undefined) {
    return {
      ok: false,
      error: "DECISION_INVALID",
      message: "kind=supersede requires supersedesDecisionId (覆盖哪条旧行)",
      detail: { reason: "supersede_requires_target" },
    }
  }
  // tombstone 的 ref 必须是数字 ROWID（与 P12 decision_id 一致）
  if (supersedes !== undefined && !/^\d+$/.test(supersedes)) {
    return {
      ok: false,
      error: "DECISION_INVALID",
      message: `supersedesDecisionId must be numeric ROWID stringified, got ${supersedes}`,
      detail: { reason: "invalid_decision_id" },
    }
  }

  return {
    ok: true,
    value: {
      roomId: idCheck.value,
      body: {
        kind: kindRaw as DecisionKind,
        content,
        evidence,
        supersedesDecisionId: supersedes,
        callerAlias,
      },
    },
  }
}

// ── 6. GET /api/rooms/:id/decisions/coverage ────────────────────────

export interface GetCoveragePath {
  roomId: string
}
export interface DecisionRef {
  /** ROWID stringified（与 §5 PostDecisionResponse.decisionId 同源）。 */
  decisionId: string
  /** 简要描述（取 content 前 100 字 + ellipsis）。 */
  summary: string
  /**
   * 当前状态（基于 ledger 终态）：
   *   - active     = status='active' AND superseded_by IS NULL AND tombstone=0
   *   - completed  = status='completed'（被新 commit sweep 完成）
   *   - superseded = status='superseded' OR superseded_by IS NOT NULL（被 revoke 覆盖）
   *   - tombstone  = tombstone=1（永久投影，覆盖其他 status）
   */
  state: "active" | "completed" | "superseded" | "tombstone"
  /** 决策类型（commit/reject/spec/pivot）。 */
  decisionType: string
  /** 决策记录人 alias。 */
  decidedBy: string
  /** ISO 时间。 */
  decidedAt: string
}

/**
 * Day 6 Phase 1 P12 ledger 出发的三集合语义（contracts §1.4 plan v3.1 锁定）:
 *
 *   - **broad**     = room 内所有 decision rows（不论 status / tombstone）
 *   - **resolved**  = state ∈ {completed, superseded, tombstone}（已闭环 / 已覆盖 / 已永久投影）
 *   - **unresolved** = state = active（前端 AC-P3-8 unresolved 入口列表 — UI click → manual confirm）
 *
 * Day 6 暂不接 Coverage Check 候选层（Haiku 没判定的 broad_candidates message 候选）；
 * 那部分需要 Phase 1 P12 viewfinder 写盘逻辑 ALTER（写 unresolvedMessageIds 到 frontmatter），
 * 留 Week 5 buffer 或 Phase 4 backfill。
 *
 * status 阈值（与 Phase 1 CoverageReport 一致）:
 *   - pass: coverage >= 0.95
 *   - warn: 0 < coverage < 0.95 OR broad < 3（分母过小不确信）
 *   - fail: broad = 0（无 decision 无法判定）
 */
export interface GetCoverageResponse {
  broad: DecisionRef[]
  resolved: DecisionRef[]
  unresolved: DecisionRef[]
  /** 标量：resolved.length / broad.length（broad=0 时 null）。 */
  coverage: number | null
  status: "pass" | "warn" | "fail"
  generatedAt: string
}

export function validateGetCoverage(pathParams: unknown): ValidationResult<GetCoveragePath> {
  const path = pathParams as Record<string, unknown> | null
  const idCheck = validateRoomId(path?.id)
  if (!idCheck.ok) return idCheck
  return { ok: true, value: { roomId: idCheck.value } }
}

// ── 7. POST /api/wiki/ingest/commit （AC-P3-10 落盘闭环） ───────────

export interface PostIngestCommitBody {
  /** 之前 preview endpoint 返回的 previewId。 */
  previewId: string
  /** ACL：caller alias（拿不到 leader 写权限时拒绝）。 */
  callerAlias: string
  /** 可选 lease token（持有 lease 写更稳；不持有时由 server 端 acquire 兜底）。 */
  leaseToken?: string
}

export interface PostIngestCommitResponse {
  /** 落盘后的 wiki_events row id（commit 后 client 拿来 invalidate caches）。 */
  ingestEventId: string
  /** 最终落盘的 wiki 相对路径（如 `concepts/draft/_auto/2026-05-20-foo.md`）。 */
  finalPath: string
  /** Commit 时刻 ISO。 */
  committedAt: string
  /** 落盘前 fencing token（用于审计）。 */
  fencingToken: string
}

export function validatePostIngestCommit(body: unknown): ValidationResult<PostIngestCommitBody> {
  const b = body as Record<string, unknown> | null
  if (!b) {
    return { ok: false, error: "VALIDATION_FAILED", message: "body required" }
  }
  const previewId = takeOptionalString(b.previewId)
  if (previewId === undefined) {
    return { ok: false, error: "VALIDATION_FAILED", message: "previewId required" }
  }
  const callerAlias = takeOptionalString(b.callerAlias)
  if (callerAlias === undefined) {
    // 范-r1 P2-2：缺字段 = 入参校验失败，不是权限拒绝（前端 UNAUTHORIZED 通常会走重登/refresh）。
    // ACL 真拒绝（alias 存在但无 write 权限）走 service 层返 UNAUTHORIZED。
    return {
      ok: false,
      error: "VALIDATION_FAILED",
      message: "callerAlias required",
      detail: { reason: "caller_required" },
    }
  }
  const leaseToken = takeOptionalString(b.leaseToken)
  return { ok: true, value: { previewId, callerAlias, leaseToken } }
}

// ── 8. GET /api/scheduler/job-traces ────────────────────────────────

export type JobTraceStatusFilter =
  | "ok"
  | "failed"
  | "timeout"
  | "skipped_reentry"
  | "skipped_not_leader"
  | "missed_window"
  | "recovered_from_crash"
  | "lease_lost"

export interface ListJobTracesQuery {
  /** 过滤 jobName（如 "room-compiler-tick"）；不传 = 全部。 */
  jobName?: string
  /** 过滤 status；不传 = 全部。 */
  status?: JobTraceStatusFilter
  /** 时间区间（ISO）；不传 = 不限。 */
  since?: string
  /** 默认 50，max 500。 */
  limit?: number
}

export interface JobTraceSummary {
  jobName: string
  runId: string
  status: JobTraceStatusFilter
  scheduledFor: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  leaderTerm: string | null
  /** 失败/超时时的 error.message（截断 200 字）；其他状态 null。 */
  errorMessage: string | null
}

export interface ListJobTracesResponse {
  traces: JobTraceSummary[]
  /** 是否还有更多（client decide 分页 / 拉更多）。 */
  hasMore: boolean
}

export function validateListJobTraces(query: unknown): ValidationResult<ListJobTracesQuery> {
  const q = (query ?? {}) as Record<string, unknown>
  const result: ListJobTracesQuery = {}

  const jobName = takeOptionalString(q.jobName)
  if (jobName !== undefined) {
    if (!/^[a-z0-9-]{1,64}$/i.test(jobName)) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `jobName must be alnum/dash (≤64), got ${jobName}`,
      }
    }
    result.jobName = jobName
  }

  const status = takeOptionalString(q.status)
  if (status !== undefined) {
    const allowed: JobTraceStatusFilter[] = [
      "ok",
      "failed",
      "timeout",
      "skipped_reentry",
      "skipped_not_leader",
      "missed_window",
      "recovered_from_crash",
      "lease_lost",
    ]
    if (!(allowed as string[]).includes(status)) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `status must be one of ${allowed.join(", ")}, got ${status}`,
      }
    }
    result.status = status as JobTraceStatusFilter
  }

  const since = takeOptionalString(q.since)
  if (since !== undefined) {
    if (Number.isNaN(Date.parse(since))) {
      return {
        ok: false,
        error: "VALIDATION_FAILED",
        message: `since must be ISO timestamp, got ${since}`,
      }
    }
    result.since = since
  }

  const limit = takeOptionalInt(q.limit, { min: 1, max: 500, field: "limit" })
  if (!limit.ok) return limit
  if (limit.value !== undefined) result.limit = limit.value

  return { ok: true, value: result }
}

// ── helper：失败 ValidationResult → ErrorResponseBody ────────────────

export function toErrorResponse<T>(
  fail: Extract<ValidationResult<T>, { ok: false }>,
): ErrorResponseBody {
  const body: ErrorResponseBody = { error: fail.error, message: fail.message }
  if (fail.detail !== undefined) body.detail = fail.detail
  return body
}
