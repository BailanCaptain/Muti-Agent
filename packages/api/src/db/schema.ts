import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core"

export const sessionGroups = sqliteTable("session_groups", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  projectTag: text("project_tag"),
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
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_threads_session_group_id").on(table.sessionGroupId),
  ],
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
  },
  (table) => [
    index("idx_messages_thread_id").on(table.threadId),
    index("idx_messages_created_at").on(table.createdAt),
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
})

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    invocationId: text("invocation_id")
      .notNull()
      .references(() => invocations.id),
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
  (table) => [
    index("idx_session_memories_session_group_id").on(table.sessionGroupId),
  ],
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
  (table) => [
    index("idx_tasks_session_group_id").on(table.sessionGroupId),
  ],
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
  (table) => [
    index("idx_authorization_rules_provider_thread").on(
      table.provider,
      table.threadId,
    ),
  ],
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
