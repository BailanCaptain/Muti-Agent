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
