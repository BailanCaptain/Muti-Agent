/**
 * F027 P4 hotfix · GET /api/wiki/events?path=X&limit=N
 *
 * 真相源：V16.5 §5 line 452 + §18 line 2078 "[追溯 wiki_events]" 按钮
 *   - V16.5 §5: 所有 wiki 写操作走 append-only event log
 *   - V16.5 §18: Prompt Inspector 让小孙看 agent prompt 每段 part 来自哪条 wiki_events
 *
 * Query:
 *   - path  (required): wiki 文件 path (如 "wiki/rooms/R-011/viewfinder.md")
 *   - limit (optional): 默认 5, clamp [1, 50]
 *
 * Response:
 *   { events: Array<{ id, ts, alias, action, path, baseHash, contentHash,
 *                     sourceMessageIds, reason, state }> }
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface WikiEventDto {
  id: number
  ts: string
  alias: string
  action: string
  path: string
  baseHash: string | null
  contentHash: string | null
  attemptedHash: string | null
  sourceMessageIds: string[] | null
  reason: string | null
  state: string
}

export interface GetWikiEventsResponse {
  events: WikiEventDto[]
}

export function registerWikiEventsRoute(app: FastifyInstance, db: DrizzleDb): void {
  const repo = new WikiEventsRepository(db)
  app.get("/api/wiki/events", async (request, reply) => {
    const query = request.query as { path?: string; limit?: string }
    const path = (query.path ?? "").trim()
    if (!path) {
      reply.code(400)
      return { error: "INVALID_PATH", message: "query param 'path' required" }
    }
    let limit = 5
    const rawLimit = query.limit
    if (typeof rawLimit === "string" && rawLimit.length > 0) {
      const parsed = Number(rawLimit)
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50) {
        limit = Math.floor(parsed)
      }
    }
    try {
      const rows = repo.getByPath(path, limit)
      const events: WikiEventDto[] = rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        alias: r.alias,
        action: r.action,
        path: r.path,
        baseHash: r.baseHash,
        contentHash: r.contentHash,
        attemptedHash: r.attemptedHash,
        sourceMessageIds: r.sourceMessageIds,
        reason: r.reason,
        state: r.state,
      }))
      return { events } satisfies GetWikiEventsResponse
    } catch (err) {
      request.log.error({ err, path }, "wiki-events query threw")
      reply.code(500)
      return { error: "INTERNAL_ERROR", message: (err as Error).message }
    }
  })
}
