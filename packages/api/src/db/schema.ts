import { blob, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const sessionGroups = sqliteTable("session_groups", {
  id: text("id").primaryKey(),
  roomId: text("room_id").unique(),
  title: text("title").notNull(),
  projectTag: text("project_tag"),
  // F021: per-session runtime config override (JSON stringified).
  runtimeConfig: text("runtime_config"),
  // F022 Phase 3.5: 手动命名锁（AC-14g）
  titleLockedAt: text("title_locked_at"),
  // F022 Phase 3.5: 归档 / 软删（AC-14i/j）
  archivedAt: text("archived_at"),
  deletedAt: text("deleted_at"),
  // F022 Phase 3.5 (review P1-2): Haiku 命名失败计数
  titleBackfillAttempts: integer("title_backfill_attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    sessionGroupId: text("session_group_id")
      .notNull()
      .references(() => sessionGroups.id),
    provider: text("provider").notNull(),
    alias: text("alias").notNull(),
    currentModel: text("current_model"),
    nativeSessionId: text("native_session_id"),
    sopBookmark: text("sop_bookmark"),
    lastFillRatio: real("last_fill_ratio"),
    // F018: ThreadMemory rolling summary + session chain index
    threadMemory: text("thread_memory"),
    sessionChainIndex: integer("session_chain_index").notNull().default(1),
    // F019: thread → feature binding for WorkflowSop state machine.
    // Null = thread not bound to any feature (sopStageHint will not be injected).
    backlogItemId: text("backlog_item_id"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_threads_session_group_id").on(table.sessionGroupId)],
)

export const messageEmbeddings = sqliteTable(
  "message_embeddings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id").notNull(),
    chunkIndex: integer("chunk_index").notNull().default(0),
    chunkText: text("chunk_text").notNull(),
    embedding: blob("embedding").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_embeddings_thread").on(table.threadId)],
)

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    thinking: text("thinking").notNull().default(""),
    messageType: text("message_type").notNull().default("final"),
    connectorSource: text("connector_source"),
    groupId: text("group_id"),
    groupRole: text("group_role"),
    toolEvents: text("tool_events").notNull().default("[]"),
    contentBlocks: text("content_blocks").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    // F021 Phase 5: resolved per-message model snapshot for chat bubble pill.
    model: text("model"),
    // F026 P3.1: assistant final 派发协议 retry 兜底层
    // retry_count = 实际重写次数（0 = 一次过 / 1-2 = 重写后合规 / 3 = 耗尽兜底入库）
    // retry_reasons = JSON array of reason strings，按 attempt 顺序追加
    retryCount: integer("retry_count").notNull().default(0),
    retryReasons: text("retry_reasons").notNull().default("[]"),
    // F026 P5 T0 · 关联到 a2a_calls 表的协议字段（onBehalfOf / parentCallId / displayMode 等）。
    // 仅 a2a 派发产生的 connector message 写入；普通 message 为 null。前端 LEFT JOIN 取协议字段。
    a2aCallId: text("a2a_call_id"),
  },
  (table) => [
    index("idx_messages_thread_id").on(table.threadId),
    index("idx_messages_created_at").on(table.createdAt),
    index("idx_messages_a2a_call_id").on(table.a2aCallId),
  ],
)

export const invocations = sqliteTable("invocations", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id),
  agentId: text("agent_id").notNull(),
  callbackToken: text("callback_token"),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  exitCode: integer("exit_code"),
  lastActivityAt: text("last_activity_at"),
  // F021 Phase 3.3: frozen per-provider model/effort snapshot captured at
  // invocation start (pending flushed into active). JSON stringified. Null =
  // legacy row (pre-F021) or no override active at start.
  configSnapshot: text("config_snapshot"),
})

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    // F026 P5 T4 · invocation_id 改 nullable（Phase 5 schema migration）：
    //   DiscussionCoordinator / mention-router gray-zone 这类系统级事件没有归属
    //   invocation，需要 NULL 才能持久化。runRebuildMigrations 负责把老 DB 升级。
    invocationId: text("invocation_id").references(() => invocations.id),
    threadId: text("thread_id").notNull(),
    agentId: text("agent_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_agent_events_invocation_id").on(table.invocationId),
    index("idx_agent_events_thread_id").on(table.threadId),
  ],
)

export const sessionMemories = sqliteTable(
  "session_memories",
  {
    id: text("id").primaryKey(),
    sessionGroupId: text("session_group_id")
      .notNull()
      .references(() => sessionGroups.id),
    summary: text("summary").notNull(),
    keywords: text("keywords").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_session_memories_session_group_id").on(table.sessionGroupId)],
)

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    sessionGroupId: text("session_group_id")
      .notNull()
      .references(() => sessionGroups.id),
    assigneeAgentId: text("assignee_agent_id").notNull(),
    description: text("description").notNull(),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("pending"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("idx_tasks_session_group_id").on(table.sessionGroupId)],
)

export const authorizationRules = sqliteTable(
  "authorization_rules",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    action: text("action").notNull(),
    scope: text("scope").notNull(),
    decision: text("decision").notNull(),
    threadId: text("thread_id"),
    sessionGroupId: text("session_group_id"),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull().default("user"),
    reason: text("reason"),
  },
  (table) => [index("idx_authorization_rules_provider_thread").on(table.provider, table.threadId)],
)

export const authorizationAudit = sqliteTable("authorization_audit", {
  id: text("id").primaryKey(),
  requestId: text("request_id"),
  provider: text("provider").notNull(),
  threadId: text("thread_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  decision: text("decision").notNull(),
  scope: text("scope"),
  matchedRuleId: text("matched_rule_id"),
  createdAt: text("created_at").notNull(),
})

// F019: WorkflowSop state machine — 告示牌引擎
// stage enum is stored as TEXT (not constrained by DB CHECK) so we can evolve
// the stage vocabulary without a migration; WorkflowSopService enforces valid values.
// resumeCapsule and checks are JSON blobs (stringified at repo boundary).
export const workflowSop = sqliteTable(
  "workflow_sop",
  {
    backlogItemId: text("backlog_item_id").primaryKey(),
    featureId: text("feature_id").notNull(),
    stage: text("stage").notNull(),
    batonHolder: text("baton_holder"),
    nextSkill: text("next_skill"),
    resumeCapsule: text("resume_capsule").notNull().default("{}"),
    checks: text("checks").notNull().default("{}"),
    version: integer("version").notNull().default(1),
    updatedAt: text("updated_at").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    index("idx_workflow_sop_feature_id").on(table.featureId),
    index("idx_workflow_sop_stage").on(table.stage),
  ],
)

// F026 ADR-002 Call Tree 协议真相源 — Round 2 Phase 1 地基
// 协议字段对应 EnvelopeProtocolV1 (packages/shared/src/a2a-envelope.ts)
// status state machine: pending → working → {done | failed | timeout | cancelled}
export const a2aCalls = sqliteTable(
  "a2a_calls",
  {
    callId: text("call_id").primaryKey(),
    parentCallId: text("parent_call_id"),
    rootCallId: text("root_call_id").notNull(),
    issuerId: text("issuer_id").notNull(),
    convenerId: text("convener_id").notNull(),
    onBehalfOf: text("on_behalf_of"),
    replyTo: text("reply_to").notNull(),
    deadlineAt: text("deadline_at").notNull(),
    joinSetId: text("join_set_id"),
    status: text("status").notNull(),
    envelopeVersion: text("envelope_version").notNull().default("v1"),
    sessionGroupId: text("session_group_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_a2a_calls_parent").on(table.parentCallId),
    index("idx_a2a_calls_root").on(table.rootCallId),
    index("idx_a2a_calls_status_deadline").on(table.status, table.deadlineAt),
    index("idx_a2a_calls_session_group").on(table.sessionGroupId),
  ],
)

// F026 P2 clean-cut Step 3 · parallel_groups schema 已删除（ParallelGroupRegistry
// 整删，drizzle 不再声明）。老 DB 残留死表 ignored。

// F027 P0 · 统一记忆架构 4 张地基表 —— V16.5-final.md chap 5 / 11 / 14 / 18。
// 设计原则：
//   1. 风格沿用 F011（drizzle-orm + 索引按查询模式建 + 不在 schema 加 CHECK，
//      enum 由 application 层强约束；wiki_memories.type 例外，CHECK 入 INIT_SQL
//      因为防漂桶 lint 必须 DB 强约束）。
//   2. 每表预留 reserved_1 / reserved_2 TEXT NULL —— V16.5.3 风险卡：schema
//      改动期 Phase 1 全程，遇到字段缺口时不必走 ALTER 风险路径。
//   3. 时间戳走 TEXT ISO-8601 —— 与 F011 全表统一，不混 INTEGER。
//   4. JSON 类字段写 stringify 后入库（与 F019 workflowSop / F021 toolEvents
//      约定一致），repo 层 boundary 解析。

// F027 chap 5 · wiki entity 单一提交事件源（PREPARE/WRITE/COMMIT 三阶段）。
// state='committed' 行才进 compiler 重放；'pending' 行启动时由 reconciler 扫。
// CAS：base_hash → content_hash；fencing_token + leader_term 防 split-brain。
export const wikiEvents = sqliteTable(
  "wiki_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    alias: text("alias").notNull(),
    action: text("action").notNull(), // write|append|patch|ingest|promote|demote|delete|recall_escalate (F027 P20 Day 9 c)
    path: text("path").notNull(),
    baseHash: text("base_hash"),
    contentHash: text("content_hash"),
    attemptedHash: text("attempted_hash"),
    diffSummary: text("diff_summary"),
    sourceMessageIds: text("source_message_ids"), // JSON array
    promotionTarget: text("promotion_target"),
    reason: text("reason"),
    fencingToken: text("fencing_token").notNull(),
    leaderTerm: text("leader_term").notNull(),
    result: text("result").notNull(), // ok|conflict|denied_acl|lease_expired|schema_invalid|stale_token|leader_changed
    error: text("error"),
    state: text("state").notNull().default("pending"), // pending|committed|aborted
    resultManifestVersion: text("result_manifest_version"),
    reserved1: text("reserved_1"),
    reserved2: text("reserved_2"),
  },
  (table) => [
    index("idx_wiki_events_path").on(table.path, table.ts),
    index("idx_wiki_events_alias").on(table.alias, table.ts),
    index("idx_wiki_events_state").on(table.state, table.ts),
    index("idx_wiki_events_term").on(table.leaderTerm),
  ],
)

// F027 chap 14 · 6 类记忆桶物理表（5 类：room/project/user/feedback/work；
// conversation 桶物理上由 messages 表承载，不冗余）。
// type CHECK 由 INIT_SQL 强约束（防漂桶 lint 写错 type 也兜得住）。
export const wikiMemories = sqliteTable(
  "wiki_memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(), // room|project|user|feedback|work（CHECK in INIT_SQL）
    name: text("name").notNull(),
    canonicalOwnerPath: text("canonical_owner_path").notNull(),
    promotionTarget: text("promotion_target"),
    ttlDays: integer("ttl_days"),
    supersedes: text("supersedes"), // JSON array of paths
    replacesInBuckets: text("replaces_in_buckets"), // JSON array
    sourceMessageIds: text("source_message_ids"), // JSON array
    contributedBy: text("contributed_by").notNull(), // JSON array of aliases
    crossRefs: text("cross_refs"), // JSON array (V16.4 chap 26 LLM 编译填)
    dedupDecision: text("dedup_decision"), // JSON object
    body: text("body").notNull(),
    state: text("state").notNull().default("draft"), // draft|canonical|deprecated
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    reserved1: text("reserved_1"),
    reserved2: text("reserved_2"),
  },
  (table) => [
    index("idx_wiki_memories_type").on(table.type),
    index("idx_wiki_memories_canonical").on(table.canonicalOwnerPath),
    index("idx_wiki_memories_state").on(table.state, table.type),
  ],
)

// F027 chap 11 · viewfinder anti-drift decision ledger（append-only）。
// tombstone=1 + superseded_by 软删覆盖，原文不动；MonthlySnapshot 比对漂移。
// P4 (小孙 2026-05-13 拍 C-auto-2): status 字段标 'active'/'completed'/'superseded'，
//   extractor LLM 判定新 commit 决策时同步 sweep 旧 active commit
//   （viewfinder §3 "下一步"只取 active 的，避免"进 merger-gate" 已完成还显示成下一步）
export const roomDecisions = sqliteTable(
  "room_decisions",
  {
    decisionId: integer("decision_id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id").notNull(),
    decidedAt: text("decided_at").notNull(),
    decidedBy: text("decided_by").notNull(), // alias
    decisionType: text("decision_type").notNull(), // pivot|spec|reject|commit
    content: text("content").notNull(),
    sourceMessageIds: text("source_message_ids").notNull(), // JSON array
    sourceQuote: text("source_quote").notNull(),
    sourceHash: text("source_hash").notNull(), // sha256
    tombstone: integer("tombstone").notNull().default(0),
    supersededBy: integer("superseded_by"),
    fencingToken: text("fencing_token").notNull(),
    extractorConfidence: real("extractor_confidence"),
    coverageCheckPassed: integer("coverage_check_passed"), // 0/1
    // P4 C-auto-2: viewfinder §3 过滤 + extractor sweep 用
    status: text("status").notNull().default("active"), // active|completed|superseded
    reserved1: text("reserved_1"),
    reserved2: text("reserved_2"),
  },
  (table) => [
    index("idx_room_decisions").on(table.roomId, table.decidedAt),
    // P4: §3 SQL `WHERE decision_type='commit' AND status='active'` 高频查询用
    index("idx_room_decisions_status_type").on(table.roomId, table.decisionType, table.status),
  ],
)

// F027 chap 18 · prompt 拼装审计（assembler 每次拼装同步写一条）。
// V15.1+V15.2 加固字段（recall_* / top_score / escalate_reason）一次性入表，
// Phase 1 P11 memory_preflight + P13 Adaptive Recall 直接落库不再 ALTER。
export const promptAudit = sqliteTable(
  "prompt_audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at").notNull(),
    alias: text("alias").notNull(),
    roomId: text("room_id"),
    scenario: text("scenario").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    cap: integer("cap").notNull(),
    partsJson: text("parts_json").notNull(),
    notInjectedJson: text("not_injected_json"),
    ironLawsCount: integer("iron_laws_count").notNull(),
    rawText: text("raw_text").notNull(),
    sourceEventIds: text("source_event_ids"),
    // V15.1 召回字段
    recallQueries: text("recall_queries"), // JSON: 2-5 query
    recallResults: text("recall_results"), // JSON: hits
    recallTotalTokens: integer("recall_total_tokens"),
    recallRejectedReasons: text("recall_rejected_reasons"), // JSON: reject 原因
    // V15.2 Adaptive Recall 5 级 + Hard Gate
    recallRequired: integer("recall_required").notNull().default(0),
    recallTrigger: text("recall_trigger"),
    recallPath: integer("recall_path"), // 1-5
    topScore: real("top_score"),
    recallSatisfied: integer("recall_satisfied").notNull().default(0),
    escalateReason: text("escalate_reason"),
    recallTotalMs: integer("recall_total_ms"),
    recallCritiqueCalls: integer("recall_critique_calls"),
    recallBudgetExceeded: integer("recall_budget_exceeded"),
    agentSessionRef: text("agent_session_ref"),
    reserved1: text("reserved_1"),
    reserved2: text("reserved_2"),
  },
  (table) => [index("idx_prompt_audit").on(table.alias, table.roomId, table.createdAt)],
)

// F027 chap 6 · update_wiki MCP 写入流程的 lease 表（path 维度互斥锁）。
// path 单 PK：同一时刻一个 path 只允许一个未过期 lease。
// fencing_token 是 wiki_fencing_seq 单调 bigint，写入时 final-CAS 二次校验用。
// leader_term 来自 compiler_leader.current_term（chap 5 Compiler Leader Lease），
// P3.5 加 DB 触发器拒绝 leader_term 旧的写入。
export const wikiLeases = sqliteTable(
  "wiki_leases",
  {
    path: text("path").primaryKey(),
    fencingToken: text("fencing_token").notNull(),
    ownerAlias: text("owner_alias").notNull(),
    acquiredAt: text("acquired_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    leaderTerm: text("leader_term").notNull(),
    reserved1: text("reserved_1"),
    reserved2: text("reserved_2"),
  },
  (table) => [index("idx_wiki_leases_expires").on(table.expiresAt)],
)

// F027 chap 6 · 单调 bigint fencing token 序列（single-row sequence 表）。
// next_value 用 UPDATE ... SET v=v+1 RETURNING 原子推进；TEXT 存避免 32-bit overflow。
export const wikiFencingSeq = sqliteTable("wiki_fencing_seq", {
  id: integer("id").primaryKey(), // 强制 = 1（CHECK 在 INIT_SQL 里）
  nextValue: text("next_value").notNull(), // bigint as decimal string
})

// F027 P3.5 chap 5 · Compiler Leader Lease（防 split-brain）—— 全局唯一 leader。
// 单 row CHECK(id=1)；候选 compiler 启动时 acquireLeader（INSERT OR FAIL / UPDATE
// WHERE expired）；每 10s 续约；续约失败 → leader 主动 abort + 释放。
// 所有 leader 写入 wiki_events 必须携带 current_term；触发器 reject_stale_leader
// BEFORE INSERT 拒绝 leader_term < current_term 的写。
export const compilerLeader = sqliteTable("compiler_leader", {
  id: integer("id").primaryKey(), // CHECK (id = 1) in INIT_SQL
  currentTerm: text("current_term").notNull(), // bigint as decimal string，单调推进
  leaderAlias: text("leader_alias").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  renewedAt: text("renewed_at").notNull(),
  leaseExpiresAt: text("lease_expires_at").notNull(),
  reserved1: text("reserved_1"),
  reserved2: text("reserved_2"),
})

// F027 P7 chap 8 · RoomCompiler 二阶段提交 checkpoint（每 room 一行）。
// committed_at IS NULL = PREPARE 阶段未完，SessionBootstrap 不读；reconciler 扫该集合修。
// cursor_commit_seq = message_commit_seq.seq 单调推进；sealed_cursor_seq 独立 cursor
// 防 V16 chap 8 "sealed 但无 message → tick 漏" 漏洞。
export const roomCheckpoints = sqliteTable("room_checkpoints", {
  roomId: text("room_id").primaryKey(),
  cursorCommitSeq: integer("cursor_commit_seq").notNull(),
  cursorMessageId: text("cursor_message_id").notNull(),
  sealedCursorSeq: integer("sealed_cursor_seq").notNull(),
  viewfinderHash: text("viewfinder_hash").notNull(),
  decisionsHash: text("decisions_hash").notNull(),
  logHash: text("log_hash").notNull(),
  threadSealId: text("thread_seal_id"),
  compiledAt: text("compiled_at").notNull(),
  committedAt: text("committed_at"), // null = prepare 阶段未完
  fencingToken: text("fencing_token").notNull(),
  leaderTerm: text("leader_term").notNull(),
  reserved1: text("reserved_1"),
  reserved2: text("reserved_2"),
})

// F027 P7 chap 8 · message commit 单调序列（F004 message-service 同事务 INSERT）。
// 用 seq 而非 created_at 推进 cursor —— created_at 同毫秒可碰撞，seq 严格单调。
export const messageCommitSeq = sqliteTable("message_commit_seq", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  messageId: text("message_id").notNull().unique(),
  committedAt: text("committed_at").notNull(),
})

// F027 P7 chap 8 · thread seal 独立事件流（F018 seal 同事务 INSERT）。
// compiler 用 sealed_cursor_seq 单独 watch，"sealed_at 变但无新 message" 也能触发。
export const threadSealEvents = sqliteTable("thread_seal_events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  threadId: text("thread_id").notNull(),
  roomId: text("room_id").notNull(),
  sealedAt: text("sealed_at").notNull(),
  fencingToken: text("fencing_token").notNull(),
})

// F027 P8 chap 9 · per-agent S-XXXX.md ledger（room × alias × session_seq）。
// session_seq per-(room, alias) 单调；UNIQUE 防同号重复写。
// open_threads / closed_threads / sources 走 JSON 序列化（boundary 解析）。
// canonical_owner_path 永远是 wiki/rooms/<roomId>/agent-sessions/<alias>/S-<seq>.md，
// LLM 编译只读 row（防漂桶 lint 兜底）。
// F027 P14.a · wiki entity FTS5 索引基表
// 真相源：docs/plans/V16.5-final.md chap 21 P14 + chap 22 行 2407 "FTS5 触发器同步"
//
// wiki entity 本体是文件（wiki/<bucket>/<name>.md），不是表行。indexer 扫文件
// 落入本表（path = canonical key，indexed_at + source_hash 防漂移）。
// FTS5 虚拟表 wiki_entity_fts 用 content=wiki_entity_index 关联，通过 trigger
// 自动同步 INSERT/UPDATE/DELETE（见 drizzle-instance.ts INIT_SQL）。
//
// 不存 wiki_memories 的 metadata（state/promotion_target/...）—— 那些走 P10
// wikiMemories 表。本表只为 BM25 / FTS5 全文召回服务。
export const wikiEntityIndex = sqliteTable(
  "wiki_entity_index",
  {
    /** 相对 wiki root 路径（如 wiki/concepts/F011-backend-hardening-drizzle.md） */
    path: text("path").primaryKey(),
    /** bucket（concepts / memories / agents / bugReport / archive / ...） */
    bucket: text("bucket").notNull(),
    /** 文件名去后缀（F011-backend-hardening-drizzle） */
    name: text("name").notNull(),
    /** 文件 body 全文（snapshot；indexer reindex 时整 body 覆写） */
    body: text("body").notNull(),
    /** sha256(body)；indexer 增量判定 / 防漂移核验 */
    sourceHash: text("source_hash").notNull(),
    /** 文件 mtime（毫秒）；indexer 跳过未变文件用 */
    mtimeMs: integer("mtime_ms").notNull(),
    /** 入库时间 ISO（debug + audit） */
    indexedAt: text("indexed_at").notNull(),
  },
  (table) => [
    // 按 bucket 过滤（caller 想限 scope='concepts' 时用）
    index("idx_wiki_entity_index_bucket").on(table.bucket),
  ],
)

export const roomAgentSessions = sqliteTable(
  "room_agent_sessions",
  {
    sessionId: integer("session_id").primaryKey({ autoIncrement: true }),
    roomId: text("room_id").notNull(),
    alias: text("alias").notNull(),
    sessionSeq: integer("session_seq").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    entryReason: text("entry_reason").notNull(),
    exitReason: text("exit_reason"),
    lastSeenCommitSeq: integer("last_seen_commit_seq"),
    openThreads: text("open_threads"), // JSON array of {text, a2a_call_id?}
    closedThreads: text("closed_threads"), // JSON array of string
    privateNotesHash: text("private_notes_hash"),
    sessionDigest: text("session_digest"), // 200-300 tok 摘要
    /** Archive 标记：被 yearly pack 合并后 archived='Y'，主索引不再返回 active 行。 */
    archived: text("archived").notNull().default("N"), // 'Y' | 'N'
    archivedAt: text("archived_at"),
    archivedYear: integer("archived_year"),
    reserved1: text("reserved_1"),
    reserved2: text("reserved_2"),
  },
  (table) => [
    // chap 9 行 1002 主查询（per-room+alias 倒序）
    index("idx_room_agent_sessions").on(table.roomId, table.alias, table.sessionSeq),
    // archived='N' 过滤 + room/alias 维度（current.md 派生 + 100k sharding active 查询）
    index("idx_room_agent_sessions_active").on(table.archived, table.roomId, table.alias),
  ],
)
