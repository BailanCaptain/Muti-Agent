import crypto from "node:crypto";
import type { Provider } from "@multi-agent/shared";
import { PROVIDER_ALIASES, PROVIDERS } from "@multi-agent/shared";
import { SqliteStore, type MessageRecord, type ProviderThreadRecord } from "./sqlite";

type SessionGroupRow = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export class SessionRepository {
  constructor(private readonly store: SqliteStore) {}

  listSessionGroups() {
    const groups = this.store.db
      .prepare(
        `SELECT id, title, created_at as createdAt, updated_at as updatedAt
         FROM session_groups
         ORDER BY updated_at DESC`
      )
      .all() as SessionGroupRow[];

    return groups.map((group) => {
      const threads = this.listThreadsByGroup(group.id);
      return {
        ...group,
        previews: threads.map((thread) => ({
          provider: thread.provider,
          alias: thread.alias,
          text: this.getLastMessagePreview(thread.id)
        }))
      };
    });
  }

  createSessionGroup(title?: string) {
    const now = new Date().toISOString();
    const sessionGroupId = crypto.randomUUID();

    this.store.db
      .prepare(
        `INSERT INTO session_groups (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(sessionGroupId, title ?? `三方会话 ${now.slice(0, 19).replace("T", " ")}`, now, now);

    return sessionGroupId;
  }

  createThread(sessionGroupId: string, provider: Provider, currentModel: string | null) {
    const now = new Date().toISOString();
    const threadId = crypto.randomUUID();

    this.store.db
      .prepare(
        `INSERT INTO threads (id, session_group_id, provider, alias, current_model, native_session_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(threadId, sessionGroupId, provider, PROVIDER_ALIASES[provider], currentModel, null, now);

    return threadId;
  }

  ensureDefaultThreads(sessionGroupId: string, defaults: Record<Provider, string | null>) {
    PROVIDERS.forEach((provider) => {
      const existing = this.store.db
        .prepare(`SELECT id FROM threads WHERE session_group_id = ? AND provider = ? LIMIT 1`)
        .get(sessionGroupId, provider) as { id: string } | undefined;

      if (!existing) {
        this.createThread(sessionGroupId, provider, defaults[provider]);
      }
    });
  }

  listThreadsByGroup(sessionGroupId: string) {
    return this.store.db
      .prepare(
        `SELECT id, session_group_id as sessionGroupId, provider, alias, current_model as currentModel,
                native_session_id as nativeSessionId, updated_at as updatedAt
         FROM threads
         WHERE session_group_id = ?
         ORDER BY provider ASC`
      )
      .all(sessionGroupId) as ProviderThreadRecord[];
  }

  getThreadById(threadId: string) {
    return this.store.db
      .prepare(
        `SELECT id, session_group_id as sessionGroupId, provider, alias, current_model as currentModel,
                native_session_id as nativeSessionId, updated_at as updatedAt
         FROM threads
         WHERE id = ?
         LIMIT 1`
      )
      .get(threadId) as ProviderThreadRecord | undefined;
  }

  listMessages(threadId: string) {
    return this.store.db
      .prepare(
        `SELECT id, thread_id as threadId, role, content, created_at as createdAt
         FROM messages
         WHERE thread_id = ?
         ORDER BY created_at ASC`
      )
      .all(threadId) as MessageRecord[];
  }

  appendMessage(threadId: string, role: "user" | "assistant", content: string) {
    const message: MessageRecord = {
      id: crypto.randomUUID(),
      threadId,
      role,
      content,
      createdAt: new Date().toISOString()
    };

    this.store.db
      .prepare(
        `INSERT INTO messages (id, thread_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(message.id, message.threadId, message.role, message.content, message.createdAt);

    this.touchThread(threadId, message.createdAt);
    return message;
  }

  overwriteMessage(messageId: string, content: string) {
    this.store.db.prepare(`UPDATE messages SET content = ? WHERE id = ?`).run(content, messageId);
  }

  updateThread(threadId: string, updates: { currentModel?: string | null; nativeSessionId?: string | null }) {
    const currentModel = updates.currentModel ?? null;
    const nativeSessionId = updates.nativeSessionId ?? null;
    const updatedAt = new Date().toISOString();

    this.store.db
      .prepare(
        `UPDATE threads
         SET current_model = ?, native_session_id = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(currentModel, nativeSessionId, updatedAt, threadId);

    this.touchThread(threadId, updatedAt);
  }

  reconcileLegacyDefaultModels(replacements: Record<Provider, { from: string[]; to: string | null }>) {
    const updatedAt = new Date().toISOString();

    for (const provider of PROVIDERS) {
      const replacement = replacements[provider];
      if (!replacement?.to || !replacement.from.length) {
        continue;
      }

      const placeholders = replacement.from.map(() => "?").join(", ");
      this.store.db
        .prepare(
          `UPDATE threads
           SET current_model = ?, updated_at = ?
           WHERE provider = ?
             AND current_model IN (${placeholders})`
        )
        .run(replacement.to, updatedAt, provider, ...replacement.from);
    }
  }

  private touchThread(threadId: string, updatedAt: string) {
    this.store.db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(updatedAt, threadId);

    const row = this.store.db
      .prepare(`SELECT session_group_id as sessionGroupId FROM threads WHERE id = ? LIMIT 1`)
      .get(threadId) as { sessionGroupId: string } | undefined;

    if (row) {
      this.store.db
        .prepare(`UPDATE session_groups SET updated_at = ? WHERE id = ?`)
        .run(updatedAt, row.sessionGroupId);
    }
  }

  private getLastMessagePreview(threadId: string) {
    const row = this.store.db
      .prepare(
        `SELECT content
         FROM messages
         WHERE thread_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(threadId) as { content: string } | undefined;

    return row?.content.slice(0, 80) ?? "";
  }
}
