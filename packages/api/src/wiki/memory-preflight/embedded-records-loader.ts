/**
 * F027 续 · EmbeddedWikiRecordsLoader —— 语义召回转正（embedded records boot-load）
 *
 * 背景：HybridSearchProvider 自 Phase 4 起 embedded records 恒空 → 永走纯 BM25 快路径
 * （hybrid-search-provider.ts:98-101），语义精排电路通了没通电。本 loader 是缺的生产者。
 *
 * 数据源：wiki_entity_index 表（reindexWikiEntities 的产物）。**必须**同源——BM25 候选
 * （WikiEntityFtsProvider）的 hit.path 就是这张表的 path PK，loader 用同一表保证
 * recordByPath.get(cand.path) 能对上；从别处扫文件会造出第二套 path 形态对不上号。
 *
 * 缓存：path → (sourceHash, embedding) 内存 map。reindex 增量后只对 hash 变更行重算
 * embedding（本地 MiniLM 单条 ~10-50ms，全量 130+ 实体在 boot 后台跑也要秒级，缓存让
 * debounce 高频刷新只付增量成本）。删除行同步清缓存（防重插复用幽灵向量）。
 *
 * 降级：generateEmbedding null/抛错 → 跳过该行计 failed。全失败 → records 空 →
 * provider 维持 BM25-only 现状，系统行为不变（天然 fail-soft，无需开关）。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import { wikiEntityIndex } from "../../db/schema"
import type { EmbeddingGeneratorFn } from "./hybrid-search-provider"
import type { WikiEntityRecord } from "./in-memory-provider"

type DrizzleDb = BetterSQLite3Database<typeof schema>

/** MiniLM 上下文 ~256 token；name + 首 500 字符已覆盖标题/summary 段的语义信号。 */
const DEFAULT_MAX_BODY_CHARS = 500

export interface EmbeddedRecordsLoaderDeps {
  db: DrizzleDb
  generateEmbedding: EmbeddingGeneratorFn
  /** embed 文本 body 截断长度（默认 500 字符）。 */
  maxBodyChars?: number
  /** fail-soft 日志（默认 noop）。 */
  warn?: (msg: string) => void
}

export interface EmbeddedRecordsLoadResult {
  records: WikiEntityRecord[]
  stats: {
    /** wiki_entity_index 总行数 */
    total: number
    /** 本轮真调 embedder 的行数 */
    embedded: number
    /** 缓存复用（sourceHash 未变）行数 */
    reused: number
    /** embed 失败（null/抛错）跳过的行数 */
    failed: number
  }
}

export class EmbeddedWikiRecordsLoader {
  private readonly db: DrizzleDb
  private readonly generateEmbedding: EmbeddingGeneratorFn
  private readonly maxBodyChars: number
  private readonly warn: (msg: string) => void
  private readonly cache = new Map<string, { sourceHash: string; embedding: number[] }>()

  constructor(deps: EmbeddedRecordsLoaderDeps) {
    this.db = deps.db
    this.generateEmbedding = deps.generateEmbedding
    this.maxBodyChars = deps.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS
    this.warn = deps.warn ?? (() => {})
  }

  async load(): Promise<EmbeddedRecordsLoadResult> {
    const rows = this.db
      .select({
        path: wikiEntityIndex.path,
        name: wikiEntityIndex.name,
        body: wikiEntityIndex.body,
        sourceHash: wikiEntityIndex.sourceHash,
      })
      .from(wikiEntityIndex)
      .all()

    const records: WikiEntityRecord[] = []
    const stats = { total: rows.length, embedded: 0, reused: 0, failed: 0 }
    const livePaths = new Set<string>()

    for (const row of rows) {
      livePaths.add(row.path)
      const cached = this.cache.get(row.path)
      if (cached && cached.sourceHash === row.sourceHash) {
        stats.reused++
        records.push({
          path: row.path,
          body: row.body,
          embedding: cached.embedding,
          sourceHash: row.sourceHash,
        })
        continue
      }
      let embedding: number[] | null
      try {
        embedding = await this.generateEmbedding(this.embedText(row.name, row.body))
      } catch (err) {
        embedding = null
        this.warn(
          `embedded-records-loader: embed threw for ${row.path}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (!embedding || embedding.length === 0) {
        stats.failed++
        // 旧缓存（如有）不删：embedder 瞬时故障时下轮可继续复用旧向量好过丢语义信号；
        // 但本轮 records 不收（hash 已变，旧向量对不上新内容）。
        continue
      }
      stats.embedded++
      this.cache.set(row.path, { sourceHash: row.sourceHash, embedding })
      records.push({ path: row.path, body: row.body, embedding, sourceHash: row.sourceHash })
    }

    // 删除行清缓存：防文件删后重插（同 hash）复用早已无效的幽灵缓存语义。
    for (const path of this.cache.keys()) {
      if (!livePaths.has(path)) this.cache.delete(path)
    }

    return { records, stats }
  }

  /** name + body 截断拼 embed 文本：文件名是最强元数据信号（与 BM25 name 5x 权重同理）。 */
  private embedText(name: string, body: string): string {
    return `${name}\n${body.slice(0, this.maxBodyChars)}`
  }
}
