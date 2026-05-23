import type { RecallHit } from "../memory-preflight/types"
import type { HybridSearchProvider } from "../memory-preflight/hybrid-search-provider"
import type { Level2Backend } from "./types"

/**
 * F027 P4 AC-P4-8 (b) · Level 2 production backend adapter.
 *
 * 范-r3 P2-2 实证：`Level2Backend` interface (types.ts:68) 注释明示 "P13.3+ 接真 backend"
 * 但 Phase 1 没有 production 实现 (grep 0 implements + 全 test stub)。
 *
 * 这个 thin adapter wrap 现有 `HybridSearchProvider` (memory-preflight/hybrid-search-provider.ts:63
 * Phase 1 P11 已完成 BM25 + cosine + LLM rerank stub)。两边的 RecallHit 共享同一 type
 * (adaptive-recall/types.ts 从 memory-preflight/types import)，所以 forward 即可。
 *
 * 不做：scope 过滤（HybridSearchProvider 当前 BM25 后端不区分 scope；如需 wiki/concepts/ 等
 * 子域过滤，应在 BM25CandidateProvider 实现里加，不在 adapter 加）。
 */
export class Level2HybridSearchBackend implements Level2Backend {
  constructor(private readonly provider: HybridSearchProvider) {}

  async searchWiki(query: string, topK: number): Promise<RecallHit[]> {
    return this.provider.search(query, { topK })
  }
}
