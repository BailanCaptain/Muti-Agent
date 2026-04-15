import crypto from "node:crypto"
import { eq, and, or, desc, sql } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { authorizationRules } from "../schema"

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

type DrizzleDb = BetterSQLite3Database<typeof import("../schema")>

function toRow(r: typeof authorizationRules.$inferSelect): AuthorizationRuleRow {
  return {
    id: r.id,
    provider: r.provider,
    action: r.action,
    scope: r.scope as "thread" | "global",
    decision: r.decision as "allow" | "deny",
    thread_id: r.threadId,
    session_group_id: r.sessionGroupId,
    created_at: r.createdAt,
    created_by: r.createdBy,
    reason: r.reason,
  }
}

export class DrizzleAuthorizationRuleRepository {
  constructor(private readonly db: DrizzleDb) {}

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

    this.db
      .insert(authorizationRules)
      .values({
        id,
        provider: input.provider,
        action: input.action,
        scope: input.scope,
        decision: input.decision,
        threadId: input.threadId ?? null,
        sessionGroupId: input.sessionGroupId ?? null,
        createdAt: now,
        createdBy: input.createdBy,
        reason: input.reason ?? null,
      })
      .run()

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
    const result = this.db
      .delete(authorizationRules)
      .where(eq(authorizationRules.id, ruleId))
      .run()
    return result.changes > 0
  }

  list(filter?: { provider?: string; threadId?: string }): AuthorizationRuleRow[] {
    if (filter?.provider && filter?.threadId) {
      return this.db
        .select()
        .from(authorizationRules)
        .where(
          and(
            or(eq(authorizationRules.provider, filter.provider), eq(authorizationRules.provider, "*")),
            or(eq(authorizationRules.threadId, filter.threadId), sql`${authorizationRules.threadId} IS NULL`),
          ),
        )
        .orderBy(desc(authorizationRules.createdAt))
        .all()
        .map(toRow)
    }
    if (filter?.provider) {
      return this.db
        .select()
        .from(authorizationRules)
        .where(
          or(eq(authorizationRules.provider, filter.provider), eq(authorizationRules.provider, "*")),
        )
        .orderBy(desc(authorizationRules.createdAt))
        .all()
        .map(toRow)
    }
    return this.listAll()
  }

  listAll(): AuthorizationRuleRow[] {
    return this.db
      .select()
      .from(authorizationRules)
      .orderBy(sql`rowid DESC`)
      .all()
      .map(toRow)
  }
}
