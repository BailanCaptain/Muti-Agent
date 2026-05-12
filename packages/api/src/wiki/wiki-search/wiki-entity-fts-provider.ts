/**
 * F027 P14.a · WikiEntityFtsProvider
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1403 "Level 2: search_wiki ← BM25 + LLM rerank"
 *         + chap 21 P14 "FTS5 + query_messages MCP"
 *
 * 实现 memory-preflight 的 WikiSearchProvider interface — P11.b 接 hybrid backend
 * 时用本 provider 替换 P11.a 的 InMemoryWikiSearchProvider（不修 caller）。
 *
 * 范-r1 P1-1 修：BM25 → score 归一化改为 **corpus-内 min-max**（不依赖 raw rank 绝对值）。
 *   旧版 linear-clamp [-8, 4] → [1, 0] 把 Quality Gate ≥0.75/≥0.6 阈值绑死到
 *   SQLite FTS5 raw rank 区间，但 SQLite 只保证 "lower better"，没保 [-8, 4]。
 *   实测 bm25 区间随 query 长度 / 文档密度 / tokenizer 漂移，硬阈值物理不稳。
 *
 *   新归一化（fts-provider:scoreHits）：
 *     - 拿 topK 结果中 best(min) 和 worst(max) 两端
 *     - score = 1 - (rank - best) / (worst - best)
 *     - 单 hit 边界 → score = 1（best == worst 无 spread）
 *   语义：**当 query 的 topK 内相对置信度**，best 永远 1，worst 永远 0。
 *
 *   Quality Gate 阈值含义变成"相对当前 query topK 的前 25% / 前 40%"：
 *     - ≥ 0.75 = topK 中相对最强的部分（含 best 自身）
 *     - 0.6-0.75 = 中等 inspector 区
 *     - < 0.6 = 弱召回过滤掉
 *   这个语义对 caller 反而更稳：不管 raw rank 怎么漂，阈值含义不变。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import type { RecallHit, SearchOptions, WikiSearchProvider } from "../memory-preflight/types"
import { sanitizeFtsQuery } from "./fts-query-sanitize"
import type { WikiEntityFtsHit, WikiSearchOptions } from "./types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

const DEFAULT_TOP_K = 5
const MAX_TOP_K = 50

/**
 * F027 P15 · BM25 列权重（name >> body）
 *
 * SQLite FTS5 `bm25(table, w1, w2, ...)` 按列顺序给权重；UNINDEXED 列不算（FTS5 docs
 * §3.5.5），所以 wiki_entity_fts 的 4 列 (path UNINDEXED, bucket UNINDEXED, name, body)
 * 只给后 2 个 indexed 列权重。
 *
 * 为什么 name 5x body：
 *   - 文件名（如 'F011-backend-hardening-drizzle'）是 wiki entity 最强元数据信号
 *   - body 全文虽信息全，但相关性稀释（一篇 5KB 文档命中 'F011' 也可能只是引用提一句）
 *   - 5x 是经验值，wiki 类全文搜索常用 3-10x 区间；后续 P11.b 接 memory_preflight
 *     可调
 *
 * 调用方可覆盖（构造器传 ftsWeights）。
 */
const DEFAULT_NAME_WEIGHT = 5.0
const DEFAULT_BODY_WEIGHT = 1.0

export interface WikiEntityFtsProviderOptions {
  /** name 列 BM25 权重（默认 5.0；调小让 body 权重相对升） */
  nameWeight?: number
  /** body 列 BM25 权重（默认 1.0） */
  bodyWeight?: number
}

export class WikiEntityFtsProvider implements WikiSearchProvider {
  private readonly nameWeight: number
  private readonly bodyWeight: number

  constructor(
    private readonly db: DrizzleDb,
    opts?: WikiEntityFtsProviderOptions,
  ) {
    this.nameWeight = opts?.nameWeight ?? DEFAULT_NAME_WEIGHT
    this.bodyWeight = opts?.bodyWeight ?? DEFAULT_BODY_WEIGHT
  }

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

    // F027 P15: bm25(wiki_entity_fts, w1, w2, w3, w4) — 4 列权重按 schema 顺序传
    // (path, bucket, name, body)。
    //
    // **重要**：SQLite FTS5 bm25() 的权重参数按 schema 全部列顺序映射（含 UNINDEXED
    // 列），不按 indexed 列子集。schema 第 1/2 列 (path/bucket) UNINDEXED 给 0.0
    // 安全（UNINDEXED 列没 tf，weight 影响 = 0）；第 3/4 列 (name/body) 给真权重。
    // 之前只传 2 个 weight 时实际被 path/bucket 列吃掉，name/body 退默认 1.0，导致
    // weight 完全不生效（测试用 1.0 vs 10.0 raw rank 完全相同复现）。
    //
    // 权重格式：必须字面 number 不接受 '?' bind。type-check finite + toFixed(2)
    // 限定字符防 SQL grammar 注入。
    const nw = Number.isFinite(this.nameWeight) ? this.nameWeight.toFixed(2) : "5.00"
    const bw = Number.isFinite(this.bodyWeight) ? this.bodyWeight.toFixed(2) : "1.00"

    let sql: string
    let params: unknown[]
    if (buckets && buckets.length > 0) {
      const placeholders = buckets.map(() => "?").join(",")
      sql = `
        SELECT i.path AS path, i.bucket AS bucket, i.name AS name, i.body AS body,
               bm25(wiki_entity_fts, 0.0, 0.0, ${nw}, ${bw}) AS rank
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
               bm25(wiki_entity_fts, 0.0, 0.0, ${nw}, ${bw}) AS rank
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

    // 范-r1 P1-1: corpus-内 min-max 归一化（不依赖 raw rank 绝对区间）
    const ranks = rows.map((r) => r.rank)
    return rows.map((r) => ({
      path: r.path,
      bucket: r.bucket,
      name: r.name,
      body: r.body,
      bm25Rank: r.rank,
      score: normalizeBm25Corpus(r.rank, ranks),
    }))
  }
}

/**
 * 范-r1 P1-1: corpus-内 min-max 归一化。
 * FTS5 bm25() 越小越相关。给定一组 ranks（同 query 的 topK），best=min worst=max。
 *   - score = 1 - (rank - best) / (worst - best)
 *   - 单 hit 或 best == worst → score = 1（无 spread 全打满）
 * 返回 [0, 1]。
 *
 * 设计权衡 vs alternative：
 *   - 绝对阈值（旧版 linear-clamp [-8, 4]）→ 物理上不稳，SQLite 没保证 raw 区间
 *   - corpus-内归一化 → 阈值语义变成"前 25%"（≥ 0.75）/"前 40%"（≥ 0.6），跨 query 稳
 *   - global percentile（跨 query 历史窗）→ 需 audit 维护历史 rank，开销大；留 P15
 */
export function normalizeBm25Corpus(rank: number, all: ReadonlyArray<number>): number {
  if (all.length === 0) return 0
  let best = all[0]
  let worst = all[0]
  for (const r of all) {
    if (r < best) best = r
    if (r > worst) worst = r
  }
  if (worst === best) return 1
  const score = 1 - (rank - best) / (worst - best)
  return Math.max(0, Math.min(1, score))
}
