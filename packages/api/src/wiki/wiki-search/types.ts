/**
 * F027 P14.a · wiki entity FTS5 search 类型
 * 真相源：docs/plans/V16.5-final.md chap 21 P14 + chap 22 行 2407
 *
 * 三个抽象：
 *   - WikiEntityFile      ── indexer 扫 wikiRoot 找到的文件元信息
 *   - WikiEntityIndexRow  ── 落库行（schema wiki_entity_index）
 *   - WikiEntityFtsHit    ── FTS5 query 命中结果
 */

export interface WikiEntityFile {
  /** 相对 wiki root 的 path（如 wiki/concepts/F011-backend-hardening-drizzle.md） */
  relPath: string
  /** bucket（解析自 path 第一段：concepts/memories/agents/bugReport/archive/...） */
  bucket: string
  /** 文件名去后缀（F011-backend-hardening-drizzle） */
  name: string
  /** 文件 body 全文 */
  body: string
  /** sha256(body) hex */
  sourceHash: string
  /** 文件 mtime（毫秒） */
  mtimeMs: number
}

export interface WikiEntityIndexRow extends WikiEntityFile {
  /** 入库时间 ISO */
  indexedAt: string
}

export interface WikiEntityFtsHit {
  /** wiki/<bucket>/<name>.md */
  path: string
  bucket: string
  name: string
  /** 文件 body snapshot（FTS5 行内不存 body，hit 时按 path 反查 wiki_entity_index） */
  body: string
  /** BM25 rank（FTS5 内置 bm25() 函数，**值越小越相关**——caller 需要归一化） */
  bm25Rank: number
  /** 归一化 score [0, 1]（caller 决定算法，便于与 memory-preflight QualityGate 接） */
  score: number
}

export interface IndexerReport {
  /** 扫到的 wiki 文件总数 */
  scanned: number
  /** 新增入库 */
  inserted: number
  /** 内容变更覆盖 */
  updated: number
  /** 跳过（mtime + sourceHash 都未变） */
  skipped: number
  /** DB 中存在但磁盘已删 → 本次 DELETE */
  removed: number
  /** 解析失败 / IO 失败的 path 列表（不阻塞 indexer 继续，但报回 caller） */
  failed: Array<{ relPath: string; error: string }>
  /** 耗时毫秒 */
  durationMs: number
}

export interface WikiSearchOptions {
  /** topK 默认 5，最大 50 */
  topK?: number
  /** 限 bucket（如 ['concepts', 'agents']）；null/undefined = 全扫 */
  buckets?: string[]
  /** FTS5 sanitize：caller 已知不安全字符时可关；默认 true */
  sanitizeQuery?: boolean
}
