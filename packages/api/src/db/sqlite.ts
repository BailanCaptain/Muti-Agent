import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Provider } from "@multi-agent/shared"

export type ProviderThreadRecord = {
  id: string
  sessionGroupId: string
  provider: Provider
  alias: string
  currentModel: string | null
  nativeSessionId: string | null
  sopBookmark: string | null
  lastFillRatio: number | null
  updatedAt: string
}

export type MessageType = "progress" | "final" | "a2a_handoff" | "connector"

export type ConnectorSourceRecord = {
  kind: "multi_mention_result"
  label: string
  initiator?: Provider
  targets: Provider[]
  fromAlias?: string
  toAlias?: string
}

export type MessageRecord = {
  id: string
  threadId: string
  role: "user" | "assistant"
  content: string
  thinking: string
  messageType: MessageType
  connectorSource: ConnectorSourceRecord | null
  groupId: string | null
  groupRole: "header" | "member" | "convergence" | null
  toolEvents: string
  contentBlocks: string
  createdAt: string
}

export type InvocationRecord = {
  id: string
  threadId: string
  agentId: string
  callbackToken: string
  status: string
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  lastActivityAt: string | null
}

export type AgentEventRecord = {
  id: string
  invocationId: string
  threadId: string
  agentId: string
  eventType: string
  payload: string
  createdAt: string
}

export type SessionMemoryRecord = {
  id: string
  sessionGroupId: string
  summary: string
  keywords: string
  createdAt: string
}

export class SqliteStore {
  readonly db: DatabaseSync

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec("PRAGMA busy_timeout = 5000;")
    this.db.exec("PRAGMA synchronous = NORMAL;")
    this.db.exec("PRAGMA cache_size = -64000;")
    this.db.exec("PRAGMA journal_size_limit = 67108864;")
    this.migrate()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_tag TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_group_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        alias TEXT NOT NULL,
        current_model TEXT,
        native_session_id TEXT,
        sop_bookmark TEXT,
        last_fill_ratio REAL,
        thread_memory TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_embeddings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        chunk_text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        thinking TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL DEFAULT 'final',
        connector_source TEXT,
        group_id TEXT,
        group_role TEXT,
        tool_events TEXT NOT NULL DEFAULT '[]',
        content_blocks TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invocations (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        callback_token TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        last_activity_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_memories (
        id TEXT PRIMARY KEY,
        session_group_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_group_id TEXT NOT NULL,
        assignee_agent_id TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'pending',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authorization_rules (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        action TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('thread', 'global')),
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
        thread_id TEXT,
        session_group_id TEXT,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'user',
        reason TEXT
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authorization_audit (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        provider TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'pending')),
        scope TEXT,
        matched_rule_id TEXT,
        created_at TEXT NOT NULL
      );
    `)

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
      CREATE INDEX IF NOT EXISTS idx_threads_session_group_id ON threads(session_group_id);
      CREATE INDEX IF NOT EXISTS idx_agent_events_invocation_id ON agent_events(invocation_id);
      CREATE INDEX IF NOT EXISTS idx_agent_events_thread_id ON agent_events(thread_id);
      CREATE INDEX IF NOT EXISTS idx_session_memories_session_group_id ON session_memories(session_group_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_group_id ON tasks(session_group_id);
      CREATE INDEX IF NOT EXISTS idx_authorization_rules_provider_thread ON authorization_rules(provider, thread_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_thread ON message_embeddings(thread_id);
    `)

    // F018 AC8.1: backfill thread_memory column on pre-F018 databases
    // CREATE TABLE IF NOT EXISTS 不会给现有表加列，因此单独走 idempotent ALTER
    try {
      this.db.exec("ALTER TABLE threads ADD COLUMN thread_memory TEXT")
    } catch (e) {
      if (!/duplicate column/i.test(String((e as Error).message))) throw e
    }
  }
}
