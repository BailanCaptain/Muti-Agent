/**
 * F027 P11 · task_memory_pack markdown 渲染
 * 真相源：docs/plans/V16.5-final.md chap 10 行 1156-1173
 *
 * 输出格式（Inspector 看，注入 prompt 用 [Recall Pack — Reference Only] 区段）：
 *
 * ## 自动召回（memory_preflight）
 *
 * 基于你这次 wake-up 任务，runtime 自动检索了相关上下文：
 *
 * **Query 1**: "F018 SessionBootstrap 续接逻辑"  (source=task_summary)
 * - 命中: [wiki/concepts/F018.md] (score 0.92) [injected]
 * - Excerpt: "F018 把 ThreadMemory rolling summary..."
 *
 * **Query 2**: "B022 4 源冗余修复"  (source=task_summary)
 * - 命中: [wiki/bugReport/B022.md] (score 0.88) [injected]
 *
 * **Query 3**: "黄仁勋 unresolved threads"  (source=unresolved_threads)
 * - 中置信（仅 Inspector）: [agent-sessions/.../current.md] (score 0.68)
 *
 * > 主动深挖：read_wiki(path) / search_wiki(query) / query_messages
 */

import type {
  QualityGateBuckets,
  RecallHit,
  RecallQuery,
  RecallResult,
  RecallScenario,
} from "./types"

const SCENARIO_TEXT: Record<RecallScenario, string> = {
  wake_up: "wake-up",
  a2a_handoff: "A2A handoff",
  session_bootstrap: "session bootstrap",
  turn: "turn",
}

export function renderTaskMemoryPack(
  queries: RecallQuery[],
  results: RecallResult[],
  buckets: QualityGateBuckets,
  scenario: RecallScenario,
): string {
  const lines: string[] = []
  lines.push("## 自动召回（memory_preflight）")
  lines.push("")
  lines.push(`基于你这次 ${SCENARIO_TEXT[scenario]} 任务，runtime 自动检索了相关上下文：`)
  lines.push("")

  // 命中 path → bucket 归属（O(N)，hit 数远 < 100）
  const injectedSet = new Set(buckets.injected.map((h) => h.path))
  const inspectorSet = new Set(buckets.inspectorOnly.map((h) => h.path))

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]
    const r = results[i]
    lines.push(`**Query ${i + 1}**: "${escapeMarkdown(q.query)}"  (source=${q.source})`)
    if (!r || r.hits.length === 0) {
      lines.push("- 未命中")
      lines.push("")
      continue
    }
    // 按 score 降序展示
    const sortedHits = [...r.hits].sort((a, b) => b.score - a.score)
    for (const hit of sortedHits) {
      const label = injectedSet.has(hit.path)
        ? "[injected]"
        : inspectorSet.has(hit.path)
          ? "[inspector-only]"
          : "[rejected]"
      lines.push(`- 命中: [${hit.path}] (score ${hit.score.toFixed(2)}) ${label}`)
      const excerptOneLine = hit.excerpt.replace(/\s+/g, " ").slice(0, 200)
      if (excerptOneLine.length > 0) {
        lines.push(`  - Excerpt: ${excerptOneLine}`)
      }
      if (hit.sourceHash) {
        lines.push(`  - Source hash: ${hit.sourceHash}`)
      }
    }
    lines.push("")
  }

  if (buckets.rejected.length > 0) {
    lines.push(
      `> ${buckets.rejected.length} hit 被 Quality Gate reject（below_floor / duplicate / token_budget）`,
    )
    lines.push("")
  }

  lines.push("> 主动深挖：read_wiki(path) / search_wiki(query) / query_messages")
  return lines.join("\n")
}

/**
 * Phase 1 简化 escape：去掉控制字符 + 限制单行（防注入 markdown header 截断我们自己的 wrapper）
 * 注：assemblePrompt 已经过 sanitizeHandoffBody，这里只保证 packMarkdown 自身可读
 */
function escapeMarkdown(s: string): string {
  return s.replace(/[\r\n]/g, " ").slice(0, 200)
}

/**
 * Helper: 给 assemblePrompt 的 memoryPreflight.hits shape
 *   { score: number; summary: string; path?: string }[]
 * （context-assembler.ts:79-81 形状）
 */
export function toAssemblePromptHits(hit: RecallHit): {
  score: number
  summary: string
  path?: string
} {
  return {
    score: hit.score,
    summary: hit.excerpt,
    path: hit.path,
  }
}
