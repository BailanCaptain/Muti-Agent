/**
 * F027 P14.a · WikiEntityFtsProvider
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1403 "Level 2: search_wiki ← BM25 + LLM rerank"
 *         + chap 21 P14 "FTS5 + query_messages MCP"
 *
 * 实现 memory-preflight 的 WikiSearchProvider interface — P11.b 接 hybrid backend
 * 时用本 provider 替换 P11.a 的 InMemoryWikiSearchProvider（不修 caller）。
 *
 * BM25 → score 归一化（V16.5 chap 10 行 1146-1150 Quality Gate 用 [0,1] score）：
 *   FTS5 bm25() 返回**值越小越相关**的实数（负数也可能）。
 *   归一化策略 Phase 1 baseline：score = exp(-max(0, bm25Rank))，限到 (0, 1]。
 *   实际表现：完美匹配 bm25 ≈ -8 → score ≈ 1；中等 bm25 ≈ -1 → score ≈ 0.37；
 *   弱匹配 bm25 ≈ 2 → score ≈ 0.14。caller (Quality Gate) 用 ≥ 0.6/0.75 阈值。
 *   P15 LLM rerank 后会重写 score，本步骤只是占位让 P11 接得通。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import type { RecallHit, SearchOptions, WikiSearchProvider } from "../memory-preflight/types"
import { sanitizeFtsQuery } from "./fts-query-sanitize"
import type { WikiEntityFtsHit, WikiSearchOptions } from "./types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

const DEFAULT_TOP_K = 5
const MAX_TOP_K = 50

export class WikiEntityFtsProvider implements WikiSearchProvider {
  constructor(private readonly db: DrizzleDb) {}

  /** memory-preflight 接口：query + topK + optional scope → RecallHit[] */
  async search(query: string, opts: SearchOptions): Promise<RecallHit[]> {
    const ftsOpts: WikiSearchOptions = {
      topK: opts.topK,
      buckets: opts.scope && opts.scope !== "all" ? [opts.scope] : undefined,
    }
    const hits = this.queryFts(query, ftsOpts)
    // 转 RecallHit shape（memory-preflight quality-gate 直接消费）
    return hits.map((h) => ({
      path: h.path,
      score: h.score,
      excerpt: h.body.slice(0, 200),
    }))
  }

  /** 同步内部 query — 给 test / 直接 caller 用 */
  queryFts(query: string, opts?: WikiSearchOptions): WikiEntityFtsHit[] {
    const safe = (opts?.sanitizeQuery ?? true) ? sanitizeFtsQuery(query) : query
    if (safe.length === 0) return []
    const topK = Math.min(MAX_TOP_K, Math.max(1, opts?.topK ?? DEFAULT_TOP_K))

    // 用 raw SQL；drizzle 没原生 fts5 helper，且 bm25() / MATCH 语法非标准
    // SAFETY: safe 已经 quote 处理（每 token 包 phrase）；bucket 过滤用 IN-clause + 参数化
    // 用底层 prepare（drizzle better-sqlite3 adapter 暴露 raw / get / all）
    const rawDb = (this.db as unknown as { $client: { prepare(sql: string): unknown } }).$client
    const buckets = opts?.buckets ?? null

    let sql: string
    let params: unknown[]
    if (buckets && buckets.length > 0) {
      const placeholders = buckets.map(() => "?").join(",")
      sql = `
        SELECT i.path AS path, i.bucket AS bucket, i.name AS name, i.body AS body,
               bm25(wiki_entity_fts) AS rank
        FROM wiki_entity_fts
        JOIN wiki_entity_index i ON i.rowid = wiki_entity_fts.rowid
        WHERE wiki_entity_fts MATCH ?
          AND i.bucket IN (${placeholders})
        ORDER BY rank ASC
        LIMIT ?
      `
      params = [safe, ...buckets, topK]
    } else {
      sql = `
        SELECT i.path AS path, i.bucket AS bucket, i.name AS name, i.body AS body,
               bm25(wiki_entity_fts) AS rank
        FROM wiki_entity_fts
        JOIN wiki_entity_index i ON i.rowid = wiki_entity_fts.rowid
        WHERE wiki_entity_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `
      params = [safe, topK]
    }

    let rows: Array<{
      path: string
      bucket: string
      name: string
      body: string
      rank: number
    }>
    try {
      const stmt = rawDb.prepare(sql) as {
        all(...args: unknown[]): Array<{
          path: string
          bucket: string
          name: string
          body: string
          rank: number
        }>
      }
      rows = stmt.all(...params)
    } catch (err) {
      // FTS5 syntax error 等：sanitize 应已拦下；若仍抛，fail-soft 返空（memory-preflight
      // 主路径在 search 抛错时已 logger.warn + 返 []，本 provider 也保留 fail-soft 语义）
      if (err instanceof Error && /fts5/i.test(err.message)) return []
      throw err
    }

    return rows.map((r) => ({
      path: r.path,
      bucket: r.bucket,
      name: r.name,
      body: r.body,
      bm25Rank: r.rank,
      score: bm25ToScore(r.rank),
    }))
  }
}

/**
 * BM25 → [0, 1] 归一化。
 * FTS5 bm25() 默认权重下，完美匹配 ≈ -8（4-token query），
 * 越大表示越不相关；可能正可能负。
 * score = exp(min(0, bm25))  ∈ (0, 1]
 *   bm25 = -8 → score ≈ 1.0
 *   bm25 = -4 → score ≈ 0.98
 *   bm25 = -2 → score ≈ 0.86
 *   bm25 = -1 → score ≈ 0.63
 *   bm25 = 0  → score = 1（边界）—— 这种是 query 完全没 hit 词，FTS5 不该返
 *   bm25 = 1  → score ≈ 0.37
 */
export function bm25ToScore(bm25Rank: number): number {
  // FTS5 完美匹配返负数，越小越相关。clamp 到 [-8, 4] 后映射。
  const clamped = Math.max(-8, Math.min(4, bm25Rank))
  // -8 → 1.0；4 → exp(-4) ≈ 0.018
  // 映射 = exp(-(clamped+8)/8) 让 [-8, 0] 落到 [1, exp(-1)]，[0, 4] 落到 [exp(-1), exp(-1.5)]
  // 更简单：score = 1 - normalize(clamped, -8, 4)
  const normalized = (clamped - -8) / (4 - -8) // 0 (perfect) → 1 (worst)
  return Math.max(0, Math.min(1, 1 - normalized))
}
