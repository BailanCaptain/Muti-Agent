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
 *
 * F027 续 · 5 桶接文件真数据源（backfill 后 wiki_entity_index 已有真内容）：
 *   - 结构化桶 ← wiki_entity_index 按 bucket 目录映射（chap 14 桶定义表的官方路径）：
 *       rooms/ → room；concepts/ → project；people/ → user；feedback/ → feedback。
 *       work 桶恒 0：chap 14 把工作发现也归 `wiki/concepts/`，与项目记忆按目录不可分，
 *       计数并入 project（不脑补 frontmatter taxonomy；等 type 字段约定落地再拆）。
 *       其他 bucket（rules/methods/archive/warnings…）不进 5 桶但计入 totalEntities。
 *   - state：path 含 '/draft/' → draft，否则 canonical（文件时代 canonical = 非 draft 路径，
 *     与 NightlyHealthCheck duplicateCanonical 判定同口径）。
 *   - topEntities：每桶按 indexedAt desc 前 5，frontmatter（canonical_owner_path/supersedes)
 *     仅对这 5 条解析（全表 parse 没必要）。
 *   - 增长曲线 entityNew ← wiki_events action IN ('write','ingest') AND state='committed'
 *     按日计数（真实写入审计源；indexedAt 是索引时间会被 boot 全量刷新，不能当创建时间）。
 *   - conversation 桶（messages）+ decisionNew（room_decisions）不变，仍是真数据。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import { parseFrontmatter } from "../../services/scheduler/wiki-scanners"
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

/**
 * chap 14 结构化桶 type → wiki_entity_index.bucket（第一层目录）。
 * work 无目录：chap 14 把工作发现也归 concepts/，按目录与 project 不可分 → 计数并入
 * project，work 桶恒 0（不脑补 frontmatter taxonomy）。
 */
const BUCKET_TYPE_TO_DIR: Partial<Record<(typeof BUCKET_TYPES)[number], string>> = {
  room: "rooms",
  project: "concepts",
  user: "people",
  feedback: "feedback",
}

function isDraftPath(p: string): boolean {
  return p.replace(/\\/g, "/").includes("/draft/")
}

interface EntityRow {
  path: string
  bucket: string
  name: string
  body: string
  indexedAt: string
}

interface BucketCountRow {
  bucket: string
  total: number
  draftCount: number | null
}

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

    // F027 续 · 文件真数据源（德彪 batch2 P2-4：SQL 聚合计数 + 仅每桶 top5 才取 body，
    // 不全量加载 body 进内存——千级实体 × 1MB body 上限会在同步查询里炸事件循环/内存）。
    // indexer 落库时 path 已 normalize 为 '/'（wiki-entity-indexer relPath.replace），LIKE 可靠。
    const totalEntities = this.safeCount("SELECT COUNT(*) AS n FROM wiki_entity_index")
    const countsByDir = new Map<string, { total: number; draftCount: number }>()
    for (const row of this.safeRows<BucketCountRow>(
      "SELECT bucket, COUNT(*) AS total, SUM(CASE WHEN path LIKE '%/draft/%' THEN 1 ELSE 0 END) AS draftCount FROM wiki_entity_index GROUP BY bucket",
    )) {
      countsByDir.set(row.bucket, { total: row.total, draftCount: row.draftCount ?? 0 })
    }

    let nextEntityId = 1
    for (const type of BUCKET_TYPES) {
      const dir = BUCKET_TYPE_TO_DIR[type]
      const counts = (dir && countsByDir.get(dir)) || { total: 0, draftCount: 0 }
      const top5 = dir
        ? this.safeRows<EntityRow>(
            "SELECT path, bucket, name, body, indexed_at AS indexedAt FROM wiki_entity_index WHERE bucket = ? ORDER BY indexed_at DESC LIMIT 5",
            [dir],
          )
        : []
      buckets.push({
        type,
        totalCount: counts.total,
        canonicalCount: counts.total - counts.draftCount,
        draftCount: counts.draftCount,
        topEntities: top5.map((r) => this.toEntitySummary(r, nextEntityId++)),
      })
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

  private toEntitySummary(row: EntityRow, id: number): WikiEntitySummary {
    let canonicalOwnerPath = row.path
    let supersedes: string[] = []
    try {
      const { frontmatter } = parseFrontmatter(row.body)
      if (typeof frontmatter.canonical_owner_path === "string" && frontmatter.canonical_owner_path) {
        canonicalOwnerPath = frontmatter.canonical_owner_path
      }
      if (Array.isArray(frontmatter.supersedes)) {
        supersedes = frontmatter.supersedes.filter((s): s is string => typeof s === "string")
      }
    } catch {
      // frontmatter 解析失败 → 用 path 兜底（单条坏文件不挂仪表盘）
    }
    return {
      id,
      name: row.name,
      canonicalOwnerPath,
      state: isDraftPath(row.path) ? "draft" : "canonical",
      supersedes,
      updatedAt: row.indexedAt,
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
      // F027 续：entityNew = wiki_events 已 commit 的 write/ingest 行按日计数（真实写入审计源）。
      const entityNew = this.safeCount(
        "SELECT COUNT(*) AS n FROM wiki_events WHERE action IN ('write','ingest') AND state='committed' AND datetime(ts) BETWEEN datetime(?) AND datetime(?)",
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

  /** safeCount 同款错误语义的多行版（schema mismatch 抛、其他 fail-soft 空数组）。 */
  private safeRows<T>(sql: string, params: ReadonlyArray<unknown> = []): T[] {
    try {
      return this.client.prepare(sql).all(...params) as T[]
    } catch (err) {
      const msg = (err as Error).message ?? ""
      if (/no such (table|column)/i.test(msg)) {
        throw err
      }
      return []
    }
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
