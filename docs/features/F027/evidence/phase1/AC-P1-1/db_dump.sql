-- sqlite_master dump from temporary DB created with createDrizzleDb()
-- index idx_prompt_audit on prompt_audit
CREATE INDEX idx_prompt_audit ON prompt_audit(alias, room_id, created_at);
-- index idx_room_decisions on room_decisions
CREATE INDEX idx_room_decisions ON room_decisions(room_id, decided_at);
-- index idx_room_decisions_status_type on room_decisions
CREATE INDEX idx_room_decisions_status_type ON room_decisions(room_id, decision_type, status);
-- index idx_wiki_events_alias on wiki_events
CREATE INDEX idx_wiki_events_alias ON wiki_events(alias, ts);
-- index idx_wiki_events_path on wiki_events
CREATE INDEX idx_wiki_events_path ON wiki_events(path, ts);
-- index idx_wiki_events_state on wiki_events
CREATE INDEX idx_wiki_events_state ON wiki_events(state, ts);
-- index idx_wiki_events_term on wiki_events
CREATE INDEX idx_wiki_events_term ON wiki_events(leader_term);
-- index idx_wiki_memories_canonical on wiki_memories
CREATE INDEX idx_wiki_memories_canonical ON wiki_memories(canonical_owner_path);
-- index idx_wiki_memories_state on wiki_memories
CREATE INDEX idx_wiki_memories_state ON wiki_memories(state, type);
-- index idx_wiki_memories_type on wiki_memories
CREATE INDEX idx_wiki_memories_type ON wiki_memories(type);
-- table prompt_audit on prompt_audit
CREATE TABLE prompt_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, alias TEXT NOT NULL, room_id TEXT, scenario TEXT NOT NULL, total_tokens INTEGER NOT NULL, cap INTEGER NOT NULL, parts_json TEXT NOT NULL, not_injected_json TEXT, iron_laws_count INTEGER NOT NULL, raw_text TEXT NOT NULL, source_event_ids TEXT, recall_queries TEXT, recall_results TEXT, recall_total_tokens INTEGER, recall_rejected_reasons TEXT, recall_required INTEGER NOT NULL DEFAULT 0, recall_trigger TEXT, recall_path INTEGER, top_score REAL, recall_satisfied INTEGER NOT NULL DEFAULT 0, escalate_reason TEXT, recall_total_ms INTEGER, recall_critique_calls INTEGER, recall_budget_exceeded INTEGER, agent_session_ref TEXT, reserved_1 TEXT, reserved_2 TEXT);
-- table room_decisions on room_decisions
CREATE TABLE room_decisions (decision_id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, decided_at TEXT NOT NULL, decided_by TEXT NOT NULL, decision_type TEXT NOT NULL, content TEXT NOT NULL, source_message_ids TEXT NOT NULL, source_quote TEXT NOT NULL, source_hash TEXT NOT NULL, tombstone INTEGER NOT NULL DEFAULT 0, superseded_by INTEGER, fencing_token TEXT NOT NULL, extractor_confidence REAL, coverage_check_passed INTEGER, status TEXT NOT NULL DEFAULT 'active', reserved_1 TEXT, reserved_2 TEXT);
-- table wiki_events on wiki_events
CREATE TABLE wiki_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, alias TEXT NOT NULL, action TEXT NOT NULL, path TEXT NOT NULL, base_hash TEXT, content_hash TEXT, attempted_hash TEXT, diff_summary TEXT, source_message_ids TEXT, promotion_target TEXT, reason TEXT, fencing_token TEXT NOT NULL, leader_term TEXT NOT NULL, result TEXT NOT NULL, error TEXT, state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'committed', 'aborted')), result_manifest_version TEXT, reserved_1 TEXT, reserved_2 TEXT);
-- table wiki_memories on wiki_memories
CREATE TABLE wiki_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK (type IN ('room', 'project', 'user', 'feedback', 'work')), name TEXT NOT NULL, canonical_owner_path TEXT NOT NULL, promotion_target TEXT, ttl_days INTEGER, supersedes TEXT, replaces_in_buckets TEXT, source_message_ids TEXT, contributed_by TEXT NOT NULL, cross_refs TEXT, dedup_decision TEXT, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'canonical', 'deprecated')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reserved_1 TEXT, reserved_2 TEXT);
-- trigger reject_stale_leader on wiki_events
CREATE TRIGGER reject_stale_leader BEFORE INSERT ON wiki_events WHEN EXISTS (SELECT 1 FROM compiler_leader WHERE id = 1) AND CAST(NEW.leader_term AS INTEGER) < CAST((SELECT current_term FROM compiler_leader WHERE id = 1) AS INTEGER) BEGIN SELECT RAISE(ABORT, 'stale leader_term'); END;
-- EXPLAIN viewfinder failed/timeout query
{"detail":"SEARCH a2a_calls USING INDEX idx_a2a_calls_session_status_updated (session_group_id=? AND status=?)"}
{"detail":"USE TEMP B-TREE FOR ORDER BY"}