/**
 * F027 P14.b · messages_fts query repository
 * 真相源：docs/plans/V16.5-final.md chap 21 P14 + chap 22 "query_messages MCP"
 *
 * messages_fts 是 P14.b 新增的 contentless FTS5 虚拟表（content='messages'），
 * indexer 不显式跑，触发器 + first-time backfill 自动同步。本 repository 提供
 * 同步 query 接口给 memory_preflight P11.b + MCP server query_messages tool 调。
 *
 * 设计：
 *   1. sanitizeFtsQuery + normalizeBm25Corpus 复用 P14.a（同 SQLite 行为）
 *   2. roomId 过滤走 JOIN threads + session_groups（多 thread 的 room 聚合召回）
 *   3. threadId 过滤走 WHERE messages.thread_id（thread 内独立召回）
 *   4. JOIN messages ON messages.rowid = messages_fts.rowid 取 metadata
 *   5. role 过滤可选（agent 想限 user/assistant 时用）
 *   6. fail-soft：fts5 syntax error / sanitize 后空 query → 返 []，不抛
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import { sanitizeFtsQuery } from "./fts-query-sanitize"
import { normalizeBm25Corpus } from "./wiki-entity-fts-provider"

type DrizzleDb = BetterSQLite3Database<typeof schema>

const DEFAULT_TOP_K = 10
const MAX_TOP_K = 100

export type MessagesFtsHit = {
  messageId: string
  threadId: string
  role: string
  content: string
  createdAt: string
  bm25Rank: number
  /** corpus-内 min-max 归一化 [0, 1]，最强 hit 永远 1 */
  score: number
}

export type QueryMessagesOptions = {
  /** 限定房间（聚合该 room 下所有 thread 的 messages） */
  roomId?: string
  /** 限定 thread（单 thread 内召回） */
  threadId?: string
  /** 限定 role（user / assistant / connector / ...） */
  role?: string
  /** 返回 topK，默认 10，最大 100 */
  topK?: number
  /** 是否对 query 做 sanitize（FTS5 phrase quote 化），默认 true */
  sanitizeQuery?: boolean
}

export class MessagesFtsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * 同步 FTS5 query。fail-soft：FTS5 syntax error 或 sanitize 后空 query → 返 []。
   * 不依赖 transaction，纯读路径。
   */
  query(rawQuery: string, opts: QueryMessagesOptions = {}): MessagesFtsHit[] {
    const safe = (opts.sanitizeQuery ?? true) ? sanitizeFtsQuery(rawQuery) : rawQuery
    if (safe.length === 0) return []
    const topK = Math.min(MAX_TOP_K, Math.max(1, opts.topK ?? DEFAULT_TOP_K))

    const rawDb = (this.db as unknown as { $client: { prepare(sql: string): unknown } }).$client

    // 动态拼 SQL：roomId / threadId / role 任意组合
    // SAFETY: 所有过滤值走参数化（?），不拼接字符串
    const where: string[] = ["messages_fts MATCH ?"]
    const params: unknown[] = [safe]

    let joinSessions = false
    if (opts.roomId) {
      where.push("sg.room_id = ?")
      params.push(opts.roomId)
      joinSessions = true
    }
    if (opts.threadId) {
      where.push("m.thread_id = ?")
      params.push(opts.threadId)
    }
    if (opts.role) {
      where.push("m.role = ?")
      params.push(opts.role)
    }
    params.push(topK)

    const sql = `
      SELECT m.id AS messageId,
             m.thread_id AS threadId,
             m.role AS role,
             m.content AS content,
             m.created_at AS createdAt,
             bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      ${joinSessions ? "JOIN threads t ON t.id = m.thread_id JOIN session_groups sg ON sg.id = t.session_group_id" : ""}
      WHERE ${where.join(" AND ")}
      ORDER BY rank ASC
      LIMIT ?
    `

    let rows: Array<{
      messageId: string
      threadId: string
      role: string
      content: string
      createdAt: string
      rank: number
    }>
    try {
      const stmt = rawDb.prepare(sql) as {
        all(...args: unknown[]): Array<{
          messageId: string
          threadId: string
          role: string
          content: string
          createdAt: string
          rank: number
        }>
      }
      rows = stmt.all(...params)
    } catch (err) {
      // FTS5 syntax error 等 → fail-soft 返空（sanitize 已尽力清，二次兜底）
      if (err instanceof Error && /fts5/i.test(err.message)) return []
      throw err
    }

    const ranks = rows.map((r) => r.rank)
    return rows.map((r) => ({
      messageId: r.messageId,
      threadId: r.threadId,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt,
      bm25Rank: r.rank,
      score: normalizeBm25Corpus(r.rank, ranks),
    }))
  }
}
