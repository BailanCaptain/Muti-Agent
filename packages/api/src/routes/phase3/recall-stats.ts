/**
 * F042 AC2 · RecallStatsService + GET /api/recall/stats — direct_turn 召回窗口统计。
 *
 * 口径（feature doc AC2 + plan D4）：
 *   - 窗口 = 最近 N 行 `scenario='direct_turn' AND recall_required=1`（召回链真跑过的行；
 *     off 模式 scenario_skip 行 recall_required=0 不计）
 *   - hitRate = recall_results 非空数组行 / totalRecalls
 *   - annotatedCount = recall_adopted 非 NULL 行（= D4 定义的「标注」数，rerank 立项阈值的分子）
 *   - adoptionRate = adopted=1 / annotatedCount；分母 0 → null（不编造 0%）
 *   - topEntries = recall_results JSON 逐行解析聚合 path 出现次数 top 10
 *
 * 与 prompt-inspector 同款三段式（inline validate → service 查库 → JSON 出）。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import type { SqliteAdapterLike } from "../../wiki/room-compiler/sqlite-checkpoint-store"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface RecallStatsQuery {
  /** 窗口行数，[1,500]，默认 50（影子观察窗口径）。 */
  window?: number
  /** 可选 room 过滤；缺省全局。 */
  roomId?: string
}

export interface RecallStatsWindow {
  window: number
  totalRecalls: number
  hitRate: number
  adoptionRate: number | null
  annotatedCount: number
  adoptedCount: number
  topEntries: Array<{ path: string; count: number }>
  oldestAt: string | null
  newestAt: string | null
}

interface AuditRow {
  created_at: string
  recall_results: string | null
  recall_adopted: number | null
}

export class RecallStatsService {
  private readonly client: SqliteAdapterLike

  constructor(deps: { db: DrizzleDb }) {
    this.client = (deps.db as unknown as { $client: SqliteAdapterLike }).$client
  }

  getStats(q: RecallStatsQuery): RecallStatsWindow {
    const window = clampWindow(q.window)
    // 观察窗 = shadow×direct_turn 的 settled 行（德彪 r1 P1-1/P1-2 窗口纯度三过滤）：
    //   - recall_trigger='direct_turn'：冷启行（trigger=session_bootstrap）实际注入 Pack，
    //     不属 shadow 观察语义（scenario 列冷启也是 direct_turn，必须按 trigger 切）
    //   - recall_mode='shadow'：inject 行是注入行为数据，off 行本就 required=0
    //   - settled：shadow 异步化后占位行 results/total_ms 双 NULL 先落库，settle 才回填——
    //     未 settle 行计入会让第 50 条恰为占位时用未完成数据烧掉一次性小结 flag
    const rows = this.client
      .prepare(
        `SELECT created_at, recall_results, recall_adopted
         FROM prompt_audit
         WHERE scenario = 'direct_turn' AND recall_required = 1
           AND recall_trigger = 'direct_turn' AND recall_mode = 'shadow'
           AND NOT (recall_results IS NULL AND recall_total_ms IS NULL)
           AND (? IS NULL OR room_id = ?)
         ORDER BY id DESC LIMIT ?`,
      )
      .all(q.roomId ?? null, q.roomId ?? null, window) as AuditRow[]

    let hits = 0
    let annotated = 0
    let adopted = 0
    const pathCounts = new Map<string, number>()
    let oldestAt: string | null = null
    let newestAt: string | null = null
    for (const row of rows) {
      const results = parseResults(row.recall_results)
      if (results.length > 0) hits += 1
      for (const r of results) {
        pathCounts.set(r.path, (pathCounts.get(r.path) ?? 0) + 1)
      }
      if (row.recall_adopted !== null) {
        annotated += 1
        if (row.recall_adopted === 1) adopted += 1
      }
      // 时间边界按 created_at 值聚合，不依赖 id 序 = 时间序（preview 验收捕获：
      // 行位置法在时序与插入序不一致时倒挂）
      if (oldestAt === null || row.created_at < oldestAt) oldestAt = row.created_at
      if (newestAt === null || row.created_at > newestAt) newestAt = row.created_at
    }
    const topEntries = [...pathCounts.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
      .slice(0, 10)

    return {
      window,
      totalRecalls: rows.length,
      hitRate: rows.length > 0 ? hits / rows.length : 0,
      adoptionRate: annotated > 0 ? adopted / annotated : null,
      annotatedCount: annotated,
      adoptedCount: adopted,
      topEntries,
      oldestAt,
      newestAt,
    }
  }
}

function clampWindow(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 50
  return Math.min(500, Math.max(1, Math.floor(raw)))
}

/**
 * recall_results 真实并存两种形状（preview 验收捕获）：
 *   - coordinator 支扁平：`[{path,score,excerpt}]`（buildRecallAuditPatch）
 *   - 冷启支嵌套：`[{query,source,hits:[{path,...}]}]`（buildColdStartRecallAuditPatch）
 * 双形状归一为 path 列表；只解析扁平会让冷启行 hits 统计丢失（hitRate 低报）。
 */
function parseResults(json: string | null): Array<{ path: string }> {
  if (!json) return []
  try {
    const arr = JSON.parse(json) as unknown
    if (!Array.isArray(arr)) return []
    const out: Array<{ path: string }> = []
    for (const x of arr) {
      if (typeof x !== "object" || x === null) continue
      const flat = x as { path?: unknown; hits?: unknown }
      if (typeof flat.path === "string") {
        out.push({ path: flat.path })
        continue
      }
      if (Array.isArray(flat.hits)) {
        for (const h of flat.hits) {
          if (
            typeof h === "object" &&
            h !== null &&
            typeof (h as { path?: unknown }).path === "string"
          ) {
            out.push({ path: (h as { path: string }).path })
          }
        }
      }
    }
    return out
  } catch {
    return []
  }
}

export function registerRecallStatsRoute(app: FastifyInstance, service: RecallStatsService): void {
  app.get("/api/recall/stats", async (request, reply) => {
    const q = request.query as { window?: string; roomId?: string }
    const windowNum = q.window !== undefined ? Number(q.window) : undefined
    if (q.window !== undefined && !Number.isFinite(windowNum)) {
      reply.code(400)
      return { ok: false, error: "window must be a number" }
    }
    try {
      return service.getStats({ window: windowNum, roomId: q.roomId || undefined })
    } catch (err) {
      reply.code(500)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
