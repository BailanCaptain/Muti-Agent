/**
 * F027 P11 · InMemoryWikiSearchProvider —— ⚠️ TEST/FIXTURE ONLY
 *
 * Phase 1 边界（小孙 2026-05-12 拍）：骨架先走 + 实现分两步。
 *
 * 本 provider 用 in-memory wiki entity records + 调 caller 提供的 embedding 生成器
 * + cosine 内存搜。给 fixture / 单元测试用。
 *
 * **生产不要 wire 本 provider**：
 *   - 无文件订阅 / 没 indexer，wiki entity 写入后召回不会更新
 *   - records 全在内存（100k entity ≈ 数 GB embedding）
 *   - P14 (Day 25) wiki entity FTS5 + indexer 落库后，加 SqliteWikiSearchProvider
 *     复用同 WikiSearchProvider interface（不修 caller side）
 *
 * 范-r1 P2-3 修：加 NaN / 维度不等 / 非 finite score 防御——cosineSimilarity 在
 * 维度不等向量上行为未定义；不防御的话 score=NaN 在 Quality Gate 的 `< floor`
 * 比较里永远 false（NaN 任何比较返 false），漏过 reject 直接进 inspector/injected。
 */

import { cosineSimilarity } from "../../services/embedding-service"
import type { RecallHit, SearchOptions, WikiSearchProvider } from "./types"

export interface WikiEntityRecord {
  /** 相对 wiki root path（如 wiki/concepts/F011-backend-hardening-drizzle.md） */
  path: string
  /** wiki entity body（一般取首 500 字 + canonical header） */
  body: string
  /** 已生成的 embedding（caller 提前生成传入） */
  embedding: number[]
  /** sha256 hash 体（防漂移核验，可选） */
  sourceHash?: string
}

export type EmbeddingGenerator = (text: string) => Promise<number[] | null>

export class InMemoryWikiSearchProvider implements WikiSearchProvider {
  constructor(
    private readonly records: ReadonlyArray<WikiEntityRecord>,
    private readonly generateEmbedding: EmbeddingGenerator,
  ) {}

  async search(query: string, opts: SearchOptions): Promise<RecallHit[]> {
    if (this.records.length === 0) return []
    const qVec = await this.generateEmbedding(query)
    if (!qVec || qVec.length === 0) return []

    const scored: RecallHit[] = []
    for (const rec of this.records) {
      // 范-r1 P2-3: 维度不等 / 空向量 / 非 finite score → 跳过（不漏进 buckets）
      if (rec.embedding.length === 0 || rec.embedding.length !== qVec.length) continue
      const score = cosineSimilarity(qVec, rec.embedding)
      if (!Number.isFinite(score)) continue
      scored.push({
        path: rec.path,
        score,
        excerpt: rec.body.slice(0, 200),
        sourceHash: rec.sourceHash,
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, opts.topK)
  }
}

/** Test/seed helper: bulk-pregenerate embeddings for a list of records. */
export async function buildWikiEntityRecords(
  raw: Array<{ path: string; body: string; sourceHash?: string }>,
  generateEmbedding: EmbeddingGenerator,
): Promise<WikiEntityRecord[]> {
  const out: WikiEntityRecord[] = []
  for (const r of raw) {
    const vec = await generateEmbedding(r.body)
    if (!vec) continue
    out.push({ path: r.path, body: r.body, embedding: vec, sourceHash: r.sourceHash })
  }
  return out
}
