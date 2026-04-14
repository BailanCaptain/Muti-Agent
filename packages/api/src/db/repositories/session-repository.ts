import crypto from "node:crypto"
import type { Provider } from "@multi-agent/shared"
import { PROVIDERS, PROVIDER_ALIASES } from "@multi-agent/shared"
import { perfCollector } from "../../lib/perf-collector"
import type {
  AgentEventRecord,
  ConnectorSourceRecord,
  InvocationRecord,
  MessageRecord,
  MessageType,
  ProviderThreadRecord,
  SessionMemoryRecord,
  SqliteStore,
} from "../sqlite"

type MessageRow = {
  id: string
  threadId: string
  role: "user" | "assistant"
  content: string
  thinking: string
  messageType: MessageType
  connectorSource: string | null
  groupId: string | null
  groupRole: string | null
  toolEvents: string
  contentBlocks: string
  createdAt: string
}

function hydrateMessage(row: MessageRow): MessageRecord {
  return {
    ...row,
    connectorSource: row.connectorSource ? (JSON.parse(row.connectorSource) as ConnectorSourceRecord) : null,
    groupId: row.groupId ?? null,
    groupRole: (row.groupRole as MessageRecord["groupRole"]) ?? null,
    toolEvents: row.toolEvents ?? "[]",
    contentBlocks: row.contentBlocks ?? "[]",
  }
}

type SessionGroupRow = {
  id: string
  title: string
  projectTag: string | null
  createdAt: string
  updatedAt: string
}

type InvocationRow = {
  id: string
  threadId: string
  agentId: string
  callbackToken: string | null
  status: string
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  lastActivityAt: string | null
}

export class SessionRepository {
  constructor(private readonly store: SqliteStore) {}

  getSessionGroupById(groupId: string) {
    return this.store.db
      .prepare(
        `SELECT id, title, project_tag as projectTag, created_at as createdAt, updated_at as updatedAt
         FROM session_groups
         WHERE id = ?
         LIMIT 1`,
      )
      .get(groupId) as SessionGroupRow | undefined
  }

  listSessionGroups() {
    const t0 = performance.now()
    const rows = this.store.db
      .prepare(
        `SELECT
           sg.id, sg.title, sg.project_tag AS projectTag,
           sg.created_at AS createdAt, sg.updated_at AS updatedAt,
           t.provider, t.alias,
           (SELECT content FROM messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS lastMessage
         FROM session_groups sg
         LEFT JOIN threads t ON t.session_group_id = sg.id
         ORDER BY sg.updated_at DESC, t.provider ASC`,
      )
      .all() as Array<SessionGroupRow & { provider: string | null; alias: string | null; lastMessage: string | null }>
    const tQuery = performance.now()

    const groupMap = new Map<string, {
      id: string; title: string; projectTag: string | null
      createdAt: string; updatedAt: string
      previews: Array<{ provider: Provider; alias: string; text: string }>
    }>()

    for (const row of rows) {
      let group = groupMap.get(row.id)
      if (!group) {
        group = {
          id: row.id,
          title: row.title,
          projectTag: row.projectTag ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          previews: [],
        }
        groupMap.set(row.id, group)
      }
      if (row.provider) {
        group.previews.push({
          provider: row.provider as Provider,
          alias: row.alias!,
          text: (row.lastMessage ?? "").slice(0, 80),
        })
      }
    }

    const result = Array.from(groupMap.values())
    const total = performance.now() - t0
    console.log(`[perf] listSessionGroups: ${result.length} groups, query=${(tQuery - t0).toFixed(1)}ms assemble=${(total - (tQuery - t0)).toFixed(1)}ms total=${total.toFixed(1)}ms`)
    perfCollector.record("listSessionGroups", total)
    perfCollector.record("listSessionGroups.query", tQuery - t0)
    perfCollector.record("listSessionGroups.assemble", total - (tQuery - t0))
    return result
  }

  createSessionGroup(title?: string) {
    const now = new Date().toISOString()
    const sessionGroupId = crypto.randomUUID()

    this.store.db
      .prepare(
        `INSERT INTO session_groups (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionGroupId, title ?? `新会话 ${now.slice(0, 19).replace("T", " ")}`, now, now)

    return sessionGroupId
  }

  updateSessionGroupProjectTag(groupId: string, tag: string | null) {
    this.store.db
      .prepare("UPDATE session_groups SET project_tag = ? WHERE id = ?")
      .run(tag, groupId)
  }

  createThread(sessionGroupId: string, provider: Provider, currentModel: string | null) {
    const now = new Date().toISOString()
    const threadId = crypto.randomUUID()

    this.store.db
      .prepare(
        `INSERT INTO threads (id, session_group_id, provider, alias, current_model, native_session_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, sessionGroupId, provider, PROVIDER_ALIASES[provider], currentModel, null, now)

    return threadId
  }

  ensureDefaultThreads(sessionGroupId: string, defaults: Record<Provider, string | null>) {
    for (const provider of PROVIDERS) {
      const existing = this.store.db
        .prepare("SELECT id FROM threads WHERE session_group_id = ? AND provider = ? LIMIT 1")
        .get(sessionGroupId, provider) as { id: string } | undefined

      if (!existing) {
        this.createThread(sessionGroupId, provider, defaults[provider])
      }
    }
  }

  listThreadsByGroup(sessionGroupId: string) {
    return this.store.db
      .prepare(
        `SELECT id, session_group_id as sessionGroupId, provider, alias, current_model as currentModel,
                native_session_id as nativeSessionId, sop_bookmark as sopBookmark,
                last_fill_ratio as lastFillRatio, updated_at as updatedAt
         FROM threads
         WHERE session_group_id = ?
         ORDER BY provider ASC`,
      )
      .all(sessionGroupId) as ProviderThreadRecord[]
  }

  getThreadById(threadId: string) {
    return this.store.db
      .prepare(
        `SELECT id, session_group_id as sessionGroupId, provider, alias, current_model as currentModel,
                native_session_id as nativeSessionId, sop_bookmark as sopBookmark,
                last_fill_ratio as lastFillRatio, updated_at as updatedAt
         FROM threads
         WHERE id = ?
         LIMIT 1`,
      )
      .get(threadId) as ProviderThreadRecord | undefined
  }

  listMessages(threadId: string) {
    const t0 = performance.now()
    const rows = this.store.db
      .prepare(
        `SELECT id, thread_id as threadId, role, content, thinking, message_type as messageType, connector_source as connectorSource, group_id as groupId, group_role as groupRole, tool_events as toolEvents, content_blocks as contentBlocks, created_at as createdAt
         FROM messages
         WHERE thread_id = ?
         ORDER BY created_at ASC`,
      )
      .all(threadId) as MessageRow[]
    const result = rows.map(hydrateMessage)
    const elapsed = performance.now() - t0
    console.log(`[perf] listMessages(${threadId.slice(0, 8)}): ${rows.length} rows, ${elapsed.toFixed(1)}ms`)
    perfCollector.record("listMessages", elapsed)
    return result
  }

  listMessagesSince(threadId: string, sinceTimestamp: string) {
    return (
      this.store.db
        .prepare(
          `SELECT id, thread_id as threadId, role, content, thinking, message_type as messageType, connector_source as connectorSource, group_id as groupId, group_role as groupRole, tool_events as toolEvents, content_blocks as contentBlocks, created_at as createdAt
         FROM messages
         WHERE thread_id = ? AND created_at > ?
         ORDER BY created_at ASC`,
        )
        .all(threadId, sinceTimestamp) as MessageRow[]
    ).map(hydrateMessage)
  }

  listRecentMessages(threadId: string, limit: number) {
    const rows = this.store.db
      .prepare(
        `SELECT id, thread_id as threadId, role, content, thinking, message_type as messageType, connector_source as connectorSource, group_id as groupId, group_role as groupRole, tool_events as toolEvents, content_blocks as contentBlocks, created_at as createdAt
         FROM messages
         WHERE thread_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(threadId, limit) as MessageRow[]
    return rows.map(hydrateMessage)
  }

  appendMessage(
    threadId: string,
    role: "user" | "assistant",
    content: string,
    thinking = "",
    messageType: MessageType = "final",
    connectorSource: ConnectorSourceRecord | null = null,
    groupId: string | null = null,
    groupRole: MessageRecord["groupRole"] = null,
    toolEvents = "[]",
    contentBlocks = "[]",
  ) {
    const message: MessageRecord = {
      id: crypto.randomUUID(),
      threadId,
      role,
      content,
      thinking,
      messageType,
      connectorSource,
      groupId,
      groupRole,
      toolEvents,
      contentBlocks,
      createdAt: new Date().toISOString(),
    }

    this.store.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, thinking, message_type, connector_source, group_id, group_role, tool_events, content_blocks, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.threadId,
        message.role,
        message.content,
        message.thinking,
        message.messageType,
        connectorSource ? JSON.stringify(connectorSource) : null,
        message.groupId,
        message.groupRole,
        message.toolEvents,
        message.contentBlocks,
        message.createdAt,
      )

    this.touchThread(threadId, message.createdAt)
    return message
  }

  overwriteMessage(messageId: string, updates: { content?: string; thinking?: string; toolEvents?: string }) {
    const current = this.store.db
      .prepare("SELECT content, thinking, tool_events as toolEvents FROM messages WHERE id = ? LIMIT 1")
      .get(messageId) as { content: string; thinking: string; toolEvents: string } | undefined

    if (!current) {
      return
    }

    this.store.db
      .prepare("UPDATE messages SET content = ?, thinking = ?, tool_events = ? WHERE id = ?")
      .run(updates.content ?? current.content, updates.thinking ?? current.thinking, updates.toolEvents ?? current.toolEvents, messageId)
  }

  createInvocation(record: InvocationRecord) {
    this.store.db
      .prepare(
        `INSERT INTO invocations (id, thread_id, agent_id, callback_token, status, started_at, finished_at, exit_code, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.threadId,
        record.agentId,
        record.callbackToken,
        record.status,
        record.startedAt,
        record.finishedAt,
        record.exitCode,
        record.lastActivityAt,
      )
  }

  getInvocationById(invocationId: string) {
    return this.store.db
      .prepare(
        `SELECT id,
                thread_id as threadId,
                agent_id as agentId,
                callback_token as callbackToken,
                status,
                started_at as startedAt,
                finished_at as finishedAt,
                exit_code as exitCode,
                last_activity_at as lastActivityAt
         FROM invocations
         WHERE id = ?
         LIMIT 1`,
      )
      .get(invocationId) as InvocationRow | undefined
  }

  getInvocationByCredentials(invocationId: string, callbackToken: string) {
    return this.store.db
      .prepare(
        `SELECT id,
                thread_id as threadId,
                agent_id as agentId,
                callback_token as callbackToken,
                status,
                started_at as startedAt,
                finished_at as finishedAt,
                exit_code as exitCode,
                last_activity_at as lastActivityAt
         FROM invocations
         WHERE id = ?
           AND callback_token = ?
         LIMIT 1`,
      )
      .get(invocationId, callbackToken) as InvocationRow | undefined
  }

  updateInvocation(
    invocationId: string,
    updates: {
      status?: string
      finishedAt?: string | null
      exitCode?: number | null
      lastActivityAt?: string | null
    },
  ) {
    const current = this.getInvocationById(invocationId)
    if (!current) {
      return
    }

    this.store.db
      .prepare(
        `UPDATE invocations
         SET status = ?, finished_at = ?, exit_code = ?, last_activity_at = ?
         WHERE id = ?`,
      )
      .run(
        updates.status ?? current.status,
        updates.finishedAt ?? current.finishedAt,
        updates.exitCode ?? current.exitCode,
        updates.lastActivityAt ?? current.lastActivityAt,
        invocationId,
      )
  }

  appendAgentEvent(record: AgentEventRecord) {
    this.store.db
      .prepare(
        `INSERT INTO agent_events (id, invocation_id, thread_id, agent_id, event_type, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.invocationId,
        record.threadId,
        record.agentId,
        record.eventType,
        record.payload,
        record.createdAt,
      )
  }

  updateThread(
    threadId: string,
    updates: { currentModel?: string | null; nativeSessionId?: string | null; sopBookmark?: string | null; lastFillRatio?: number | null },
  ) {
    const setClauses: string[] = []
    const params: (string | number | null)[] = []

    if ("currentModel" in updates) {
      setClauses.push("current_model = ?")
      params.push(updates.currentModel ?? null)
    }
    if ("nativeSessionId" in updates) {
      setClauses.push("native_session_id = ?")
      params.push(updates.nativeSessionId ?? null)
    }
    if ("sopBookmark" in updates) {
      setClauses.push("sop_bookmark = ?")
      params.push(updates.sopBookmark ?? null)
    }
    if ("lastFillRatio" in updates) {
      setClauses.push("last_fill_ratio = ?")
      params.push(updates.lastFillRatio ?? null)
    }

    if (setClauses.length === 0) return

    const updatedAt = new Date().toISOString()
    setClauses.push("updated_at = ?")
    params.push(updatedAt, threadId)

    this.store.db
      .prepare(`UPDATE threads SET ${setClauses.join(", ")} WHERE id = ?`)
      .run(...params)

    this.touchThread(threadId, updatedAt)
  }

  reconcileLegacyDefaultModels(
    replacements: Record<Provider, { from: string[]; to: string | null }>,
  ) {
    const updatedAt = new Date().toISOString()

    for (const provider of PROVIDERS) {
      const replacement = replacements[provider]
      if (!replacement?.to || !replacement.from.length) {
        continue
      }

      const placeholders = replacement.from.map(() => "?").join(", ")
      this.store.db
        .prepare(
          `UPDATE threads
           SET current_model = ?, updated_at = ?
           WHERE provider = ?
             AND current_model IN (${placeholders})`,
        )
        .run(replacement.to, updatedAt, provider, ...replacement.from)
    }
  }

  private touchThread(threadId: string, updatedAt: string) {
    this.store.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(updatedAt, threadId)

    const row = this.store.db
      .prepare("SELECT session_group_id as sessionGroupId FROM threads WHERE id = ? LIMIT 1")
      .get(threadId) as { sessionGroupId: string } | undefined

    if (row) {
      this.store.db
        .prepare("UPDATE session_groups SET updated_at = ? WHERE id = ?")
        .run(updatedAt, row.sessionGroupId)
    }
  }

  createMemory(sessionGroupId: string, summary: string, keywords: string): SessionMemoryRecord {
    const record: SessionMemoryRecord = {
      id: crypto.randomUUID(),
      sessionGroupId,
      summary,
      keywords,
      createdAt: new Date().toISOString(),
    }

    this.store.db
      .prepare(
        `INSERT INTO session_memories (id, session_group_id, summary, keywords, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.sessionGroupId, record.summary, record.keywords, record.createdAt)

    return record
  }

  listMemories(sessionGroupId: string): SessionMemoryRecord[] {
    return this.store.db
      .prepare(
        `SELECT id, session_group_id as sessionGroupId, summary, keywords, created_at as createdAt
         FROM session_memories
         WHERE session_group_id = ?
         ORDER BY created_at DESC`,
      )
      .all(sessionGroupId) as SessionMemoryRecord[]
  }

  searchMemories(keyword: string): SessionMemoryRecord[] {
    const pattern = `%${keyword}%`
    return this.store.db
      .prepare(
        `SELECT id, session_group_id as sessionGroupId, summary, keywords, created_at as createdAt
         FROM session_memories
         WHERE keywords LIKE ? OR summary LIKE ?
         ORDER BY created_at DESC`,
      )
      .all(pattern, pattern) as SessionMemoryRecord[]
  }

  getLatestMemory(sessionGroupId: string): SessionMemoryRecord | null {
    const row = this.store.db
      .prepare(
        `SELECT id, session_group_id as sessionGroupId, summary, keywords, created_at as createdAt
         FROM session_memories
         WHERE session_group_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(sessionGroupId) as SessionMemoryRecord | undefined

    return row ?? null
  }

  createTask(sessionGroupId: string, assignee: string, description: string, createdBy: string, priority = "medium") {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.store.db
      .prepare(
        `INSERT INTO tasks (id, session_group_id, assignee_agent_id, description, priority, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, sessionGroupId, assignee, description, priority, createdBy, now, now)
    return { id, sessionGroupId, assignee, description, priority, status: "pending" as const, createdBy, createdAt: now }
  }

  private getLastMessagePreview(threadId: string) {
    const row = this.store.db
      .prepare(
        `SELECT content
         FROM messages
         WHERE thread_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(threadId) as { content: string } | undefined

    return row?.content.slice(0, 80) ?? ""
  }
}
