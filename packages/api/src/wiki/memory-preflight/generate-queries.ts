/**
 * F027 P11 · 召回 query 生成（rule-based 简化版）
 * 真相源：docs/plans/V16.5-final.md chap 10 行 1095 + 1110
 *
 * 范-r1 P1-1 修：spec 行 1095 写 "生成 **2-5 个召回 query**"——硬下限 2。
 *   旧版只 taskSummary 时只返 1 query，违反 spec。
 *   修法：
 *     a. 从 taskSummary 抽 entity ID（F\d+/B\d+/R-\d+/D-\d+）作为高精度第二 query
 *     b. 没 entity ID 时用 `${alias} ${scenario}` 上下文作为 fallback 第二 query
 *     c. 其他源（capability/recent/unresolved）仍按原优先级补到 max
 *     d. cap 时 taskSummary 主 + 派生第二永远保留（不被截掉）
 *
 * 上限：2 ≤ N ≤ 5（chap 10 行 1095 + 1133）。
 *
 * Phase 1 简化：不调 LLM NER，规则化拼字符串。P14 query_messages 落地后可加
 * 真 NER pipeline；P15 BM25 落地后可按 score 反查 query 抽 keyword 调权。
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

/**
 * 范-r1 P1-1: 抽 ID-like entity（F\d+/B\d+/R-\d+/D-\d+）作为高精度路径召回。
 * 例：'F011 drizzle 优化' → ['F011']；'F011 + B022 + R-201 之前 D-018 决策' →
 * ['F011', 'B022', 'R-201', 'D-018']
 */
const ENTITY_REGEX = /\b([FBP]\d{3,4}|R-\d{2,4}|D-\d{2,4})\b/g

function extractEntityIds(text: string): string[] {
  const matches = text.matchAll(ENTITY_REGEX)
  const ids: string[] = []
  for (const m of matches) {
    if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

export function generateRecallQueries(
  ctx: TaskContext,
  opts?: GenerateQueriesOptions,
): RecallQuery[] {
  const taskCap = opts?.taskSummaryCap ?? DEFAULT_TASK_CAP
  const kwTop = opts?.keywordTopN ?? DEFAULT_KEYWORD_TOP
  const utTop = opts?.unresolvedThreadsTopN ?? DEFAULT_UNRESOLVED_TOP
  const maxQ = Math.min(HARD_MAX, Math.max(HARD_MIN, opts?.maxQueries ?? HARD_MAX))

  const queries: RecallQuery[] = []
  const taskTrimmed = ctx.taskSummary.trim()

  // 1. task summary 主 query（最重要，topK=3）
  if (taskTrimmed.length > 0) {
    queries.push({
      query: taskTrimmed.slice(0, taskCap),
      source: "task_summary",
      expectedScoreFloor: 0.6,
      topK: 3,
    })
  }

  // 2. 范-r1 P1-1: taskSummary 派生第二 query（保 spec 行 1095 "≥ 2 query"）
  if (taskTrimmed.length > 0) {
    const entityIds = extractEntityIds(taskTrimmed)
    if (entityIds.length > 0) {
      // entity ID 派生：高精度路径匹配（embedding 对 ID-like 短文本 + 长文档 cos 高）
      queries.push({
        query: entityIds.join(" "),
        source: "task_summary",
        expectedScoreFloor: 0.6,
        topK: 2,
      })
    }
  }

  // 3. capability digest 关键词合并 1 query
  const capKw = (ctx.capabilityDigestKeywords ?? []).filter((s) => s.trim().length > 0)
  if (capKw.length > 0) {
    queries.push({
      query: capKw.slice(0, kwTop).join(" "),
      source: "capability_digest",
      expectedScoreFloor: 0.6,
      topK: 2,
    })
  }

  // 4. 最近 messages 概念合并 1 query
  const recentKw = (ctx.recentMessageConcepts ?? []).filter((s) => s.trim().length > 0)
  if (recentKw.length > 0) {
    queries.push({
      query: recentKw.slice(0, kwTop).join(" "),
      source: "recent_messages",
      expectedScoreFloor: 0.6,
      topK: 2,
    })
  }

  // 5. unresolved threads 每个一 query（最多 2）
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

  // 6. 范-r1 P1-1 fallback: 仍 < HARD_MIN 时补 alias+scenario context query
  //    场景：taskSummary 空/无 entity ID 且其他源也都空 → 至少有个 room context 召回
  if (queries.length < HARD_MIN) {
    const ctxQuery = `${ctx.alias} ${ctx.roomId} ${ctx.scenario.replace(/_/g, " ")}`.trim()
    if (ctxQuery.length > 0 && !queries.some((q) => q.query === ctxQuery)) {
      queries.push({
        query: ctxQuery.slice(0, taskCap),
        source: "task_summary",
        expectedScoreFloor: 0.6,
        topK: 2,
      })
    }
  }

  // Cap 到 maxQueries（taskSummary 主 + 派生第二永远保留）
  return queries.slice(0, maxQ)
}
