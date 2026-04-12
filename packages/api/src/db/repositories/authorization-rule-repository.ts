import crypto from "node:crypto"
import type { SqliteStore } from "../sqlite"

export type AuthorizationRuleRow = {
  id: string
  provider: string
  action: string
  scope: "thread" | "global"
  decision: "allow" | "deny"
  thread_id: string | null
  session_group_id: string | null
  created_at: string
  created_by: string
  reason: string | null
}

export class AuthorizationRuleRepository {
  constructor(private readonly store: SqliteStore) {}

  add(input: {
    provider: string
    action: string
    scope: "thread" | "global"
    decision: "allow" | "deny"
    threadId?: string
    sessionGroupId?: string
    createdBy: string
    reason?: string
  }): AuthorizationRuleRow {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const stmt = this.store.db.prepare(`
      INSERT INTO authorization_rules (id, provider, action, scope, decision, thread_id, session_group_id, created_at, created_by, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id,
      input.provider,
      input.action,
      input.scope,
      input.decision,
      input.threadId ?? null,
      input.sessionGroupId ?? null,
      now,
      input.createdBy,
      input.reason ?? null,
    )
    return {
      id,
      provider: input.provider,
      action: input.action,
      scope: input.scope,
      decision: input.decision,
      thread_id: input.threadId ?? null,
      session_group_id: input.sessionGroupId ?? null,
      created_at: now,
      created_by: input.createdBy,
      reason: input.reason ?? null,
    }
  }

  remove(ruleId: string): boolean {
    const stmt = this.store.db.prepare("DELETE FROM authorization_rules WHERE id = ?")
    const result = stmt.run(ruleId)
    return result.changes > 0
  }

  list(filter?: { provider?: string; threadId?: string }): AuthorizationRuleRow[] {
    if (filter?.provider && filter?.threadId) {
      return this.store.db
        .prepare(
          "SELECT * FROM authorization_rules WHERE (provider = ? OR provider = '*') AND (thread_id = ? OR thread_id IS NULL) ORDER BY created_at DESC",
        )
        .all(filter.provider, filter.threadId) as AuthorizationRuleRow[]
    }
    if (filter?.provider) {
      return this.store.db
        .prepare(
          "SELECT * FROM authorization_rules WHERE provider = ? OR provider = '*' ORDER BY created_at DESC",
        )
        .all(filter.provider) as AuthorizationRuleRow[]
    }
    return this.listAll()
  }

  listAll(): AuthorizationRuleRow[] {
    return this.store.db
      .prepare("SELECT * FROM authorization_rules ORDER BY rowid DESC")
      .all() as AuthorizationRuleRow[]
  }
}
