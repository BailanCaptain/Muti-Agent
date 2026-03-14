import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Provider } from "@multi-agent/shared";

export type ProviderThreadRecord = {
  id: string;
  sessionGroupId: string;
  provider: Provider;
  alias: string;
  currentModel: string | null;
  nativeSessionId: string | null;
  updatedAt: string;
};

export type MessageRecord = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export class SqliteStore {
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
    `);
  }
}
