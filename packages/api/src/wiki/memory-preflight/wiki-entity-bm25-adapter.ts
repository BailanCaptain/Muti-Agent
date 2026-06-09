import type { RecallHit, SearchOptions } from "./types"
import type { BM25CandidateProvider } from "./hybrid-search-provider"
import type { WikiEntityFtsProvider } from "../wiki-search/wiki-entity-fts-provider"

/**
 * F027 P4 AC-P4-8 b · WikiEntityFtsProvider → BM25CandidateProvider adapter.
 *
 * 小孙 2026-05-23 拍选 A: 新写 thin adapter wrap WikiEntityFtsProvider (BM25 真实现 over
 * wiki_entity_fts table) 适配 HybridSearchProvider 的 BM25CandidateProvider 接口槽，
 * 保留 Phase 1 P11 设计的完整 hybrid 路径 (BM25 + cosine + LLM rerank stub)。
 *
 * 两边 search() 签名 structural 兼容 (query: string, opts: SearchOptions): RecallHit[]，
 * 这个 adapter 显式标 `implements BM25CandidateProvider` 让 server.ts 生产 wire 时
 * 类型明确 (避免 ad-hoc cast)。
 *
 * Phase 4 漏的 dependency gap (黄 Day 2 b 实施时 grep 发现):
 *   - plan v5 写 "wrap HybridSearchProvider Phase 1 P11 已完成 BM25 + cosine + LLM rerank stub"
 *   - 实测：HybridSearchProvider 已实现, 但接收 BM25CandidateProvider interface 而 production
 *     BM25 实现 = WikiEntityFtsProvider (implements WikiSearchProvider, 接口签名同 structural)
 *   - 选 A: 写 adapter 桥接两个接口而不放弃 hybrid 路径
 */
export class WikiEntityBm25Adapter implements BM25CandidateProvider {
  constructor(private readonly provider: WikiEntityFtsProvider) {}

  async search(query: string, opts: SearchOptions): Promise<RecallHit[]> {
    return this.provider.search(query, opts)
  }
}
