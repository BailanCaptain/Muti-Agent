/**
 * F027 v3 G6 · GET /api/wiki/story — Wiki 哲学 UI 后端
 *
 * 真相源:
 *   - F027 v3 audit summary G6 (P0 愿景层) — 小孙 5-28 拍"本 feature 内补"
 *   - V16.5 chap 1-3 设计哲学 + chap 11-14 6 类记忆桶 + canonical_owner + supersede
 *   - roomDecisions (decision ledger) + messages (conversation) — wiki_memories 表已砍
 *
 * 职责: 给前端 KB tab "Wiki 哲学" panel 提供 6 类桶 stats + 7 天增长曲线 + supersede 链。
 *
 * MVP 限制:
 *   - 不接 LLM compile pipeline 状态 (chap 26 3 阶段 pre/compile/post 历史)
 *     → 留独立 F-id 接 wiki_compile_runs 表
 *   - 不接 drift timeline (room_decisions tombstone + supersede 时序可视化)
 *     → 留独立 F-id 接专门的 drift_history 视图 API
 *
 * 6 类桶定义 (V16.5 chap 14): room|project|user|feedback|work + conversation(messages).
 *
 * ⚠️ F027 chunk B：wiki_memories 表已砍（冗余第二存储；记忆 = 文件单一真相源）。
 *   - 5 个结构化记忆类型桶（room/project/user/feedback/work）目前**无数据源** ——
 *     结构化记忆文件由 LLM compile pipeline (G11) 写，该 pipeline 尚未接线，所以
 *     真实计数 = 0。本 endpoint 返 0（诚实反映"结构化记忆层未填"），不再查已删的表。
 *     G11 接入后改这里 → 扫文件 frontmatter 按 type 聚合（不重建表）。
 *   - conversation 桶（messages）+ 增长曲线 decisionNew（room_decisions）仍是真数据。
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
  /** 当日新增 entity 数（wiki_memories 表已砍 → 恒 0，待 G11 compile pipeline 接文件源） */
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
      // F027 chunk B：表已砍，结构化记忆桶返 0（见 emptyBucket / 类 doc）。
      const stat = this.emptyBucket(type)
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

  /**
   * F027 chunk B：wiki_memories 表已砍 → 结构化记忆类型桶无数据源，返空（0）。
   * 不再查表（避免 no-such-table 抛错）。G11 compile pipeline 接入后改为扫文件聚合。
   */
  private emptyBucket(type: string): WikiBucketStat {
    return {
      type,
      totalCount: 0,
      canonicalCount: 0,
      draftCount: 0,
      topEntities: [],
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
      // F027 chunk B：wiki_memories 表已砍 → entityNew 无数据源，恒 0（不查已删表）。
      const entityNew = 0
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
    } catch (err) {
      // G6 r2 (codex P2 修): fail-soft 只对真"空数据"返 0，不掩盖基础设施问题。
      // "no such table" / "no such column" 是 schema mismatch / 未跑迁移，
      // 应抛错让 UI 显 error 而不是伪装"0 数据"（削弱观测可信度）。
      const msg = (err as Error).message ?? ""
      if (/no such (table|column)/i.test(msg)) {
        throw err
      }
      // 其他错（rare: SQL syntax / lock 等）仍 fail-soft 0，避免单一 query 挂整个 endpoint
      return 0
    }
  }
}

// ── Route ──────────────────────────────────────────────────────────────

export function registerWikiStoryRoute(app: FastifyInstance, service: WikiStoryService): void {
  app.get("/api/wiki/story", async (_request, _reply) => {
    return service.getStory()
  })
}
