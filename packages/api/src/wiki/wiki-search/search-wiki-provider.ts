/**
 * F027 P15 · SearchWikiProvider —— Adaptive Recall Level 2 入口
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1401-1410 + chap 21 P15
 *
 * 组合 WikiEntityFtsProvider (BM25 weighted) + LLMReranker：
 *   1. BM25 overscan: 拿 topK * 2 + buffer（默认 expandFactor=2, minOverscan=10）
 *   2. LLMReranker 重排（Phase 1 NoopReranker 透传）
 *   3. 截 topK 返回 caller
 *
 * 设计权衡：
 *   - overscan 比例：BM25 召回率高、精度中等，rerank 提精度。2x + 10 buffer 是
 *     学术界 BM25→rerank 经验区间（topK=5 → BM25 召 20，rerank 砍回 5）
 *   - WikiSearchProvider 接口对齐 memory-preflight WikiSearchProvider —— P11.b
 *     接 hybrid 时本 provider 可直接替换 in-memory stub
 *   - reranker 可选：未注入时退化为纯 BM25（行为同 WikiEntityFtsProvider.search）
 */

import type { RecallHit, SearchOptions, WikiSearchProvider } from "../memory-preflight/types"
import type { LLMReranker } from "./llm-reranker"
import { NoopReranker } from "./llm-reranker"
import type { WikiEntityFtsProvider } from "./wiki-entity-fts-provider"

export interface SearchWikiProviderOptions {
  /** BM25 overscan 倍数（默认 2）：BM25 召 topK * expandFactor + minOverscan */
  expandFactor?: number
  /** BM25 overscan 最小 buffer（默认 10）：防 topK=1 时 overscan 太少 */
  minOverscan?: number
  /** 上限（防 caller 传 topK=50 时 overscan 爆炸） */
  maxOverscan?: number
}

const DEFAULT_EXPAND_FACTOR = 2
const DEFAULT_MIN_OVERSCAN = 10
const DEFAULT_MAX_OVERSCAN = 50

export class SearchWikiProvider implements WikiSearchProvider {
  private readonly expandFactor: number
  private readonly minOverscan: number
  private readonly maxOverscan: number
  private readonly reranker: LLMReranker

  constructor(
    private readonly fts: WikiEntityFtsProvider,
    reranker?: LLMReranker,
    opts?: SearchWikiProviderOptions,
  ) {
    this.reranker = reranker ?? new NoopReranker()
    this.expandFactor = opts?.expandFactor ?? DEFAULT_EXPAND_FACTOR
    this.minOverscan = opts?.minOverscan ?? DEFAULT_MIN_OVERSCAN
    this.maxOverscan = opts?.maxOverscan ?? DEFAULT_MAX_OVERSCAN
  }

  /**
   * 组合 BM25 召回 + LLM rerank。
   * topK 是 caller 期望最终拿到的数量；内部 BM25 overscan 然后 rerank 截回。
   */
  async search(query: string, opts: SearchOptions): Promise<RecallHit[]> {
    const finalTopK = Math.max(1, opts.topK)
    const overscan = Math.min(
      this.maxOverscan,
      Math.max(finalTopK, finalTopK * this.expandFactor + this.minOverscan),
    )

    // Step 1: BM25 召回 overscan
    const bm25Hits = await this.fts.search(query, { ...opts, topK: overscan })
    if (bm25Hits.length === 0) return []

    // Step 2: LLM rerank（Phase 1 NoopReranker = 透传）
    const reranked = await this.reranker.rerank(query, bm25Hits)

    // Step 3: 截最终 topK
    return reranked.slice(0, finalTopK)
  }
}
