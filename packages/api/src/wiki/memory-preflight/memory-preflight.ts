/**
 * F027 P11 · memory_preflight 主入口
 * 真相源：docs/plans/V16.5-final.md chap 10 行 1101-1124
 *
 * 流程：
 *   Step 1: generateRecallQueries(ctx)  — 2-5 query
 *   Step 2: Promise.all(queries.map(q => search(q)))  — 并行召回
 *   Step 3: applyQualityGate(results)  — score floor + dedupe + 分桶 + token cap
 *   Step 4: renderTaskMemoryPack  — markdown for Inspector
 *   Step 5: 派生 assemblePrompt 入参（高置信 .injected → prompt.hits）
 */

import type { GenerateQueriesOptions } from "./generate-queries"
import { generateRecallQueries } from "./generate-queries"
import { applyQualityGate } from "./quality-gate"
import { renderTaskMemoryPack, toAssemblePromptHits } from "./render-pack"
import type {
  MemoryPreflightOutput,
  QualityGateOptions,
  RecallResult,
  TaskContext,
  WikiSearchProvider,
} from "./types"

export interface MemoryPreflightDeps {
  search: WikiSearchProvider
}

export interface LoadTaskMemoryPackOptions {
  queries?: GenerateQueriesOptions
  gate?: Partial<QualityGateOptions>
}

export async function loadTaskMemoryPack(
  ctx: TaskContext,
  deps: MemoryPreflightDeps,
  opts?: LoadTaskMemoryPackOptions,
): Promise<MemoryPreflightOutput> {
  // Step 1
  const queries = generateRecallQueries(ctx, opts?.queries)

  // Step 2: 并行召回（失败静默：单 query 抛 → 空数组）
  // V16.5 chap 12 行 1419 query_parallel: true
  const results: RecallResult[] = await Promise.all(
    queries.map(async (q) => {
      try {
        const hits = await deps.search.search(q.query, { topK: q.topK, scope: "all" })
        return { query: q, hits }
      } catch {
        return { query: q, hits: [] }
      }
    }),
  )

  // Step 3
  const gateResult = applyQualityGate(results, opts?.gate)

  // Step 4
  const packMarkdown = renderTaskMemoryPack(queries, results, gateResult.buckets, ctx.scenario)

  // Step 5
  return {
    queries,
    results,
    buckets: gateResult.buckets,
    totalTokens: gateResult.totalTokens,
    budgetExceeded: gateResult.budgetExceeded,
    prompt: {
      hits: gateResult.buckets.injected.map(toAssemblePromptHits),
    },
    packMarkdown,
  }
}

/**
 * Helper：把 MemoryPreflightOutput 派生成 prompt_audit 行写入所需的 5 个字段
 * （recall_queries / recall_results / recall_total_tokens / recall_rejected_reasons / top_score）。
 * caller 拿这块 patch 注入 promptAudit insert/update。
 */
export function deriveAuditPatch(out: MemoryPreflightOutput): {
  recallQueries: string
  recallResults: string
  recallTotalTokens: number
  recallRejectedReasons: string
  topScore: number | null
  recallBudgetExceeded: number
} {
  const topScore =
    out.buckets.injected.length > 0
      ? out.buckets.injected[0].score
      : out.buckets.inspectorOnly.length > 0
        ? out.buckets.inspectorOnly[0].score
        : null
  return {
    recallQueries: JSON.stringify(out.queries),
    recallResults: JSON.stringify(
      out.results.map((r) => ({
        query: r.query.query,
        source: r.query.source,
        hits: r.hits.map((h) => ({ path: h.path, score: h.score })),
      })),
    ),
    recallTotalTokens: out.totalTokens,
    recallRejectedReasons: JSON.stringify(
      out.buckets.rejected.map((x) => ({ path: x.hit.path, reason: x.reason })),
    ),
    topScore,
    recallBudgetExceeded: out.budgetExceeded ? 1 : 0,
  }
}
