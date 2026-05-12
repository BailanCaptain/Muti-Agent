/**
 * F027 P15 · LLM rerank interface + Phase 1 stub
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1403 "Level 2: search_wiki ← BM25 + LLM rerank"
 *         + chap 21 P15 "search-bm25 + LLM rerank"
 *
 * 设计：
 *   - BM25 召回 topK overscan (~10-20) → LLMReranker 真排序 → top-K (5) 返回
 *   - Phase 1 接 stub：NoopReranker（透传，不重排），P11.b memory_preflight 测试可注入
 *     ScoreOnlyReranker / FixtureReranker 验证排序合理性而无需真 LLM 调用
 *   - Phase 2（不在 F027 范围）接真 LLM rerank service（Claude Haiku / Qwen / 本地小模型）
 *
 * 接口最小化（防过度设计）：
 *   - rerank(query, hits) → 重排后 hits（可能改 score / 改顺序 / 砍掉 hit）
 *   - 不强制 Promise（同步 stub 可直接 return）；real LLM 实现走 Promise
 *
 * 决策记录：
 *   - 不做 batch / streaming —— rerank 是单 query 单批，没必要复杂化
 *   - 不要求 reranker 解释 ranking ——  P11.b inspector 可以另派 critique agent
 *   - 不强制保持 hits.length 不变 —— LLM 可能判某些 hit 与 query 不相关砍掉
 */

import type { RecallHit } from "../memory-preflight/types"

export interface LLMReranker {
  /**
   * 重排 BM25 召回的 hits。
   * @param query 原始用户 query（rerank prompt 拼接用）
   * @param hits  BM25 召回的 topK overscan 列表（rank 由 caller 已归一化）
   * @returns 重排后的 hits（顺序 = 相关性降序；可砍 hit）
   */
  rerank(query: string, hits: RecallHit[]): Promise<RecallHit[]>
}

/**
 * Phase 1 默认 stub：透传，不改顺序也不改 score。
 *
 * 用于 P15 物理层 wire + 测试场景。Real LLM rerank 留 Phase 2，本 stub 保证
 * SearchWikiProvider 在 Phase 1 也能跑通端到端（BM25 召回 + 走 rerank 路径）。
 */
export class NoopReranker implements LLMReranker {
  async rerank(_query: string, hits: RecallHit[]): Promise<RecallHit[]> {
    return hits
  }
}
