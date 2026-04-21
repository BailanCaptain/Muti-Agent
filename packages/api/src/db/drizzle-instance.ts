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
      const row = stmt.get(...params) as Record<string, unknown> | undefined
      if (rawMode && row) {
        // F019: drizzle's .get() sets rawMode=true and expects a positional
        // tuple; prior adapter only handled rawMode in all(), so drizzle's
        // column mapping returned all-undefined objects. Mirror all()'s behavior.
        return Object.values(row)
      }
      return row
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
    room_id TEXT UNIQUE,
    title TEXT NOT NULL,
    project_tag TEXT,
    runtime_config TEXT,
    title_locked_at TEXT,
    archived_at TEXT,
    deleted_at TEXT,
    title_backfill_attempts INTEGER NOT NULL DEFAULT 0,
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
    thread_memory TEXT,
    session_chain_index INTEGER NOT NULL DEFAULT 1,
    backlog_item_id TEXT,
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
    created_at TEXT NOT NULL,
    model TEXT
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
    last_activity_at TEXT,
    config_snapshot TEXT
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

  CREATE TABLE IF NOT EXISTS workflow_sop (
    backlog_item_id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    baton_holder TEXT,
    next_skill TEXT,
    resume_capsule TEXT NOT NULL DEFAULT '{}',
    checks TEXT NOT NULL DEFAULT '{}',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_threads_session_group_id ON threads(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_invocation_id ON agent_events(invocation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_thread_id ON agent_events(thread_id);
  CREATE INDEX IF NOT EXISTS idx_session_memories_session_group_id ON session_memories(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_session_group_id ON tasks(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_authorization_rules_provider_thread ON authorization_rules(provider, thread_id);
  CREATE INDEX IF NOT EXISTS idx_embeddings_thread ON message_embeddings(thread_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_sop_feature_id ON workflow_sop(feature_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_sop_stage ON workflow_sop(stage);
`

// F019: Idempotent migrations for old DBs (pre-F019 schema).
// CREATE TABLE IF NOT EXISTS is self-idempotent; ALTER TABLE ADD COLUMN is not,
// so we catch "duplicate column name" errors.
const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  // F018 AC8.1: ThreadMemory rolling summary persistence column
  {
    name: "F018-threads-add-thread-memory",
    sql: "ALTER TABLE threads ADD COLUMN thread_memory TEXT;",
  },
  // F018 P3 AC3.5: session chain index for Bootstrap identity section
  {
    name: "F018-threads-add-session-chain-index",
    sql: "ALTER TABLE threads ADD COLUMN session_chain_index INTEGER NOT NULL DEFAULT 1;",
  },
  // F019 P2: thread → feature binding for WorkflowSop state machine
  {
    name: "F019-threads-add-backlog-item-id",
    sql: "ALTER TABLE threads ADD COLUMN backlog_item_id TEXT;",
  },
  // F021 Phase 2.2: per-session runtime config override (JSON stringified)
  {
    name: "F021-session-groups-add-runtime-config",
    sql: "ALTER TABLE session_groups ADD COLUMN runtime_config TEXT;",
  },
  // F021 Phase 3.3: frozen per-invocation config snapshot (JSON)
  {
    name: "F021-invocations-add-config-snapshot",
    sql: "ALTER TABLE invocations ADD COLUMN config_snapshot TEXT;",
  },
  // F022 Phase 1: 全局递增 ROOM ID (R-001, R-002, ...)
  {
    name: "F022-session-groups-add-room-id",
    sql: "ALTER TABLE session_groups ADD COLUMN room_id TEXT;",
  },
  // F022 Phase 3.5: 手动命名锁（AC-14g）
  {
    name: "F022-session-groups-add-title-locked-at",
    sql: "ALTER TABLE session_groups ADD COLUMN title_locked_at TEXT;",
  },
  // F022 Phase 3.5: 归档（AC-14i）
  {
    name: "F022-session-groups-add-archived-at",
    sql: "ALTER TABLE session_groups ADD COLUMN archived_at TEXT;",
  },
  // F022 Phase 3.5: 软删（AC-14j）
  {
    name: "F022-session-groups-add-deleted-at",
    sql: "ALTER TABLE session_groups ADD COLUMN deleted_at TEXT;",
  },
  // F022 Phase 3.5: Haiku 命名失败计数
  {
    name: "F022-session-groups-add-title-backfill-attempts",
    sql: "ALTER TABLE session_groups ADD COLUMN title_backfill_attempts INTEGER NOT NULL DEFAULT 0;",
  },
  // F021 Phase 5: per-message resolved model snapshot (chat bubble pill)
  {
    name: "F021-messages-add-model",
    sql: "ALTER TABLE messages ADD COLUMN model TEXT;",
  },
]

function runMigrations(adapter: ReturnType<typeof createNodeSqliteAdapter>): void {
  for (const m of MIGRATIONS) {
    try {
      adapter.exec(m.sql)
    } catch (err) {
      const msg = String((err as { message?: unknown })?.message ?? err)
      // SQLite error when column already exists: "duplicate column name: backlog_item_id"
      if (!/duplicate column name/i.test(msg)) {
        throw err
      }
    }
  }
}

// F022 Phase 1: 历史 session roomId 回填（幂等）。
// 仅回填 room_id IS NULL 的行，按 created_at 升序分配 R-xxx，接续表中已有的
// 最大序号。旧库 ALTER 路径不带 UNIQUE，回填后由 CREATE UNIQUE INDEX 补齐。
function backfillRoomIds(adapter: ReturnType<typeof createNodeSqliteAdapter>): void {
  const pending = adapter
    .prepare(
      "SELECT id FROM session_groups WHERE room_id IS NULL ORDER BY created_at ASC, id ASC",
    )
    .all() as Array<{ id: string }>

  if (pending.length > 0) {
    const maxRow = adapter
      .prepare(
        "SELECT MAX(CAST(SUBSTR(room_id, 3) AS INTEGER)) AS maxSeq FROM session_groups WHERE room_id IS NOT NULL AND room_id LIKE 'R-%'",
      )
      .get() as { maxSeq: number | null } | undefined
    let next = (maxRow?.maxSeq ?? 0) + 1

    const update = adapter.prepare("UPDATE session_groups SET room_id = ? WHERE id = ?")
    adapter.exec("BEGIN")
    try {
      for (const row of pending) {
        update.run(`R-${String(next).padStart(3, "0")}`, row.id)
        next++
      }
      adapter.exec("COMMIT")
    } catch (err) {
      adapter.exec("ROLLBACK")
      throw err
    }
  }

  // 回填之后补齐 UNIQUE 约束。新库走 CREATE TABLE 路径已有 sqlite_autoindex，
  // 重复 CREATE UNIQUE INDEX 会造成同列两份索引 — 每次写都要维护两遍。
  // 只在还没有任何 UNIQUE 单列索引覆盖 room_id 时建命名索引（补旧库 ALTER 路径）。
  if (!hasUniqueIndexOnColumn(adapter, "session_groups", "room_id")) {
    adapter.exec(
      "CREATE UNIQUE INDEX idx_session_groups_room_id ON session_groups(room_id)",
    )
  }
}

function hasUniqueIndexOnColumn(
  adapter: ReturnType<typeof createNodeSqliteAdapter>,
  table: string,
  column: string,
): boolean {
  const indexes = adapter
    .prepare('SELECT name, "unique" AS isUnique FROM pragma_index_list(?)')
    .all(table) as Array<{ name: string; isUnique: number }>
  for (const idx of indexes) {
    if (idx.isUnique !== 1) continue
    const cols = adapter
      .prepare("SELECT name FROM pragma_index_info(?)")
      .all(idx.name) as Array<{ name: string }>
    if (cols.length === 1 && cols[0].name === column) return true
  }
  return false
}

export function createDrizzleDb(dbPath: string) {
  const adapter = createNodeSqliteAdapter(dbPath)
  adapter.exec(INIT_SQL)
  runMigrations(adapter)
  backfillRoomIds(adapter)
  const db = drizzle(adapter as any, { schema })

  return {
    db,
    raw: adapter,
    close: () => adapter.close(),
  }
}
