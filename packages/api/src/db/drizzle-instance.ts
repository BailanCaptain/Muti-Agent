import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { drizzle } from "drizzle-orm/better-sqlite3"
import * as schema from "./schema"

function createStatementAdapter(db: DatabaseSync, sql: string) {
  const stmt = db.prepare(sql)
  let rawMode = false

  const wrapper = {
    run(...params: any[]) {
      return stmt.run(...params)
    },
    all(...params: any[]) {
      const rows = stmt.all(...params) as Record<string, unknown>[]
      if (rawMode) {
        return rows.map((row) => Object.values(row))
      }
      return rows
    },
    get(...params: any[]) {
      return stmt.get(...params)
    },
    raw(mode = true) {
      rawMode = mode
      return wrapper
    },
  }
  return wrapper
}

function createNodeSqliteAdapter(dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA busy_timeout = 5000;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA cache_size = -64000;")
  db.exec("PRAGMA journal_size_limit = 67108864;")
  db.exec("PRAGMA foreign_keys = ON;")

  return {
    pragma(cmd: string) {
      return db.prepare(`PRAGMA ${cmd}`).all()
    },
    prepare(sql: string) {
      return createStatementAdapter(db, sql)
    },
    exec(sql: string) {
      return db.exec(sql)
    },
    close() {
      db.close()
    },
    transaction<T>(fn: (db: unknown) => T) {
      function runTx(mode: string) {
        return (...args: unknown[]) => {
          db.exec(`BEGIN ${mode}`)
          try {
            const result = (fn as (...a: unknown[]) => T)(...args)
            db.exec("COMMIT")
            return result
          } catch (err) {
            db.exec("ROLLBACK")
            throw err
          }
        }
      }

      const wrapper = runTx("DEFERRED") as ((...args: unknown[]) => T) & {
        deferred: (...args: unknown[]) => T
        immediate: (...args: unknown[]) => T
        exclusive: (...args: unknown[]) => T
      }
      wrapper.deferred = runTx("DEFERRED")
      wrapper.immediate = runTx("IMMEDIATE")
      wrapper.exclusive = runTx("EXCLUSIVE")
      return wrapper
    },
  }
}

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS session_groups (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project_tag TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    session_group_id TEXT NOT NULL REFERENCES session_groups(id),
    provider TEXT NOT NULL,
    alias TEXT NOT NULL,
    current_model TEXT,
    native_session_id TEXT,
    sop_bookmark TEXT,
    last_fill_ratio REAL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
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
    thread_id TEXT NOT NULL REFERENCES threads(id),
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
    invocation_id TEXT NOT NULL REFERENCES invocations(id),
    thread_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_memories (
    id TEXT PRIMARY KEY,
    session_group_id TEXT NOT NULL REFERENCES session_groups(id),
    summary TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    session_group_id TEXT NOT NULL REFERENCES session_groups(id),
    assignee_agent_id TEXT NOT NULL,
    description TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'pending',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

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

  CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_threads_session_group_id ON threads(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_invocation_id ON agent_events(invocation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_thread_id ON agent_events(thread_id);
  CREATE INDEX IF NOT EXISTS idx_session_memories_session_group_id ON session_memories(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_session_group_id ON tasks(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_authorization_rules_provider_thread ON authorization_rules(provider, thread_id);
`

export function createDrizzleDb(dbPath: string) {
  const adapter = createNodeSqliteAdapter(dbPath)
  adapter.exec(INIT_SQL)
  const db = drizzle(adapter as any, { schema })

  return {
    db,
    raw: adapter,
    close: () => adapter.close(),
  }
}
