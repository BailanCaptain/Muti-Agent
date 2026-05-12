/**
 * F027 P11 · 召回 query 生成（rule-based 简化版）
 * 真相源：docs/plans/V16.5-final.md chap 10 行 1110（"taskSummary NER /
 * capability digest 兴趣点 / 最近 messages 概念 / unresolved threads"）
 *
 * Phase 1 简化：不调 LLM NER，规则化拼字符串。P14 query_messages 落地后可加
 * 真 NER pipeline；P15 BM25 落地后可按 score 反查 query 抽 keyword 调权。
 *
 * 上限：2 ≤ N ≤ 5（chap 10 行 1095 + 1133）。
 */

import type { RecallQuery, TaskContext } from "./types"

export interface GenerateQueriesOptions {
  /** 上限 query 数（默认 5，最小 2 — chap 10 行 1095） */
  maxQueries?: number
  /** taskSummary 截断（embedding model 通常 ≤ 512 tok；默认 200 char） */
  taskSummaryCap?: number
  /** keyword 合并取 top N（capability_digest / recent_messages） */
  keywordTopN?: number
  /** unresolved_threads 取前几个（避免 5 个 thread 全占 query 槽） */
  unresolvedThreadsTopN?: number
}

const DEFAULT_TASK_CAP = 200
const DEFAULT_KEYWORD_TOP = 3
const DEFAULT_UNRESOLVED_TOP = 2
const HARD_MAX = 5
const HARD_MIN = 2

export function generateRecallQueries(
  ctx: TaskContext,
  opts?: GenerateQueriesOptions,
): RecallQuery[] {
  const taskCap = opts?.taskSummaryCap ?? DEFAULT_TASK_CAP
  const kwTop = opts?.keywordTopN ?? DEFAULT_KEYWORD_TOP
  const utTop = opts?.unresolvedThreadsTopN ?? DEFAULT_UNRESOLVED_TOP
  const maxQ = Math.min(HARD_MAX, Math.max(HARD_MIN, opts?.maxQueries ?? HARD_MAX))

  const queries: RecallQuery[] = []

  // 1. task summary 主 query（最重要，topK=3）
  const taskTrimmed = ctx.taskSummary.trim()
  if (taskTrimmed.length > 0) {
    queries.push({
      query: taskTrimmed.slice(0, taskCap),
      source: "task_summary",
      expectedScoreFloor: 0.6,
      topK: 3,
    })
  }

  // 2. capability digest 关键词合并 1 query
  const capKw = (ctx.capabilityDigestKeywords ?? []).filter((s) => s.trim().length > 0)
  if (capKw.length > 0) {
    queries.push({
      query: capKw.slice(0, kwTop).join(" "),
      source: "capability_digest",
      expectedScoreFloor: 0.6,
      topK: 2,
    })
  }

  // 3. 最近 messages 概念合并 1 query
  const recentKw = (ctx.recentMessageConcepts ?? []).filter((s) => s.trim().length > 0)
  if (recentKw.length > 0) {
    queries.push({
      query: recentKw.slice(0, kwTop).join(" "),
      source: "recent_messages",
      expectedScoreFloor: 0.6,
      topK: 2,
    })
  }

  // 4. unresolved threads 每个一 query（最多 2）
  const unresolved = (ctx.unresolvedThreads ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, utTop)
  for (const th of unresolved) {
    queries.push({
      query: th.slice(0, taskCap),
      source: "unresolved_threads",
      expectedScoreFloor: 0.6,
      topK: 2,
    })
  }

  // Cap 到 maxQueries（taskSummary 优先级最高，截尾）
  return queries.slice(0, maxQ)
}
