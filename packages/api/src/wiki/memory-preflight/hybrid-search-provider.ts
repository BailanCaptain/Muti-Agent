/**
 * F027 P11.b · HybridSearchProvider —— 接 P14/P15 真后端
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1403 + chap 21 P11/P14/P15
 *
 * 设计思路：
 *   Phase 1 backend = BM25 字面召回（WikiEntityFtsProvider，P14.a）+ embedding 语义
 *   精排（cosine sim）+ LLM rerank stub（P15 NoopReranker）。
 *
 * 流程：
 *   1. BM25 over-fetch 候选（topK * 2 + buffer，P15 SearchWikiProvider 同款 overscan 思路）
 *   2. 对每个候选 lookup 预生成的 entity embedding，算 cosine sim vs query embedding
 *   3. **hybrid score = max(bm25_norm, cosine_sim)** —— 任一信号强就让 score 高
 *      - BM25 norm 是 P14.a normalizeBm25Corpus 的 corpus-内 [0,1]（best=1, worst=0）
 *      - cosine sim 是 [0,1] 绝对相似度（Xenova all-MiniLM-L6-v2 q8）
 *      - max 融合避免 weighted-sum 调 α 的 magic
 *      - 物理意义：实体 ID 字面命中（高 BM25）和语义近（高 cosine）都算"相关"
 *   4. 按 hybrid score 排序
 *   5. LLM rerank stub（Phase 1 NoopReranker 透传；Phase 2 真 LLM）
 *   6. 截 topK 返
 *
 * 与 plan chap 10 行 1146-1150 阈值（≥0.75 inject / ≥0.6 inspector）对齐：
 *   - hybrid score 是 [0,1]，0.75/0.6 阈值语义不变
 *   - F011 / F021 等"实体 ID 直接命中" entity 走 BM25 路径拿 score 1.0 → inject
 *   - 语义近但 ID 不命中 entity 走 cosine 路径，拿 sim 值（中文模型物理限 ~0.5）→ inspector
 *   - 任一路径都能让 entity 进 buckets，避免 cosine-only 时中文短 query 全卡 inspector
 *
 * Caveats：
 *   - 候选层 BM25 召回的 entity 才会算 cosine —— BM25 漏召回的 entity 没机会进精排
 *     （这是 hybrid 的 retrieval-vs-reranking 取舍：BM25 candidate 集就是上限）
 *   - candidate 集外的 high-cosine entity 永远拿不到 score
 *   - Phase 1 fixture 用全 entity 召回（fixture 小，BM25 召回率 100%）规避这个问题
 *   - 生产场景 BM25 overscan + LLM rerank（Phase 2）补回 candidate 召回率
 */

import { cosineSimilarity } from "../../services/embedding-service"
import type { LLMReranker } from "../wiki-search/llm-reranker"
import { NoopReranker } from "../wiki-search/llm-reranker"
import type { WikiEntityRecord } from "./in-memory-provider"
import type { RecallHit, SearchOptions, WikiSearchProvider } from "./types"

export type EmbeddingGeneratorFn = (text: string) => Promise<number[] | null>

export interface BM25CandidateProvider {
  /** 拿 BM25 候选 hits（含 path + bm25Rank + score 归一化）。topK = overscan 候选数。 */
  search(query: string, opts: SearchOptions): Promise<RecallHit[]>
}

export interface HybridSearchProviderOptions {
  /** BM25 overscan 倍数（默认 2）：BM25 召 topK * expandFactor + minOverscan */
  expandFactor?: number
  /** BM25 overscan 最小 buffer（默认 10） */
  minOverscan?: number
  /** BM25 overscan 上限（默认 50，防 topK=50 → overscan 爆炸） */
  maxOverscan?: number
  /** Phase 2 真 LLM rerank（不传走 NoopReranker 透传） */
  reranker?: LLMReranker
}

const DEFAULT_EXPAND_FACTOR = 2
const DEFAULT_MIN_OVERSCAN = 10
const DEFAULT_MAX_OVERSCAN = 50

export class HybridSearchProvider implements WikiSearchProvider {
  private readonly expandFactor: number
  private readonly minOverscan: number
  private readonly maxOverscan: number
  private readonly reranker: LLMReranker
  private readonly recordByPath: Map<string, WikiEntityRecord>

  constructor(
    private readonly bm25: BM25CandidateProvider,
    embedded: ReadonlyArray<WikiEntityRecord>,
    private readonly generateQueryEmbedding: EmbeddingGeneratorFn,
    opts?: HybridSearchProviderOptions,
  ) {
    this.expandFactor = opts?.expandFactor ?? DEFAULT_EXPAND_FACTOR
    this.minOverscan = opts?.minOverscan ?? DEFAULT_MIN_OVERSCAN
    this.maxOverscan = opts?.maxOverscan ?? DEFAULT_MAX_OVERSCAN
    this.reranker = opts?.reranker ?? new NoopReranker()
    // path -> embedding lookup map（caller 提前 build；生产可加 LRU cache）
    this.recordByPath = new Map(embedded.map((r) => [r.path, r]))
  }

  async search(query: string, opts: SearchOptions): Promise<RecallHit[]> {
    const finalTopK = Math.max(1, opts.topK)
    const overscan = Math.min(
      this.maxOverscan,
      Math.max(finalTopK, finalTopK * this.expandFactor + this.minOverscan),
    )

    // Step 1: BM25 候选 over-fetch
    const candidates = await this.bm25.search(query, { ...opts, topK: overscan })
    if (candidates.length === 0) return []

    // F027 #286 receive 德彪 r1 P2-1：embedded records 为空（Phase 4 生产现状，boot-load
    // 推 F028）→ 所有候选必走 !rec fallback，query embedding 算了也弃用。跳过 Step 2-3，
    // 纯 BM25 直通 —— 否则冷启首轮 / Level 2 每 query 白付 22MB ONNX 模型加载 + 推理延迟。
    if (this.recordByPath.size === 0) {
      const rerankedBm25 = await this.reranker.rerank(query, candidates)
      return rerankedBm25.slice(0, finalTopK)
    }

    // Step 2: query embedding（一次算，所有候选共用）
    const qVec = await this.generateQueryEmbedding(query)
    if (!qVec || qVec.length === 0) {
      // embedding service 不可用 → 退化为纯 BM25（保留 candidates 顺序 + 截 topK）
      return candidates.slice(0, finalTopK)
    }

    // Step 3: 对每个候选算 cosine sim，融合 hybrid score
    const fused: RecallHit[] = []
    for (const cand of candidates) {
      const rec = this.recordByPath.get(cand.path)
      if (!rec) {
        // 候选 BM25 命中但 embedding cache 没有 → 仅用 BM25 score（partial fallback）
        fused.push({ path: cand.path, score: cand.score, excerpt: cand.excerpt })
        continue
      }
      // 防御：维度不等 / 空向量 → 跳过 cosine，仅 BM25 score
      if (rec.embedding.length === 0 || rec.embedding.length !== qVec.length) {
        fused.push({ path: cand.path, score: cand.score, excerpt: cand.excerpt })
        continue
      }
      const cos = cosineSimilarity(qVec, rec.embedding)
      const cosSafe = Number.isFinite(cos) ? cos : 0
      // hybrid: max(bm25_norm, cosine_sim) —— 任一信号强即认为相关
      const hybrid = Math.max(cand.score, cosSafe)
      fused.push({
        path: cand.path,
        score: hybrid,
        excerpt: cand.excerpt,
        sourceHash: cand.sourceHash,
      })
    }

    // Step 4: 按 hybrid score 排序
    fused.sort((a, b) => b.score - a.score)

    // Step 5: LLM rerank stub
    const reranked = await this.reranker.rerank(query, fused)

    // Step 6: 截 topK
    return reranked.slice(0, finalTopK)
  }
}
