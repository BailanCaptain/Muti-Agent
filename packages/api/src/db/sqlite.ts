import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Provider } from "@multi-agent/shared";

/**
 * threads 表对应的领域记录。
 * 一条 thread 表示“某个 provider 在某个会话组里自己的会话线”。
 */
export type ProviderThreadRecord = {
  /** thread 主键。 */
  id: string;
  /** 这条 thread 属于哪个 session group。 */
  sessionGroupId: string;
  /** 这条 thread 对应哪个 provider。 */
  provider: Provider;
  /** 这条 thread 当前对外展示的别名。 */
  alias: string;
  /** 当前 thread 绑定的模型名。 */
  currentModel: string | null;
  /** 底层 CLI 的原生 session id，用于 resume。 */
  nativeSessionId: string | null;
  /** 这条 thread 最后一次被更新的时间。 */
  updatedAt: string;
};

/**
 * messages 表对应的记录。
 * 一条 message 只属于一个 thread。
 */
export type MessageRecord = {
  /** message 主键。 */
  id: string;
  /** 这条消息属于哪个 thread。 */
  threadId: string;
  /** 角色。user 是用户消息，assistant 是 agent 消息。 */
  role: "user" | "assistant";
  /** 消息正文。 */
  content: string;
  /** 消息创建时间。 */
  createdAt: string;
};

/**
 * invocations 表对应的记录。
 * invocation 不是会话，而是“某一次真实运行”。
 */
export type InvocationRecord = {
  /** invocation 主键，也是这次运行的身份 ID。 */
  id: string;
  /** 这次运行属于哪个 thread。 */
  threadId: string;
  /** 当前运行中的 agent 身份，例如别名或 agentId。 */
  agentId: string;
  /** callback API 使用的临时令牌，只属于本次运行。 */
  callbackToken: string;
  /** 运行状态，例如 running / replying / thinking / idle / error。 */
  status: string;
  /** 本次运行开始时间。 */
  startedAt: string;
  /** 本次运行结束时间；还在运行时为 null。 */
  finishedAt: string | null;
  /** 进程退出码；还没结束时可能为 null。 */
  exitCode: number | null;
  /** 最近一次 stdout / stderr 活动时间，用来判断是不是还活着。 */
  lastActivityAt: string | null;
};

/**
 * agent_events 表对应的记录。
 * 这是 invocation 的过程日志，不直接渲染给普通聊天时间线。
 */
export type AgentEventRecord = {
  /** 事件主键。 */
  id: string;
  /** 这条事件属于哪个 invocation。 */
  invocationId: string;
  /** 这条事件发生在哪个 thread。 */
  threadId: string;
  /** 这条事件属于哪个 agent。 */
  agentId: string;
  /** 事件类型，例如 invocation.started / invocation.activity.stdout。 */
  eventType: string;
  /** 事件附加数据，当前先以 JSON 字符串方式存储。 */
  payload: string;
  /** 事件记录时间。 */
  createdAt: string;
};

export class SqliteStore {
  /** Node 内置 sqlite 同步连接。当前项目的 repository 全部通过它访问数据库。 */
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
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
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
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
    `);

    try {
      this.db.exec(`ALTER TABLE invocations ADD COLUMN callback_token TEXT;`);
    } catch {
      // 老数据库升级时，这个字段可能已经存在。
    }
  }
}
