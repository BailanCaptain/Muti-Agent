/**
 * F027 v3 G6 · GET /api/wiki/story — Wiki 哲学 UI 后端
 *
 * 真相源:
 *   - F027 v3 audit summary G6 (P0 愿景层) — 小孙 5-28 拍"本 feature 内补"
 *   - V16.5 chap 1-3 设计哲学 + chap 11-14 6 类记忆桶 + canonical_owner + supersede
 *   - schema wikiMemories (type/canonical_owner_path/supersedes/state) + roomDecisions
 *
 * 职责: 给前端 KB tab "Wiki 哲学" panel 提供 6 类桶 stats + 7 天增长曲线 + supersede 链。
 *
 * MVP 限制:
 *   - 不接 LLM compile pipeline 状态 (chap 26 3 阶段 pre/compile/post 历史)
 *     → 留独立 F-id 接 wiki_compile_runs 表
 *   - 不接 drift timeline (room_decisions tombstone + supersede 时序可视化)
 *     → 留独立 F-id 接专门的 drift_history 视图 API
 *
 * 6 类桶定义 (wiki_memories.type 枚举 + conversation 桶用 messages 表占位):
 *   - concept / rule / method / lesson / room / episode
 *   实际 schema (V16.5 chap 14 line 1571): room|project|user|feedback|work +
 *   conversation 用 messages (不冗余进 wiki_memories)。
 *   本 endpoint 暴露 wikiMemories.type 的真实 5 类 + 单算 conversation count(messages).
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import type { SqliteAdapterLike } from "../../wiki/room-compiler/sqlite-checkpoint-store"

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ── Response shape ────────────────────────────────────────────────────

export interface WikiBucketStat {
  /** 桶 type (V16.5 chap 14: room|project|user|feedback|work + 派生 conversation) */
  type: string
  /** 该桶 entity 总数 (state='canonical' + 'draft'，不含 deprecated) */
  totalCount: number
  /** 其中 canonical 数 (已审批正式) */
  canonicalCount: number
  /** 其中 draft 数 (未 promote) */
  draftCount: number
  /** Top N entity (按 updatedAt desc) — N=5；点开看 canonical_owner chain */
  topEntities: WikiEntitySummary[]
}

export interface WikiEntitySummary {
  id: number
  name: string
  canonicalOwnerPath: string
  state: string
  /** supersedes JSON 数组 (paths) — V16.5 chap 11 canonical_owner 链可视化 */
  supersedes: string[]
  updatedAt: string
}

export interface WikiGrowthPoint {
  /** ISO date (YYYY-MM-DD) */
  day: string
  /** 当日新增 entity 数 (wikiMemories.created_at = day) */
  entityNew: number
  /** 当日新增 decision 数 (room_decisions.decided_at = day) */
  decisionNew: number
}

export interface GetWikiStoryResponse {
  /** 6 类记忆桶 stats (固定顺序: room/project/user/feedback/work + conversation) */
  buckets: WikiBucketStat[]
  /** 全 wiki 总 entity 数 (state != 'deprecated') */
  totalEntities: number
  /** 全 room_decisions 总数 (含 tombstone — 决策事件计数) */
  totalDecisions: number
  /** 近 7 天每日 entity+decision 新增曲线 (按 day asc) */
  recent7d: WikiGrowthPoint[]
}

// ── Service ────────────────────────────────────────────────────────────

const BUCKET_TYPES = ["room", "project", "user", "feedback", "work"] as const
const TOP_ENTITY_LIMIT = 5

export interface WikiStoryServiceDeps {
  db: DrizzleDb
}

export class WikiStoryService {
  private readonly client: SqliteAdapterLike

  constructor(deps: WikiStoryServiceDeps) {
    this.client = (
      deps.db as unknown as { $client: SqliteAdapterLike }
    ).$client
  }

  getStory(): GetWikiStoryResponse {
    const buckets: WikiBucketStat[] = []
    let totalEntities = 0

    for (const type of BUCKET_TYPES) {
      const stat = this.queryBucket(type)
      buckets.push(stat)
      totalEntities += stat.totalCount
    }

    // V16.5 chap 14 line 1572: conversation 桶物理上由 messages 表承载 (不冗余)
    // 单独算 messages 总数表示 conversation bucket (此 row 没 topEntities — entity 概念不映射 message)
    const conversationCount = this.safeCount(
      "SELECT COUNT(*) AS n FROM messages WHERE role IN ('user','assistant')",
    )
    buckets.push({
      type: "conversation",
      totalCount: conversationCount,
      canonicalCount: conversationCount, // messages 不分 draft/canonical
      draftCount: 0,
      topEntities: [], // 不暴露 message-level entity (隐私 + 体积)
    })

    const totalDecisions = this.safeCount("SELECT COUNT(*) AS n FROM room_decisions")
    const recent7d = this.queryRecent7d()

    return {
      buckets,
      totalEntities,
      totalDecisions,
      recent7d,
    }
  }

  private queryBucket(type: string): WikiBucketStat {
    const counts = (this.client
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN state = 'canonical' THEN 1 ELSE 0 END) AS canonical,
           SUM(CASE WHEN state = 'draft' THEN 1 ELSE 0 END) AS draft
         FROM wiki_memories
         WHERE type = ?
           AND state != 'deprecated'`,
      )
      .get(type) ?? { total: 0, canonical: 0, draft: 0 }) as {
      total: number | null
      canonical: number | null
      draft: number | null
    }
    const topRows = (this.client
      .prepare(
        `SELECT id, name, canonical_owner_path, state, supersedes, updated_at
         FROM wiki_memories
         WHERE type = ?
           AND state != 'deprecated'
         ORDER BY datetime(updated_at) DESC
         LIMIT ?`,
      )
      .all(type, TOP_ENTITY_LIMIT) ?? []) as Array<{
      id: number
      name: string
      canonical_owner_path: string
      state: string
      supersedes: string | null
      updated_at: string
    }>
    return {
      type,
      totalCount: counts.total ?? 0,
      canonicalCount: counts.canonical ?? 0,
      draftCount: counts.draft ?? 0,
      topEntities: topRows.map((r) => ({
        id: r.id,
        name: r.name,
        canonicalOwnerPath: r.canonical_owner_path,
        state: r.state,
        supersedes: parseSupersedes(r.supersedes),
        updatedAt: r.updated_at,
      })),
    }
  }

  private queryRecent7d(): WikiGrowthPoint[] {
    // 近 7 天每日 entity 新增 + decision 新增
    const points: WikiGrowthPoint[] = []
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(today.getTime() - i * 24 * 3600 * 1000)
      const day = d.toISOString().slice(0, 10)
      const dayStart = `${day}T00:00:00.000Z`
      const dayEnd = `${day}T23:59:59.999Z`
      const entityNew = this.safeCount(
        "SELECT COUNT(*) AS n FROM wiki_memories WHERE datetime(created_at) BETWEEN datetime(?) AND datetime(?)",
        [dayStart, dayEnd],
      )
      const decisionNew = this.safeCount(
        "SELECT COUNT(*) AS n FROM room_decisions WHERE datetime(decided_at) BETWEEN datetime(?) AND datetime(?)",
        [dayStart, dayEnd],
      )
      points.push({ day, entityNew, decisionNew })
    }
    return points
  }

  private safeCount(sql: string, params: ReadonlyArray<unknown> = []): number {
    try {
      const row = (this.client.prepare(sql).get(...params) ?? { n: 0 }) as { n: number | null }
      return row.n ?? 0
    } catch {
      // 表不存在 / schema mismatch → 0 (fail-soft, G6 是 read-only stats endpoint)
      return 0
    }
  }
}

function parseSupersedes(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is string => typeof s === "string")
  } catch {
    return []
  }
}

// ── Route ──────────────────────────────────────────────────────────────

export function registerWikiStoryRoute(app: FastifyInstance, service: WikiStoryService): void {
  app.get("/api/wiki/story", async (_request, _reply) => {
    return service.getStory()
  })
}
