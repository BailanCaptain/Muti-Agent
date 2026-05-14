-- AC-P1-11 true SQLite dump from temp BM25 fixture
-- sqlite_master
-- index idx_a2a_calls_parent
CREATE INDEX idx_a2a_calls_parent ON a2a_calls(parent_call_id);
-- index idx_a2a_calls_root
CREATE INDEX idx_a2a_calls_root ON a2a_calls(root_call_id);
-- index idx_a2a_calls_session_group
CREATE INDEX idx_a2a_calls_session_group ON a2a_calls(session_group_id);
-- index idx_a2a_calls_session_status_updated
CREATE INDEX idx_a2a_calls_session_status_updated
    ON a2a_calls(session_group_id, status, updated_at);
-- index idx_a2a_calls_status_deadline
CREATE INDEX idx_a2a_calls_status_deadline ON a2a_calls(status, deadline_at);
-- index idx_agent_events_invocation_id
CREATE INDEX idx_agent_events_invocation_id ON agent_events(invocation_id);
-- index idx_agent_events_thread_id
CREATE INDEX idx_agent_events_thread_id ON agent_events(thread_id);
-- index idx_authorization_rules_provider_thread
CREATE INDEX idx_authorization_rules_provider_thread ON authorization_rules(provider, thread_id);
-- index idx_embeddings_thread
CREATE INDEX idx_embeddings_thread ON message_embeddings(thread_id);
-- index idx_messages_a2a_call_id
CREATE INDEX idx_messages_a2a_call_id ON messages(a2a_call_id);
-- index idx_messages_created_at
CREATE INDEX idx_messages_created_at ON messages(created_at);
-- index idx_messages_thread_id
CREATE INDEX idx_messages_thread_id ON messages(thread_id);
-- index idx_prompt_audit
CREATE INDEX idx_prompt_audit ON prompt_audit(alias, room_id, created_at);
-- index idx_room_agent_sessions
CREATE INDEX idx_room_agent_sessions
    ON room_agent_sessions(room_id, alias, session_seq);
-- index idx_room_agent_sessions_active
CREATE INDEX idx_room_agent_sessions_active
    ON room_agent_sessions(archived, room_id, alias);
-- index idx_room_checkpoints_committed
CREATE INDEX idx_room_checkpoints_committed
    ON room_checkpoints(committed_at);
-- index idx_room_decisions
CREATE INDEX idx_room_decisions ON room_decisions(room_id, decided_at);
-- index idx_room_decisions_status_type
CREATE INDEX idx_room_decisions_status_type
    ON room_decisions(room_id, decision_type, status);
-- index idx_session_memories_session_group_id
CREATE INDEX idx_session_memories_session_group_id ON session_memories(session_group_id);
-- index idx_tasks_session_group_id
CREATE INDEX idx_tasks_session_group_id ON tasks(session_group_id);
-- index idx_thread_seal_events_room
CREATE INDEX idx_thread_seal_events_room
    ON thread_seal_events(room_id, seq);
-- index idx_threads_session_group_id
CREATE INDEX idx_threads_session_group_id ON threads(session_group_id);
-- index idx_wiki_entity_index_bucket
CREATE INDEX idx_wiki_entity_index_bucket
    ON wiki_entity_index(bucket);
-- index idx_wiki_events_alias
CREATE INDEX idx_wiki_events_alias ON wiki_events(alias, ts);
-- index idx_wiki_events_path
CREATE INDEX idx_wiki_events_path ON wiki_events(path, ts);
-- index idx_wiki_events_state
CREATE INDEX idx_wiki_events_state ON wiki_events(state, ts);
-- index idx_wiki_events_term
CREATE INDEX idx_wiki_events_term ON wiki_events(leader_term);
-- index idx_wiki_leases_expires
CREATE INDEX idx_wiki_leases_expires ON wiki_leases(expires_at);
-- index idx_wiki_memories_canonical
CREATE INDEX idx_wiki_memories_canonical ON wiki_memories(canonical_owner_path);
-- index idx_wiki_memories_state
CREATE INDEX idx_wiki_memories_state ON wiki_memories(state, type);
-- index idx_wiki_memories_type
CREATE INDEX idx_wiki_memories_type ON wiki_memories(type);
-- index idx_workflow_sop_feature_id
CREATE INDEX idx_workflow_sop_feature_id ON workflow_sop(feature_id);
-- index idx_workflow_sop_stage
CREATE INDEX idx_workflow_sop_stage ON workflow_sop(stage);
-- table a2a_calls
CREATE TABLE a2a_calls (
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
-- table agent_events
CREATE TABLE agent_events (
    id TEXT PRIMARY KEY,
    invocation_id TEXT NOT NULL REFERENCES invocations(id),
    thread_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
-- table authorization_audit
CREATE TABLE authorization_audit (
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
-- table authorization_rules
CREATE TABLE authorization_rules (
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
-- table compiler_leader
CREATE TABLE compiler_leader (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_term TEXT NOT NULL,
    leader_alias TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    renewed_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    reserved_1 TEXT,
    reserved_2 TEXT
  );
-- table invocations
CREATE TABLE invocations (
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
-- table message_commit_seq
CREATE TABLE message_commit_seq (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    committed_at TEXT NOT NULL
  );
-- table message_embeddings
CREATE TABLE message_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    chunk_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
-- table messages
CREATE TABLE messages (
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
-- table messages_fts
CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram case_sensitive 0'
  );
-- table messages_fts_config
CREATE TABLE 'messages_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
-- table messages_fts_data
CREATE TABLE 'messages_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
-- table messages_fts_docsize
CREATE TABLE 'messages_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
-- table messages_fts_idx
CREATE TABLE 'messages_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
-- table prompt_audit
CREATE TABLE prompt_audit (
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
-- table room_agent_sessions
CREATE TABLE room_agent_sessions (
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
-- table room_checkpoints
CREATE TABLE room_checkpoints (
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
-- table room_decisions
CREATE TABLE room_decisions (
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
-- table session_groups
CREATE TABLE session_groups (
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
-- table session_memories
CREATE TABLE session_memories (
    id TEXT PRIMARY KEY,
    session_group_id TEXT NOT NULL REFERENCES session_groups(id),
    summary TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
-- table tasks
CREATE TABLE tasks (
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
-- table thread_seal_events
CREATE TABLE thread_seal_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    sealed_at TEXT NOT NULL,
    fencing_token TEXT NOT NULL
  );
-- table threads
CREATE TABLE threads (
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
-- table wiki_entity_fts
CREATE VIRTUAL TABLE wiki_entity_fts USING fts5(
    path UNINDEXED,
    bucket UNINDEXED,
    name,
    body,
    content='wiki_entity_index',
    content_rowid='rowid',
    tokenize='trigram case_sensitive 0'
  );
-- table wiki_entity_fts_config
CREATE TABLE 'wiki_entity_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
-- table wiki_entity_fts_data
CREATE TABLE 'wiki_entity_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
-- table wiki_entity_fts_docsize
CREATE TABLE 'wiki_entity_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
-- table wiki_entity_fts_idx
CREATE TABLE 'wiki_entity_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
-- table wiki_entity_index
CREATE TABLE wiki_entity_index (
    path TEXT PRIMARY KEY,
    bucket TEXT NOT NULL,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
-- table wiki_events
CREATE TABLE wiki_events (
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
-- table wiki_fencing_seq
CREATE TABLE wiki_fencing_seq (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_value TEXT NOT NULL
  );
-- table wiki_leases
CREATE TABLE wiki_leases (
    path TEXT PRIMARY KEY,
    fencing_token TEXT NOT NULL,
    owner_alias TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    leader_term TEXT NOT NULL,
    reserved_1 TEXT,
    reserved_2 TEXT
  );
-- table wiki_memories
CREATE TABLE wiki_memories (
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
-- table workflow_sop
CREATE TABLE workflow_sop (
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
-- trigger messages_fts_ad
CREATE TRIGGER messages_fts_ad
  AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  END;
-- trigger messages_fts_ai
CREATE TRIGGER messages_fts_ai
  AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
-- trigger messages_fts_au
CREATE TRIGGER messages_fts_au
  AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
-- trigger reject_stale_leader
CREATE TRIGGER reject_stale_leader
    BEFORE INSERT ON wiki_events
    WHEN EXISTS (SELECT 1 FROM compiler_leader WHERE id = 1)
      AND CAST(NEW.leader_term AS INTEGER) < CAST((SELECT current_term FROM compiler_leader WHERE id = 1) AS INTEGER)
    BEGIN
      SELECT RAISE(ABORT, 'stale leader_term');
    END;
-- trigger wiki_entity_fts_ad
CREATE TRIGGER wiki_entity_fts_ad
  AFTER DELETE ON wiki_entity_index BEGIN
    INSERT INTO wiki_entity_fts(wiki_entity_fts, rowid, path, bucket, name, body)
    VALUES ('delete', old.rowid, old.path, old.bucket, old.name, old.body);
  END;
-- trigger wiki_entity_fts_ai
CREATE TRIGGER wiki_entity_fts_ai
  AFTER INSERT ON wiki_entity_index BEGIN
    INSERT INTO wiki_entity_fts(rowid, path, bucket, name, body)
    VALUES (new.rowid, new.path, new.bucket, new.name, new.body);
  END;
-- trigger wiki_entity_fts_au
CREATE TRIGGER wiki_entity_fts_au
  AFTER UPDATE ON wiki_entity_index BEGIN
    INSERT INTO wiki_entity_fts(wiki_entity_fts, rowid, path, bucket, name, body)
    VALUES ('delete', old.rowid, old.path, old.bucket, old.name, old.body);
    INSERT INTO wiki_entity_fts(rowid, path, bucket, name, body)
    VALUES (new.rowid, new.path, new.bucket, new.name, new.body);
  END;

-- wiki_entity_index rows
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/bugReport/B022-prompt-injection-redundancy.md', 'bugReport', 'B022-prompt-injection-redundancy', 'B022 prompt injection redundancy and L0_DIGEST drift fail-closed defense. Related to F011 backend injection contract.
');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/F004-prompt-assembly.md', 'concepts', 'F004-prompt-assembly', 'F004 assemblePrompt single injection contract. Reference-only sections include viewfinder, recall pack, handbook, collaboration contract, and capability digest.
');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/F011-backend-hardening-drizzle.md', 'concepts', 'F011-backend-hardening-drizzle', 'F011 drizzle 优化 backend hardening. drizzle migration safety and backfill safety. SELECT max plus INSERT wrapped in transaction to prevent TOCTOU. BEGIN IMMEDIATE serializes writes.');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/F015-dispatch-state-persistence.md', 'concepts', 'F015-dispatch-state-persistence', 'F015 dispatch state persistence depends on drizzle and backend persistence primitives.
');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/F018-session-bootstrap.md', 'concepts', 'F018-session-bootstrap', 'F018 SessionBootstrap continuation logic. ThreadMemory rolling summary and previous session prelude. New session injects reference-only context.
');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/F021-context-window-resolver.md', 'concepts', 'F021-context-window-resolver', 'F021 context window resolver and Seal thresholds. fillRatio metrics, context budget, prompt token budget, session seal awareness. It integrates with F018 ThreadMemory rolling summa');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/F026-a2a-reliability-layer.md', 'concepts', 'F026-a2a-reliability-layer', 'F026 A2A reliability layer for explicit Call tags and timeout tombstones.
');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/F027-unified-memory-architecture.md', 'concepts', 'F027-unified-memory-architecture', 'F027 unified memory architecture includes memory_preflight, viewfinder anti-drift, agent sessions ledger, and adaptive recall.
');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/P011-memory-preflight.md', 'concepts', 'P011-memory-preflight', 'P11 memory_preflight automatically recalls wiki memories before a wake-up task and renders Inspector output.
');
INSERT INTO wiki_entity_index(path,bucket,name,body_excerpt) VALUES ('wiki/concepts/R-205-room-history.md', 'concepts', 'R-205-room-history', 'R-205 discussion history: 桂芬 first wake-up asks about F011 drizzle 优化 and related context window tradeoffs.
');

-- BM25 primary query ranking
-- primary_rank=1 query='F011 drizzle 优化' path=wiki/concepts/F011-backend-hardening-drizzle.md score=1.000000 bm25_rank=-1.9023455429688858
-- primary_rank=2 query='F011 drizzle 优化' path=wiki/concepts/R-205-room-history.md score=0.000000 bm25_rank=-1.2759166888489812

-- memory_preflight aggregate BM25 ranking top 10
-- rank=1 source=task_summary query=F011 drizzle 优化 path=wiki/concepts/F011-backend-hardening-drizzle.md score=1.000000
-- rank=2 source=recent_messages query=F021 context window seal threshold drizzle path=wiki/concepts/F021-context-window-resolver.md score=1.000000
-- rank=3 source=task_summary query=F011 drizzle 优化 path=wiki/concepts/R-205-room-history.md score=0.000000
