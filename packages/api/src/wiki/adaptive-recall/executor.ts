/**
 * F027 P13.1 · AdaptiveRecallExecutor
 * 真相源：docs/plans/V16.5-final.md chap 12（行 1367-1444）
 *
 * 5 级 fallback 状态机：
 *   L1 taskMemoryPack 注入常驻 → critique 评估
 *      → satisfied: 停 (recall_path=1)
 *      → 不够: L2
 *   L2 search_wiki (BM25 + cosine) → critique
 *   L3 query_messages (FTS5) → critique
 *   L4 read_wiki(specific path)（严格模式：仅 critique 给 exact path）→ critique
 *   L5 escalate (写 wiki_events) — 不再 critique
 *
 * Budget 强制：maxLevels / maxTotalMs / maxCritiqueCalls 任一触顶 → 强制 L5 escalate。
 */

import type {
  CritiqueInput,
  CritiqueVerdict,
  ExecuteInput,
  ExecuteOutput,
  ExecutorDeps,
  LevelAttempt,
  RecallBudget,
} from "./types"
import { DEFAULT_RECALL_BUDGET } from "./types"
import type { RecallHit } from "../memory-preflight/types"

const LEVEL2_TOPK = 5
const LEVEL3_TOPK = 10

export async function executeAdaptiveRecall(
  input: ExecuteInput,
  deps: ExecutorDeps,
): Promise<ExecuteOutput> {
  const budget: RecallBudget = { ...DEFAULT_RECALL_BUDGET, ...input.budget }
  const now = deps.now ?? Date.now
  const startMs = now()
  const attempts: LevelAttempt[] = []
  const visitedLevels: number[] = []
  let critiqueCalls = 0
  let budgetExceeded = false

  const remainingMs = (): number => budget.maxTotalMs - (now() - startMs)
  const budgetLeft = (): boolean =>
    remainingMs() > 0 && critiqueCalls < budget.maxCritiqueCalls

  const escalate = async (
    reason: string,
    lastHits: ReadonlyArray<RecallHit>,
    lastLevel: 1 | 2 | 3 | 4,
  ): Promise<ExecuteOutput> => {
    const escalateMs = now()
    await deps.level5.escalate({
      roomId: input.roomId,
      alias: input.alias,
      trigger: input.trigger,
      query: input.query,
      visitedLevels,
      reason,
      totalMs: escalateMs - startMs,
      critiqueCalls,
    })
    attempts.push({
      level: 5,
      hitsCount: 0,
      satisfied: false,
      ms: now() - escalateMs,
      reason,
    })
    return {
      recallPath: 5,
      recallSatisfied: false,
      hits: lastHits,
      totalMs: now() - startMs,
      critiqueCalls,
      budgetExceeded,
      escalateReason: reason,
      attempts,
    }
  }

  // ─── Level 1: taskMemoryPack 复用 ─────────────────────────────────────
  let lastHits: ReadonlyArray<RecallHit> = []
  if (budget.reuseTaskMemoryPack && input.taskMemoryPack && input.taskMemoryPack.length > 0) {
    lastHits = input.taskMemoryPack
    visitedLevels.push(1)
    const l1Start = now()
    const verdict = await runCritique(deps, startMs, critiqueCalls, budget, {
      trigger: input.trigger,
      query: input.query,
      level: 1,
      hits: lastHits,
      visitedLevels,
    })
    if (verdict === "budget_critique" || verdict === "budget_time") {
      budgetExceeded = true
      const budgetReason = verdict === "budget_time" ? "max_total_ms_exceeded" : "critique_budget_exceeded"
      attempts.push({
        level: 1,
        hitsCount: lastHits.length,
        satisfied: false,
        ms: now() - l1Start,
        reason: budgetReason,
      })
      return escalate(`${budgetReason}_at_l1`, lastHits, 1)
    }
    critiqueCalls++
    attempts.push({
      level: 1,
      hitsCount: lastHits.length,
      satisfied: verdict.satisfied,
      ms: now() - l1Start,
      reason: verdict.reason,
    })
    if (verdict.satisfied) {
      return {
        recallPath: 1,
        recallSatisfied: true,
        hits: lastHits,
        totalMs: now() - startMs,
        critiqueCalls,
        budgetExceeded,
        attempts,
      }
    }
    if ("escalate" in verdict && verdict.escalate) {
      return escalate(verdict.reason, lastHits, 1)
    }
  }

  // ─── Level 2: search_wiki ─────────────────────────────────────────────
  if (budget.maxLevels >= 2) {
    if (!budgetLeft()) {
      budgetExceeded = true
      return escalate("budget_exceeded_before_l2", lastHits, 1)
    }
    const l2Start = now()
    const hits = await deps.level2.searchWiki(input.query, LEVEL2_TOPK)
    visitedLevels.push(2)
    lastHits = hits
    const verdict = await runCritique(deps, startMs, critiqueCalls, budget, {
      trigger: input.trigger,
      query: input.query,
      level: 2,
      hits,
      visitedLevels,
    })
    if (verdict === "budget_critique" || verdict === "budget_time") {
      budgetExceeded = true
      const budgetReason = verdict === "budget_time" ? "max_total_ms_exceeded" : "critique_budget_exceeded"
      attempts.push({
        level: 2,
        hitsCount: hits.length,
        satisfied: false,
        ms: now() - l2Start,
        reason: budgetReason,
      })
      return escalate(`${budgetReason}_at_l2`, hits, 2)
    }
    critiqueCalls++
    attempts.push({
      level: 2,
      hitsCount: hits.length,
      satisfied: verdict.satisfied,
      ms: now() - l2Start,
      reason: verdict.reason,
    })
    if (verdict.satisfied) {
      return {
        recallPath: 2,
        recallSatisfied: true,
        hits,
        totalMs: now() - startMs,
        critiqueCalls,
        budgetExceeded,
        attempts,
      }
    }
    if ("escalate" in verdict && verdict.escalate) {
      return escalate(verdict.reason, hits, 2)
    }
  }

  // ─── Level 3: query_messages ──────────────────────────────────────────
  if (budget.maxLevels >= 3) {
    if (!budgetLeft()) {
      budgetExceeded = true
      return escalate("budget_exceeded_before_l3", lastHits, 2)
    }
    const l3Start = now()
    const hits = await deps.level3.queryMessages(input.query, {
      roomId: input.roomId,
      topK: LEVEL3_TOPK,
    })
    visitedLevels.push(3)
    lastHits = hits
    const verdict = await runCritique(deps, startMs, critiqueCalls, budget, {
      trigger: input.trigger,
      query: input.query,
      level: 3,
      hits,
      visitedLevels,
    })
    if (verdict === "budget_critique" || verdict === "budget_time") {
      budgetExceeded = true
      const budgetReason = verdict === "budget_time" ? "max_total_ms_exceeded" : "critique_budget_exceeded"
      attempts.push({
        level: 3,
        hitsCount: hits.length,
        satisfied: false,
        ms: now() - l3Start,
        reason: budgetReason,
      })
      return escalate(`${budgetReason}_at_l3`, hits, 3)
    }
    critiqueCalls++
    attempts.push({
      level: 3,
      hitsCount: hits.length,
      satisfied: verdict.satisfied,
      ms: now() - l3Start,
      reason: verdict.reason,
    })
    if (verdict.satisfied) {
      return {
        recallPath: 3,
        recallSatisfied: true,
        hits,
        totalMs: now() - startMs,
        critiqueCalls,
        budgetExceeded,
        attempts,
      }
    }
    if ("escalate" in verdict && verdict.escalate) {
      return escalate(verdict.reason, hits, 3)
    }
    // Level 4 trigger: 仅 critique 输出 specificPath（严格模式）
    if (budget.maxLevels >= 4 && !verdict.satisfied && "nextLevel" in verdict
        && verdict.nextLevel === 4 && verdict.specificPath) {
      return await tryLevel4(verdict.specificPath, hits)
    }
  }

  // L1-L3 全部 not satisfied 且未触发 L4 → escalate
  return escalate("levels_exhausted_no_satisfaction", lastHits, 3)

  async function tryLevel4(
    path: string,
    prevHits: ReadonlyArray<RecallHit>,
  ): Promise<ExecuteOutput> {
    if (!budgetLeft()) {
      budgetExceeded = true
      return escalate("budget_exceeded_before_l4", prevHits, 3)
    }
    const l4Start = now()
    const hit = await deps.level4.readWiki(path)
    visitedLevels.push(4)
    const hits = hit ? [hit] : []
    if (hits.length === 0) {
      attempts.push({
        level: 4,
        hitsCount: 0,
        satisfied: false,
        ms: now() - l4Start,
        reason: "read_wiki_path_not_found",
        meta: { path },
      })
      return escalate("l4_path_not_found", prevHits, 4)
    }
    const verdict = await runCritique(deps, startMs, critiqueCalls, budget, {
      trigger: input.trigger,
      query: input.query,
      level: 4,
      hits,
      visitedLevels,
    })
    if (verdict === "budget_critique" || verdict === "budget_time") {
      budgetExceeded = true
      const budgetReason = verdict === "budget_time" ? "max_total_ms_exceeded" : "critique_budget_exceeded"
      attempts.push({
        level: 4,
        hitsCount: hits.length,
        satisfied: false,
        ms: now() - l4Start,
        reason: budgetReason,
        meta: { path },
      })
      return escalate(`${budgetReason}_at_l4`, hits, 4)
    }
    critiqueCalls++
    attempts.push({
      level: 4,
      hitsCount: hits.length,
      satisfied: verdict.satisfied,
      ms: now() - l4Start,
      reason: verdict.reason,
      meta: { path },
    })
    if (verdict.satisfied) {
      return {
        recallPath: 4,
        recallSatisfied: true,
        hits,
        totalMs: now() - startMs,
        critiqueCalls,
        budgetExceeded,
        attempts,
      }
    }
    return escalate(verdict.reason, hits, 4)
  }
}

/**
 * 运行 critique，加 budget 检查。返：
 *   - CritiqueVerdict — 正常返回
 *   - "budget_critique" — critique 调用次数 cap 触顶（V16.5 行 1418 maxCritiqueCalls）
 *   - "budget_time" — 总耗时 cap 触顶（V16.5 行 1417 maxTotalMs）
 *
 * 范-r1 P1-1 修：critique **调用前 + 调用后** 都查 maxTotalMs，防"慢 critique 返
 * satisfied 时绕过 cap"路径。caller 收到 budget_time 必须 escalate（同 budget_critique）。
 */
async function runCritique(
  deps: ExecutorDeps,
  startMs: number,
  currentCritiqueCalls: number,
  budget: RecallBudget,
  input: CritiqueInput,
): Promise<CritiqueVerdict | "budget_critique" | "budget_time"> {
  const now = deps.now ?? Date.now
  if (now() - startMs > budget.maxTotalMs) {
    return "budget_time"
  }
  if (currentCritiqueCalls >= budget.maxCritiqueCalls) {
    return "budget_critique"
  }
  const verdict = await deps.critique.evaluate(input)
  // 关键：critique 调用本身可能耗时，调用后再查 maxTotalMs（防 satisfied 绕过 cap）
  if (now() - startMs > budget.maxTotalMs) {
    return "budget_time"
  }
  return verdict
}
