import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Provider } from "@multi-agent/shared"
import { applyA2AWorklistsTreeMigration } from "./a2a-worklists-tree-migration"

export type ProviderThreadRecord = {
  id: string
  sessionGroupId: string
  provider: Provider
  alias: string
  currentModel: string | null
  nativeSessionId: string | null
  sopBookmark: string | null
  lastFillRatio: number | null
  // F019: nullable feature binding used by WorkflowSop state machine.
  backlogItemId: string | null
  updatedAt: string
}

export type MessageType =
  | "progress"
  | "final"
  | "a2a_handoff"
  | "a2a_handoff_mcp"
  | "connector"
  | "system_notice"

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
  // F021 Phase 5: per-message resolved model snapshot. Frozen at append time
  // so historical bubbles stay stable when global/session config later changes.
  // Null for legacy rows (pre-F021) and user/connector messages.
  model: string | null
  // F026 P3.1: 派发协议 retry 计数与原因（assistant final 入库前 hook 写入）
  retryCount: number
  /** JSON 数组字符串，按 attempt 顺序追加 dispatch validation reason */
  retryReasons: string
  // F026 P5 T0 · A2A 关联键（仅 a2a 派发产生的 connector message 写入）
  a2aCallId: string | null
  // F026 P5 T0 · LEFT JOIN a2a_calls 取协议字段（hydrateMessage 填充）
  a2aParentCallId: string | null
  a2aRootCallId: string | null
  a2aOnBehalfOf: string | null
  a2aConvenerId: string | null
  a2aCallStatus: string | null
  a2aDeadlineAt: string | null
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
  // F021 Phase 3.3: frozen per-provider runtime config (JSON stringified) at invocation start.
  configSnapshot?: string | null
}

export type AgentEventRecord = {
  id: string
  /**
   * F026 P5 T4 · invocation_id 改 nullable — DiscussionCoordinator / mention-router
   * gray-zone 等系统级事件没有归属 invocation，传 null 即可（schema rebuild 已支持）。
   */
  invocationId: string | null
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
        session_group_id TEXT NOT NULL,
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
        created_at TEXT NOT NULL,
        model TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        retry_reasons TEXT NOT NULL DEFAULT '[]'
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
        last_activity_at TEXT,
        config_snapshot TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        invocation_id TEXT,
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
    `)

    // F026 ADR-002 Call Tree — Round 2 Phase 1 协议真相源
    this.db.exec(`
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
    `)

    // F026 P2 v2 · a2a_worklists 树形收敛模型（同构 a2a_calls.parent_call_id）。
    // parent_worklist_id 自引用，root worklist 时为 NULL。settle 不变量：
    // items 全 done **且** 子 worklist 全 settled — 见 worklist-registry.ts。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS a2a_worklists (
        worklist_id TEXT PRIMARY KEY,
        parent_worklist_id TEXT,
        parent_call_id TEXT NOT NULL,
        root_call_id TEXT NOT NULL,
        session_group_id TEXT NOT NULL,
        items TEXT NOT NULL,
        current_index INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('active','settled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (parent_worklist_id) REFERENCES a2a_worklists(worklist_id)
      );
    `)

    // F026 P2 clean-cut Step 3 · ParallelGroupRegistry 整删，新建 DB 不再
    // 创建 parallel_groups 表。老 DB 已有该表保留为死表，drizzle 不读，
    // 后续 cleanup migration 单独操作（不在本步范围）。

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
      CREATE INDEX IF NOT EXISTS idx_workflow_sop_feature_id ON workflow_sop(feature_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_sop_stage ON workflow_sop(stage);
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_parent ON a2a_calls(parent_call_id);
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_root ON a2a_calls(root_call_id);
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_status_deadline ON a2a_calls(status, deadline_at);
      CREATE INDEX IF NOT EXISTS idx_a2a_calls_session_group ON a2a_calls(session_group_id);
      -- idx_a2a_worklists_parent_worklist 由 applyA2AWorklistsTreeMigration()
      -- 在 ADD COLUMN parent_worklist_id 之后建（单一真相源）。老库表存在但列
      -- 不存在时，在此 INIT_SQL 阶段建该索引会炸 "no such column" SQL logic error.
      CREATE INDEX IF NOT EXISTS idx_a2a_worklists_parent_call_active ON a2a_worklists(parent_call_id, status);
      CREATE INDEX IF NOT EXISTS idx_a2a_worklists_root_status ON a2a_worklists(root_call_id, status);
    `)

    // Idempotent ALTER TABLE for pre-existing databases. CREATE TABLE IF NOT
    // EXISTS does not back-fill columns on already-existing tables, so each
    // new column needs its own ALTER with duplicate-column-name tolerance.
    this.runAlterMigrations()
    this.runRebuildMigrations()
    applyA2AWorklistsTreeMigration(this.db)
  }

  /**
   * F026 P5 T4 · 列约束 rebuild migrations。
   *
   * SQLite 不支持 `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL`，标准做法是
   * rebuild：建临时表 → 复制全数据 → DROP 旧表 → RENAME 新表（保留所有数据，
   * 事务保护）。每条 migration 自己负责 `pre-check`（PRAGMA table_info）幂等检测
   * — 已 nullable 的 schema 不会重复 rebuild。
   *
   * 触发场景：升级老 DB（在 T4 之前 deploy 过 agent_events 表的实例）。
   */
  private runRebuildMigrations(): void {
    // F026 P5 T4 · agent_events.invocation_id NOT NULL → nullable
    //   原因：DiscussionCoordinator / mention-router gray-zone 这类系统级事件
    //   没有归属 invocation —— P5 T1B 把持久化挪到 T4 等的就是这条 migration。
    if (this.columnIsNotNull("agent_events", "invocation_id")) {
      this.db.exec(`
        BEGIN TRANSACTION;
        CREATE TABLE agent_events_new (
          id TEXT PRIMARY KEY,
          invocation_id TEXT,
          thread_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO agent_events_new (id, invocation_id, thread_id, agent_id, event_type, payload, created_at)
          SELECT id, invocation_id, thread_id, agent_id, event_type, payload, created_at FROM agent_events;
        DROP TABLE agent_events;
        ALTER TABLE agent_events_new RENAME TO agent_events;
        CREATE INDEX IF NOT EXISTS idx_agent_events_invocation_id ON agent_events(invocation_id);
        CREATE INDEX IF NOT EXISTS idx_agent_events_thread_id ON agent_events(thread_id);
        COMMIT;
      `)
    }
  }

  /** PRAGMA table_info(<table>) → column 是否 NOT NULL（notnull=1）。 */
  private columnIsNotNull(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
      notnull: number
    }>
    const row = rows.find((r) => r.name === column)
    return row ? row.notnull === 1 : false
  }

  private runAlterMigrations(): void {
    const alters: ReadonlyArray<{ name: string; sql: string }> = [
      // F018 AC8.1: ThreadMemory rolling summary persistence column
      {
        name: "F018-threads-add-thread-memory",
        sql: "ALTER TABLE threads ADD COLUMN thread_memory TEXT",
      },
      // F018 P3 AC3.5: session chain index for Bootstrap identity section
      {
        name: "F018-threads-add-session-chain-index",
        sql: "ALTER TABLE threads ADD COLUMN session_chain_index INTEGER NOT NULL DEFAULT 1",
      },
      // F019 P2: thread → feature binding for WorkflowSop state machine
      {
        name: "F019-threads-add-backlog-item-id",
        sql: "ALTER TABLE threads ADD COLUMN backlog_item_id TEXT",
      },
      // F021 Phase 2.2: per-session runtime config override
      {
        name: "F021-session-groups-add-runtime-config",
        sql: "ALTER TABLE session_groups ADD COLUMN runtime_config TEXT",
      },
      // F021 Phase 3.3: frozen per-invocation config snapshot (JSON)
      {
        name: "F021-invocations-add-config-snapshot",
        sql: "ALTER TABLE invocations ADD COLUMN config_snapshot TEXT",
      },
      // F022 Phase 1: 全局递增 ROOM ID (R-001, R-002, ...)
      {
        name: "F022-session-groups-add-room-id",
        sql: "ALTER TABLE session_groups ADD COLUMN room_id TEXT",
      },
      // F022 Phase 3.5: AC-14g/i/j — 手动命名锁 + 归档 + 软删
      {
        name: "F022-session-groups-add-title-locked-at",
        sql: "ALTER TABLE session_groups ADD COLUMN title_locked_at TEXT",
      },
      {
        name: "F022-session-groups-add-archived-at",
        sql: "ALTER TABLE session_groups ADD COLUMN archived_at TEXT",
      },
      {
        name: "F022-session-groups-add-deleted-at",
        sql: "ALTER TABLE session_groups ADD COLUMN deleted_at TEXT",
      },
      // F022 Phase 3.5: Haiku 失败计数
      {
        name: "F022-session-groups-add-title-backfill-attempts",
        sql: "ALTER TABLE session_groups ADD COLUMN title_backfill_attempts INTEGER NOT NULL DEFAULT 0",
      },
      // F021 Phase 5: per-message resolved model snapshot (chat bubble pill)
      {
        name: "F021-messages-add-model",
        sql: "ALTER TABLE messages ADD COLUMN model TEXT",
      },
      // F026 P3.1: assistant final 派发协议 retry 兜底层
      {
        name: "F026-P3.1-messages-add-retry-count",
        sql: "ALTER TABLE messages ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
      },
      {
        name: "F026-P3.1-messages-add-retry-reasons",
        sql: "ALTER TABLE messages ADD COLUMN retry_reasons TEXT NOT NULL DEFAULT '[]'",
      },
      // F026 P5 T0 · messages.a2a_call_id —— 前端 10 原语 LEFT JOIN a2a_calls 入口
      {
        name: "F026-P5-T0-messages-add-a2a-call-id",
        sql: "ALTER TABLE messages ADD COLUMN a2a_call_id TEXT",
      },
      {
        name: "F026-P5-T0-messages-idx-a2a-call-id",
        sql: "CREATE INDEX IF NOT EXISTS idx_messages_a2a_call_id ON messages(a2a_call_id)",
      },
    ]
    for (const m of alters) {
      try {
        this.db.exec(m.sql)
      } catch (err) {
        const msg = String((err as { message?: unknown })?.message ?? err)
        if (!/duplicate column name/i.test(msg)) throw err
      }
    }
  }
}
