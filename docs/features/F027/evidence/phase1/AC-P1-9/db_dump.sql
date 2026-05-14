-- AC-P1-9 DB contract evidence: 5 physical wiki_memories buckets + 1 messages-backed conversation bucket
CREATE INDEX idx_messages_a2a_call_id ON messages(a2a_call_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_wiki_memories_canonical ON wiki_memories(canonical_owner_path);
CREATE INDEX idx_wiki_memories_state ON wiki_memories(state, type);
CREATE INDEX idx_wiki_memories_type ON wiki_memories(type);
CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), role TEXT NOT NULL, content TEXT NOT NULL, thinking TEXT NOT NULL DEFAULT '', message_type TEXT NOT NULL DEFAULT 'final', connector_source TEXT, group_id TEXT, group_role TEXT, tool_events TEXT NOT NULL DEFAULT '[]', content_blocks TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, model TEXT, retry_count INTEGER NOT NULL DEFAULT 0, retry_reasons TEXT NOT NULL DEFAULT '[]', a2a_call_id TEXT);
CREATE TABLE wiki_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL CHECK (type IN ('room', 'project', 'user', 'feedback', 'work')), name TEXT NOT NULL, canonical_owner_path TEXT NOT NULL, promotion_target TEXT, ttl_days INTEGER, supersedes TEXT, replaces_in_buckets TEXT, source_message_ids TEXT, contributed_by TEXT NOT NULL, cross_refs TEXT, dedup_decision TEXT, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'canonical', 'deprecated')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reserved_1 TEXT, reserved_2 TEXT);
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); END;
-- Segment mapping: room/project/user/feedback/work live in wiki_memories; conversation live in messages and FTS mirrors message content for recall.