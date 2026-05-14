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
    model TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    retry_reasons TEXT NOT NULL DEFAULT '[]',
    a2a_call_id TEXT
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

  -- F026 P5 in-flight · a2a_calls 表挪到 drizzle INIT_SQL 自闭环。
  -- 历史上 SqliteStore.ctor 建过一份（同 IF NOT EXISTS，幂等无副作用）；
  -- 但 drizzle 路径的 listMessages LEFT JOIN a2a_calls 必须保证建表完成才能跑。
  -- 与 sqlite.ts L274 保持一致；CHECK 状态机沿用六态。
  CREATE TABLE IF NOT EXISTS a2a_calls (
    call_id TEXT PRIMARY KEY,
    parent_call_id TEXT,
    root_call_id TEXT NOT NULL,
    issuer_id TEXT NOT NULL,
    convener_id TEXT NOT NULL,
    on_behalf_of TEXT,
    reply_to TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    join_set_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','working','done','failed','timeout','cancelled')),
    envelope_version TEXT NOT NULL DEFAULT 'v1',
    session_group_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  -- F026 P5 T0 · idx_messages_a2a_call_id 不放这里（INIT_SQL 内）：老库 messages 已存在
  -- CREATE TABLE 跳过、a2a_call_id 列要等 MIGRATIONS 的 ALTER TABLE 才会有；INIT_SQL 内
  -- CREATE INDEX 引用尚未建好的列会 throw，比 ALTER 跑得早 → 启动崩。
  -- 索引建立挪到 MIGRATIONS 数组 a2a_call_id ALTER 之后（幂等的 CREATE INDEX IF NOT EXISTS）。
  CREATE INDEX IF NOT EXISTS idx_threads_session_group_id ON threads(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_invocation_id ON agent_events(invocation_id);
  CREATE INDEX IF NOT EXISTS idx_agent_events_thread_id ON agent_events(thread_id);
  CREATE INDEX IF NOT EXISTS idx_session_memories_session_group_id ON session_memories(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_session_group_id ON tasks(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_authorization_rules_provider_thread ON authorization_rules(provider, thread_id);
  CREATE INDEX IF NOT EXISTS idx_embeddings_thread ON message_embeddings(thread_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_sop_feature_id ON workflow_sop(feature_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_sop_stage ON workflow_sop(stage);

  -- F027 P0 · 4 张地基表 (V16.5-final.md chap 5 / 11 / 14 / 18)
  -- 每表都预留 reserved_1 / reserved_2 TEXT NULL（V16.5.3 风险卡）。

  -- chap 5 · wiki entity 单一提交事件源（PREPARE/WRITE/COMMIT 三阶段）
  CREATE TABLE IF NOT EXISTS wiki_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    alias TEXT NOT NULL,
    action TEXT NOT NULL,
    path TEXT NOT NULL,
    base_hash TEXT,
    content_hash TEXT,
    attempted_hash TEXT,
    diff_summary TEXT,
    source_message_ids TEXT,
    promotion_target TEXT,
    reason TEXT,
    fencing_token TEXT NOT NULL,
    leader_term TEXT NOT NULL,
    result TEXT NOT NULL,
    error TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'committed', 'aborted')),
    result_manifest_version TEXT,
    reserved_1 TEXT,
    reserved_2 TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_events_path ON wiki_events(path, ts);
  CREATE INDEX IF NOT EXISTS idx_wiki_events_alias ON wiki_events(alias, ts);
  CREATE INDEX IF NOT EXISTS idx_wiki_events_state ON wiki_events(state, ts);
  CREATE INDEX IF NOT EXISTS idx_wiki_events_term ON wiki_events(leader_term);

  -- chap 14 · 6 类记忆桶物理表（type CHECK 5 enum 防漂桶 lint 兜底）
  CREATE TABLE IF NOT EXISTS wiki_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('room', 'project', 'user', 'feedback', 'work')),
    name TEXT NOT NULL,
    canonical_owner_path TEXT NOT NULL,
    promotion_target TEXT,
    ttl_days INTEGER,
    supersedes TEXT,
    replaces_in_buckets TEXT,
    source_message_ids TEXT,
    contributed_by TEXT NOT NULL,
    cross_refs TEXT,
    dedup_decision TEXT,
    body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'canonical', 'deprecated')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reserved_1 TEXT,
    reserved_2 TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_memories_type ON wiki_memories(type);
  CREATE INDEX IF NOT EXISTS idx_wiki_memories_canonical ON wiki_memories(canonical_owner_path);
  CREATE INDEX IF NOT EXISTS idx_wiki_memories_state ON wiki_memories(state, type);

  -- chap 11 · viewfinder anti-drift decision ledger（append-only + tombstone）
  -- P4 C-auto-2 (小孙 2026-05-13 拍): status 字段让 extractor 自动 sweep 旧 commit，
  --   viewfinder §3 "下一步"只取 status='active'，避免已完成承诺持续显示
  CREATE TABLE IF NOT EXISTS room_decisions (
    decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    decision_type TEXT NOT NULL,
    content TEXT NOT NULL,
    source_message_ids TEXT NOT NULL,
    source_quote TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    tombstone INTEGER NOT NULL DEFAULT 0,
    superseded_by INTEGER,
    fencing_token TEXT NOT NULL,
    extractor_confidence REAL,
    coverage_check_passed INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    reserved_1 TEXT,
    reserved_2 TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_room_decisions ON room_decisions(room_id, decided_at);
  -- P4: viewfinder §3 SQL 高频查 (decision_type='commit' AND status='active')
  CREATE INDEX IF NOT EXISTS idx_room_decisions_status_type
    ON room_decisions(room_id, decision_type, status);

  -- chap 18 · prompt 拼装审计（assembler 每次拼装同步写一条）
  CREATE TABLE IF NOT EXISTS prompt_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    alias TEXT NOT NULL,
    room_id TEXT,
    scenario TEXT NOT NULL,
    total_tokens INTEGER NOT NULL,
    cap INTEGER NOT NULL,
    parts_json TEXT NOT NULL,
    not_injected_json TEXT,
    iron_laws_count INTEGER NOT NULL,
    raw_text TEXT NOT NULL,
    source_event_ids TEXT,
    recall_queries TEXT,
    recall_results TEXT,
    recall_total_tokens INTEGER,
    recall_rejected_reasons TEXT,
    recall_required INTEGER NOT NULL DEFAULT 0,
    recall_trigger TEXT,
    recall_path INTEGER,
    top_score REAL,
    recall_satisfied INTEGER NOT NULL DEFAULT 0,
    escalate_reason TEXT,
    recall_total_ms INTEGER,
    recall_critique_calls INTEGER,
    recall_budget_exceeded INTEGER,
    agent_session_ref TEXT,
    reserved_1 TEXT,
    reserved_2 TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_prompt_audit ON prompt_audit(alias, room_id, created_at);

  -- F027 P3 chap 6 · update_wiki lease 表（path 维度互斥锁）+ 单调 fencing 序列。
  CREATE TABLE IF NOT EXISTS wiki_leases (
    path TEXT PRIMARY KEY,
    fencing_token TEXT NOT NULL,
    owner_alias TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    leader_term TEXT NOT NULL,
    reserved_1 TEXT,
    reserved_2 TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_leases_expires ON wiki_leases(expires_at);

  CREATE TABLE IF NOT EXISTS wiki_fencing_seq (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO wiki_fencing_seq (id, next_value) VALUES (1, '0');

  -- F027 P3.5 chap 5 · Compiler Leader Lease（防 split-brain）+ 拒旧 leader_term 触发器。
  CREATE TABLE IF NOT EXISTS compiler_leader (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_term TEXT NOT NULL,
    leader_alias TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    reserved_1 TEXT,
    reserved_2 TEXT
  );

  -- 触发器：BEFORE INSERT ON wiki_events，若 NEW.leader_term 小于当前 leader term
  -- 则 RAISE(ABORT)。term 是 bigint as TEXT，CAST 比较以避免字典序坑。
  -- 注意：compiler_leader 行不存在时（启动期）跳过触发器（无现任 leader = 任意写都允许）。
  CREATE TRIGGER IF NOT EXISTS reject_stale_leader
    BEFORE INSERT ON wiki_events
    WHEN EXISTS (SELECT 1 FROM compiler_leader WHERE id = 1)
      AND CAST(NEW.leader_term AS INTEGER) < CAST((SELECT current_term FROM compiler_leader WHERE id = 1) AS INTEGER)
    BEGIN
      SELECT RAISE(ABORT, 'stale leader_term');
    END;

  -- F027 P7 chap 8 · RoomCompiler 二阶段提交 + commit-monotonic cursor + sealed cursor
  CREATE TABLE IF NOT EXISTS room_checkpoints (
    room_id TEXT PRIMARY KEY,
    cursor_commit_seq INTEGER NOT NULL,
    cursor_message_id TEXT NOT NULL,
    sealed_cursor_seq INTEGER NOT NULL,
    viewfinder_hash TEXT NOT NULL,
    decisions_hash TEXT NOT NULL,
    log_hash TEXT NOT NULL,
    thread_seal_id TEXT,
    compiled_at TEXT NOT NULL,
    committed_at TEXT,
    fencing_token TEXT NOT NULL,
    leader_term TEXT NOT NULL,
    reserved_1 TEXT,
    reserved_2 TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_room_checkpoints_committed
    ON room_checkpoints(committed_at);

  CREATE TABLE IF NOT EXISTS message_commit_seq (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    committed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS thread_seal_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    sealed_at TEXT NOT NULL,
    fencing_token TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_thread_seal_events_room
    ON thread_seal_events(room_id, seq);

  -- F027 P8 chap 9 · per-agent S-XXXX.md ledger（room × alias × session_seq）
  CREATE TABLE IF NOT EXISTS room_agent_sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    session_seq INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    entry_reason TEXT NOT NULL,
    exit_reason TEXT,
    last_seen_commit_seq INTEGER,
    open_threads TEXT,
    closed_threads TEXT,
    private_notes_hash TEXT,
    session_digest TEXT,
    archived TEXT NOT NULL DEFAULT 'N',
    archived_at TEXT,
    archived_year INTEGER,
    reserved_1 TEXT,
    reserved_2 TEXT,
    UNIQUE(room_id, alias, session_seq)
  );
  CREATE INDEX IF NOT EXISTS idx_room_agent_sessions
    ON room_agent_sessions(room_id, alias, session_seq);
  CREATE INDEX IF NOT EXISTS idx_room_agent_sessions_active
    ON room_agent_sessions(archived, room_id, alias);

  -- F027 P14.a · wiki entity 索引基表（indexer 扫 wiki/<bucket>/*.md 落入）
  CREATE TABLE IF NOT EXISTS wiki_entity_index (
    path TEXT PRIMARY KEY,
    bucket TEXT NOT NULL,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_entity_index_bucket
    ON wiki_entity_index(bucket);

  -- F027 P14.a · FTS5 虚拟表（content= 关联 wiki_entity_index）
  -- 范-r1 P2-2 修：tokenizer 换 trigram（SQLite 3.34+ 内置）
  --   unicode61 默认对中文一字一 token，'上下文窗口' query 切成 4 个独立 token，
  --   匹配纯靠 AND 组合，中等长度词命中差。trigram 按字符 3-gram 索引，对中文
  --   substring 召回精度好；索引膨胀 ~3-4x 可接受（100k entity × 5KB → 数 GB）。
  --   也兼容英文 partial match（'drizzle' 命中含 'drizzle' 的任意片段）。
  -- 'case_sensitive 0' 让英文大小写不敏感（'F011' 匹配 'f011'）。
  CREATE VIRTUAL TABLE IF NOT EXISTS wiki_entity_fts USING fts5(
    path UNINDEXED,
    bucket UNINDEXED,
    name,
    body,
    content='wiki_entity_index',
    content_rowid='rowid',
    tokenize='trigram case_sensitive 0'
  );

  -- F027 P14.a · 触发器同步 wiki_entity_index → wiki_entity_fts
  -- INSERT
  CREATE TRIGGER IF NOT EXISTS wiki_entity_fts_ai
  AFTER INSERT ON wiki_entity_index BEGIN
    INSERT INTO wiki_entity_fts(rowid, path, bucket, name, body)
    VALUES (new.rowid, new.path, new.bucket, new.name, new.body);
  END;
  -- DELETE（FTS5 contentless 行需要发 'delete' command + 原 row）
  CREATE TRIGGER IF NOT EXISTS wiki_entity_fts_ad
  AFTER DELETE ON wiki_entity_index BEGIN
    INSERT INTO wiki_entity_fts(wiki_entity_fts, rowid, path, bucket, name, body)
    VALUES ('delete', old.rowid, old.path, old.bucket, old.name, old.body);
  END;
  -- UPDATE = DELETE 旧 + INSERT 新
  CREATE TRIGGER IF NOT EXISTS wiki_entity_fts_au
  AFTER UPDATE ON wiki_entity_index BEGIN
    INSERT INTO wiki_entity_fts(wiki_entity_fts, rowid, path, bucket, name, body)
    VALUES ('delete', old.rowid, old.path, old.bucket, old.name, old.body);
    INSERT INTO wiki_entity_fts(rowid, path, bucket, name, body)
    VALUES (new.rowid, new.path, new.bucket, new.name, new.body);
  END;

  -- F027 P14.b · messages FTS5 索引（V16.5-final.md chap 21 P14 + chap 22 query_messages MCP）
  -- 设计：
  --   - external content table: content='messages' + content_rowid='rowid'，messages_fts
  --     不冗余存 body，只持索引，省 disk（~3M messages × 5KB = ~15GB 不能再翻倍）。
  --   - 只索引 content 一列；thread_id / role / created_at 走 JOIN messages 表取，
  --     UNINDEXED 加进 fts 表反而徒占 schema 不省 IO（fts5 UNINDEXED 列存原 row 副本）。
  --   - tokenizer 与 wiki_entity_fts 对齐：trigram case_sensitive 0；中文 substring 召回稳。
  --   - rowid 一致性：messages 是 TEXT PK + 隐式 INTEGER rowid（非 WITHOUT ROWID），
  --     content_rowid='rowid' 默认走隐式 rowid，触发器 NEW.rowid 同步过去 OK。
  --
  -- 风险卡：
  --   - 老库 messages 已有大量行 → 触发器 attach 后只对未来 INSERT 同步。runMigrations
  --     里 backfillMessagesFtsIfEmpty 在 fts 为空但 messages 非空时发 'rebuild'。
  --   - rebuild 在 3M 行库上可能 ~10s+，启动 IO 一次。下次启动 fts 不空跳过。
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram case_sensitive 0'
  );

  -- F027 P14.b · 触发器同步 messages → messages_fts
  -- INSERT
  CREATE TRIGGER IF NOT EXISTS messages_fts_ai
  AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  -- DELETE（contentless 行需 'delete' command）
  CREATE TRIGGER IF NOT EXISTS messages_fts_ad
  AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  END;
  -- UPDATE = DELETE 旧 + INSERT 新（messages.content 变化 / 罕见，但 F018 retry 兜底 / F021 model snapshot 重写都可能 UPDATE）
  CREATE TRIGGER IF NOT EXISTS messages_fts_au
  AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  -- F027 P0 · V16.5.1 F3 实施前置：drizzle 路径补 a2a_calls 4 个索引（与 sqlite.ts:327-330 对齐），
  -- 加复合索引 idx_a2a_calls_session_status_updated（viewfinder §4 高频查询）。
  -- 性能 AC：viewfinder 编译 1000 calls 房间 ≤ 50ms。
  CREATE INDEX IF NOT EXISTS idx_a2a_calls_parent ON a2a_calls(parent_call_id);
  CREATE INDEX IF NOT EXISTS idx_a2a_calls_root ON a2a_calls(root_call_id);
  CREATE INDEX IF NOT EXISTS idx_a2a_calls_status_deadline ON a2a_calls(status, deadline_at);
  CREATE INDEX IF NOT EXISTS idx_a2a_calls_session_group ON a2a_calls(session_group_id);
  CREATE INDEX IF NOT EXISTS idx_a2a_calls_session_status_updated
    ON a2a_calls(session_group_id, status, updated_at);
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
  // F026 P3.1: assistant final 派发协议 retry 兜底层
  {
    name: "F026-P3.1-messages-add-retry-count",
    sql: "ALTER TABLE messages ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;",
  },
  {
    name: "F026-P3.1-messages-add-retry-reasons",
    sql: "ALTER TABLE messages ADD COLUMN retry_reasons TEXT NOT NULL DEFAULT '[]';",
  },
  // F026 P5 T0 · messages.a2a_call_id —— 前端 10 原语 LEFT JOIN a2a_calls 入口
  {
    name: "F026-P5-T0-messages-add-a2a-call-id",
    sql: "ALTER TABLE messages ADD COLUMN a2a_call_id TEXT;",
  },
  // 索引必须 ALTER 之后建：老库时 INIT_SQL CREATE TABLE 跳过、列要 ALTER 才有
  {
    name: "F026-P5-T0-messages-idx-a2a-call-id",
    sql: "CREATE INDEX IF NOT EXISTS idx_messages_a2a_call_id ON messages(a2a_call_id);",
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
  // F027 P14.a 范-r2 修：FTS5 tokenizer 升级（unicode61 → trigram）。
  //   SQLite FTS5 tokenizer 是 CREATE 时锁定的，CREATE VIRTUAL TABLE IF NOT EXISTS
  //   对既有不同 tokenizer 的表不会 alter。本函数检测 sqlite_master.sql 含
  //   unicode61 但不含 trigram → DROP + 重新 CREATE + 'rebuild' 命令让 FTS5 从
  //   wiki_entity_index 全表扫重建索引。base 表 wiki_entity_index 不动。
  upgradeWikiEntityFtsTokenizer(adapter)
  // F027 P14.b · messages_fts 同款 tokenizer 升级（极少见但对称兜底）
  upgradeMessagesFtsTokenizer(adapter)
  // F027 P14.b · messages_fts backfill（first-time 建表场景：触发器只对未来 INSERT 同步）
  backfillMessagesFtsIfEmpty(adapter)
}

function upgradeWikiEntityFtsTokenizer(adapter: ReturnType<typeof createNodeSqliteAdapter>): void {
  let existingSql: string | null = null
  try {
    const row = adapter
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wiki_entity_fts'")
      .get() as { sql?: string } | undefined
    existingSql = row?.sql ?? null
  } catch {
    return
  }
  if (!existingSql) return // 表还没建，INIT_SQL 已建 trigram 形态
  if (/trigram/i.test(existingSql)) return // 已是 trigram，幂等
  if (!/unicode61/i.test(existingSql)) return // 未知 tokenizer，保守不动
  // 旧 unicode61 → 升级 trigram
  try {
    adapter.exec("DROP TABLE wiki_entity_fts;")
    adapter.exec(`
      CREATE VIRTUAL TABLE wiki_entity_fts USING fts5(
        path UNINDEXED,
        bucket UNINDEXED,
        name,
        body,
        content='wiki_entity_index',
        content_rowid='rowid',
        tokenize='trigram case_sensitive 0'
      );
    `)
    // FTS5 'rebuild' 命令：从 content 表 (wiki_entity_index) 全表扫重建索引
    // 触发器仍然 attach（前面 INIT_SQL 已 CREATE TRIGGER IF NOT EXISTS）
    adapter.exec("INSERT INTO wiki_entity_fts(wiki_entity_fts) VALUES('rebuild');")
  } catch (err) {
    // 升级失败不阻塞启动；下次 indexer reindex 会通过 trigger 重新填
    // 触发器已 attach，indexer 走 INSERT/UPDATE 时会重新同步
    const msg = String((err as { message?: unknown })?.message ?? err)
    if (!/no such table/i.test(msg)) throw err
  }
}

// F027 P14.b · messages_fts tokenizer 升级（与 wiki_entity_fts 对称）。
// 极少见路径（messages_fts 是 P14.b 新表，老库本无），但若历史人手实验建过
// unicode61 版需要兜底升级到 trigram。逻辑同 upgradeWikiEntityFtsTokenizer：
// DROP + 重 CREATE + 'rebuild' 命令让 FTS5 从 messages 全表扫重建索引。
function upgradeMessagesFtsTokenizer(adapter: ReturnType<typeof createNodeSqliteAdapter>): void {
  let existingSql: string | null = null
  try {
    const row = adapter
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'")
      .get() as { sql?: string } | undefined
    existingSql = row?.sql ?? null
  } catch {
    return
  }
  if (!existingSql) return
  if (/trigram/i.test(existingSql)) return
  if (!/unicode61/i.test(existingSql)) return
  try {
    adapter.exec("DROP TABLE messages_fts;")
    adapter.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='trigram case_sensitive 0'
      );
    `)
    adapter.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');")
  } catch (err) {
    const msg = String((err as { message?: unknown })?.message ?? err)
    if (!/no such table/i.test(msg)) throw err
  }
}

// F027 P14.b · first-time backfill：messages_fts 是 P14.b 新增的虚拟表，
// 触发器 attach 后只对未来 INSERT/UPDATE/DELETE 同步。老库已有的 messages 行
// 必须显式发 'rebuild' 命令让 FTS5 从 content='messages' 全表扫重建索引。
//
// 判定条件：messages_fts 索引为空 + messages 表非空 → rebuild。
//
// 范-r1 P1-1（NO-GO blocking）修：external content FTS5 表上 SELECT 无 MATCH 时
//   SQLite 会把查询透传到 base 表 messages（SQLite FTS5 文档 §4.4.4 "External
//   Content Table Pitfalls"），所以 `SELECT rowid FROM messages_fts LIMIT 1` 在
//   老库 messages 非空但 fts 索引为空时会**误返非空**，跳过 rebuild → 历史 messages
//   永远查不到。改用 FTS5 shadow 表 messages_fts_docsize 真读索引大小（per-doc 一行，
//   external content 模式 ground truth）。
//
// 风险：3M messages × 5KB 全表扫 ~10s+，启动 IO 一次性贵；同步执行保证启动后
// query_messages 立即一致。失败不阻塞启动（fail-soft + 下次启动重试）。
// 范-r1 P2-1：生产大库迁移建议记录耗时（见 logger.info / 大库改后台化策略待 P15）。
function backfillMessagesFtsIfEmpty(adapter: ReturnType<typeof createNodeSqliteAdapter>): void {
  // FTS5 shadow 表 messages_fts_docsize（external content 模式真索引行数源）
  // 表存在性兜底（INIT_SQL 已建，但保守 try/catch）
  let ftsEmpty = false
  try {
    const row = adapter.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get() as
      | { n?: number }
      | undefined
    ftsEmpty = !row || (row.n ?? 0) === 0
  } catch {
    return // shadow 表不存在（虚拟表未建）→ 啥也不做
  }
  if (!ftsEmpty) return

  // messages 表是否非空（避免空库无意义 rebuild）
  let messagesNonEmpty = false
  try {
    const row = adapter.prepare("SELECT id FROM messages LIMIT 1").get() as
      | { id?: string }
      | undefined
    messagesNonEmpty = !!row
  } catch {
    return
  }
  if (!messagesNonEmpty) return

  // 范-r1 P2-1：记录 rebuild 耗时给运维可观测（大库可见启动延迟）
  const startMs = Date.now()
  try {
    adapter.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');")
    const elapsedMs = Date.now() - startMs
    // node stderr 直写（adapter 没有 logger 依赖，drizzle-instance 层不便 wire pino）
    process.stderr.write(
      `[F027 P14.b] messages_fts first-time backfill 'rebuild' 完成: ${elapsedMs}ms\n`,
    )
  } catch {
    // fail-soft: rebuild 失败不阻塞启动；下次启动 fts 仍为空会再尝试
  }
}

// F022 Phase 1: 历史 session roomId 回填（幂等）。
// 仅回填 room_id IS NULL 的行，按 created_at 升序分配 R-xxx，接续表中已有的
// 最大序号。旧库 ALTER 路径不带 UNIQUE，回填后由 CREATE UNIQUE INDEX 补齐。
function backfillRoomIds(adapter: ReturnType<typeof createNodeSqliteAdapter>): void {
  const pending = adapter
    .prepare("SELECT id FROM session_groups WHERE room_id IS NULL ORDER BY created_at ASC, id ASC")
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
    adapter.exec("CREATE UNIQUE INDEX idx_session_groups_room_id ON session_groups(room_id)")
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
    const cols = adapter.prepare("SELECT name FROM pragma_index_info(?)").all(idx.name) as Array<{
      name: string
    }>
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
