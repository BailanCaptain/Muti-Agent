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

import { notLike } from "drizzle-orm"
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
    /**
     * 德彪 codex batch1 P2-2 · 连续失败熔断触发 → true。
     * EmbeddingService 模型加载失败会清 loadPromise 允许重试（embedding-service.ts:202），
     * 模型级故障下逐行重试 = 千级实体千次模型加载；连败 N 次判模型不可用，中断本轮。
     */
    aborted: boolean
  }
}

/** 连续 embed 失败阈值：达到即判 embedder 模型级不可用，熔断本轮（缓存复用行不计入）。 */
const MAX_CONSECUTIVE_FAILURES = 5

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
    // F027 续 · draft 召回准入闸门（德彪 P2 + 小孙拍选项 1）：语义召回与 BM25 同闸门,
    // 排除 path 含 /draft/ 的未 promote 实体（embedding 不该让未审内容进 agent 召回）。
    const rows = this.db
      .select({
        path: wikiEntityIndex.path,
        name: wikiEntityIndex.name,
        body: wikiEntityIndex.body,
        sourceHash: wikiEntityIndex.sourceHash,
      })
      .from(wikiEntityIndex)
      .where(notLike(wikiEntityIndex.path, "%/draft/%"))
      .all()

    const records: WikiEntityRecord[] = []
    const stats = { total: rows.length, embedded: 0, reused: 0, failed: 0, aborted: false }
    const livePaths = new Set<string>()
    let consecutiveFailures = 0

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
      // 德彪 codex batch1 P2-2 · 熔断：连败 N 次后剩余未缓存行不再逐行打 embedder
      // （模型级故障下每行都会触发一次模型重加载尝试）。本轮 aborted，下次 reindex 再试。
      if (stats.aborted) {
        stats.failed++
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
        consecutiveFailures++
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stats.aborted = true
          this.warn(
            `embedded-records-loader: ${consecutiveFailures} consecutive embed failures — embedder 判定不可用，本轮熔断（剩余行计 failed，下次 reindex 重试）`,
          )
        }
        // 旧缓存（如有）不删：embedder 瞬时故障时下轮可继续复用旧向量好过丢语义信号；
        // 但本轮 records 不收（hash 已变，旧向量对不上新内容）。
        continue
      }
      consecutiveFailures = 0
      stats.embedded++
      this.cache.set(row.path, { sourceHash: row.sourceHash, embedding })
      records.push({ path: row.path, body: row.body, embedding, sourceHash: row.sourceHash })
    }

    // 删除行清缓存：防文件删后重插（同 hash）复用早已无效的幽灵缓存语义。
    // 熔断轮跳过的行也在 livePaths（仍是活行），其旧缓存不受影响。
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

/**
 * 德彪 codex batch1 P2-3 · 防重入串行刷新状态机（从 server.ts 内联抽出可测）。
 *
 * 语义：trigger() fire-and-forget；run 在跑时再 trigger 只标 dirty，本轮结束补跑一轮
 * （不丢最后一次触发的更新）；run 抛错 → onError，不产生 unhandled rejection。
 */
export function createSerializedRefresher(
  run: () => Promise<void>,
  onError: (err: unknown) => void,
): () => void {
  let running = false
  let dirty = false
  const loop = async () => {
    running = true
    try {
      do {
        dirty = false
        await run()
      } while (dirty)
    } catch (err) {
      onError(err)
    } finally {
      running = false
      // run 抛错时 do/while 提前退出；若错后又被 trigger 标了 dirty，这里补拉起新一轮，
      // 否则该次触发会被吞掉直到下次外部 trigger。
      if (dirty) void loop()
    }
  }
  return () => {
    if (running) {
      dirty = true
      return
    }
    void loop()
  }
}
