/**
 * F042 AC6 · direct 召回快链管道（ADR-005）
 *
 * 取代同步场景下的 5 级 executor（executeAdaptiveRecall）：观察窗实证 CLI critique
 * 30s timeout ×2 fallback vs 总预算 5s = 100% 熔断（LL-035），且普通 miss 误入 L5
 * 造 wiki_events 事件风暴。本管道：
 *
 *   compile → L2 wiki lexical → evidence gate → L3 room messages → gate → 正常 miss
 *
 * 硬性质：
 *   - 全程零 LLM / 零 embedding（BM25-only lexical，毫秒级）
 *   - miss 是常态终态：recallSatisfied=false + hits=[] + **无 escalateReason**，
 *     不写 recall_escalate 事件（deps 类型上就没有 level5——静态保证）
 *   - gate 基于命中证据（LL-037：不用 minmax score）；critiqueCalls 恒 0
 *   - deadline 覆盖 backend 调用本身（同步 SQLite 无法中断，wall-clock 硬上限做不到；
 *     德彪 AC6-r1 P1-1：**超时后的结果一律丢弃走 miss**——fail-open = 不注入过期结果，
 *     丢弃事实写入 attempts 审计（r2 P2））
 *
 * 旧 executeAdaptiveRecall / LLM critique 保留为异步标注/离线校准位，退出一切同步路径。
 */

import type { RecallHit } from "../memory-preflight/types"
import { compileRecallFtsQuery, type CompiledFtsQuery } from "../wiki-search/fts-query-compiler"
import type { ExecuteOutput, LevelAttempt } from "./types"

/** ≥2 clause 命中且 coverage 达此下限才放行（fixture 校准起点；shadow 数据攒够后调） */
export const GATE_MIN_COVERAGE = 0.25
/** 快链默认 deadline：500ms 到点跳级 fail-open（p95 目标 200ms） */
export const DIRECT_RECALL_DEADLINE_MS = 500
const DEFAULT_TOP_K = 5

export interface DirectRecallInput {
  query: string
  roomId: string
  trigger: string
  /**
   * L3 排除的消息 id（召回自引用修复）：当前 turn 的用户消息在召回前已落库，
   * 不排除会被 messages FTS 搜回自己（活体实测）——不属于「记忆」。
   */
  excludeMessageIds?: string[]
}

/**
 * 两级 backend 均消费同一 CompiledFtsQuery（compile 一次贯穿）。
 * 实现方负责让返回的 RecallHit 带 evidence（wiki 侧 searchCompiled 自带；
 * messages 侧适配层用 analyzeClauseMatches 对 content 计算）。
 */
export interface DirectRecallDeps {
  searchWiki(compiled: CompiledFtsQuery, topK: number): Promise<RecallHit[]>
  searchMessages(
    compiled: CompiledFtsQuery,
    roomId: string,
    topK: number,
    excludeMessageIds?: string[],
  ): Promise<RecallHit[]>
  /** 测试注入时钟 */
  now?: () => number
}

export interface DirectRecallOptions {
  deadlineMs?: number
  topK?: number
}

/**
 * evidence gate（ADR-005 / LL-037 / 德彪 AC6-r1 P1-2 + r2 P1）：
 *   - **点名场景**（pathMustsPresent）：只放行 exactPathMatch 候选——用户显式指定
 *     文档时意图明确，点名文档不参与 OR 竞争（正文可以不含内容词），无关候选
 *     也不得靠普通 clause gate 顶替它；点名文档不存在 → 如实 miss
 *   - 存在 OR-evidenced 候选（matchedOrClauseCount ≥1）时，零 OR 候选一律淘汰——
 *     「实体高频但内容无关」的噪声不得靠 exactEntityMatch 直通挤占 Recall Pack
 *   - exactEntityMatch 且 OR ≥1 → 直通；exactEntityMatch 且**全场无** OR 候选 →
 *     受限 must-only fallback（如「F042 怎么修」滑窗不在任何文档时仍可召实体文档）
 *   - 非实体：matchedClauseCount ≥2 且 coverage ≥ GATE_MIN_COVERAGE
 *   - 单 clause 偶合 / 无 evidence → 拒（宁 miss 不注噪——错误记忆比没有记忆更毒）
 */
export function evidenceGate(
  hits: ReadonlyArray<RecallHit>,
  opts: { pathMustsPresent?: boolean } = {},
): RecallHit[] {
  if (opts.pathMustsPresent) {
    return hits.filter((h) => h.evidence?.exactPathMatch === true)
  }
  const anyOrEvidenced = hits.some((h) => (h.evidence?.matchedOrClauseCount ?? 0) >= 1)
  return hits.filter((h) => {
    const ev = h.evidence
    if (!ev) return false
    if (anyOrEvidenced && ev.matchedOrClauseCount === 0) return false
    if (ev.exactEntityMatch && ev.matchedOrClauseCount >= 1) return true
    if (ev.exactEntityMatch && !anyOrEvidenced) return true
    return ev.matchedClauseCount >= 2 && ev.clauseCoverage >= GATE_MIN_COVERAGE
  })
}

export async function executeDirectRecall(
  input: DirectRecallInput,
  deps: DirectRecallDeps,
  opts: DirectRecallOptions = {},
): Promise<ExecuteOutput> {
  const now = deps.now ?? Date.now
  const deadlineMs = opts.deadlineMs ?? DIRECT_RECALL_DEADLINE_MS
  const topK = opts.topK ?? DEFAULT_TOP_K
  const startMs = now()
  const attempts: LevelAttempt[] = []
  let budgetExceeded = false

  const compiled = compileRecallFtsQuery(input.query)
  if (compiled.unsupported) {
    return miss(2, "query_unsupported_short_fragments")
  }

  // ─── L2: wiki lexical ───────────────────────────────────────────────
  // 德彪 AC6-r1 P1-1 · deadline 语义 = fail-open **不注入**：backend 是同步 SQLite
  // 不可中断（Promise.race 中断不了阻塞调用），wall-clock 硬上限做不到；做得到的是
  // 「超时后的结果一律丢弃走 miss」——每级返回后先裁 deadline 再裁 gate。
  const l2 = await runLevel(2, () => deps.searchWiki(compiled, topK))
  if (now() - startMs >= deadlineMs) {
    return deadlineMiss(2, "deadline_exceeded_after_l2_hits_discarded")
  }
  if (l2.gated.length > 0) return satisfied(2, l2.gated)

  // 德彪 AC6-r2 P1 配套 · 点名场景短路：pathMusts 非空且 L2 无 path 命中 →
  // 消息没有 wiki path，L3 物理上不可能命中点名文档，直接如实 miss。
  if (compiled.pathMusts.length > 0) {
    return miss(2, "path_musts_not_found")
  }

  // ─── L3: room messages ──────────────────────────────────────────────
  const l3 = await runLevel(3, () =>
    deps.searchMessages(compiled, input.roomId, topK, input.excludeMessageIds),
  )
  if (now() - startMs >= deadlineMs) {
    return deadlineMiss(3, "deadline_exceeded_after_l3_hits_discarded")
  }
  if (l3.gated.length > 0) return satisfied(3, l3.gated)

  return miss(3, "no_gated_hits")

  async function runLevel(
    level: 2 | 3,
    search: () => Promise<RecallHit[]>,
  ): Promise<{ gated: RecallHit[] }> {
    const t0 = now()
    let raw: RecallHit[] = []
    let errorReason: string | null = null
    try {
      raw = await search()
    } catch (err) {
      // fail-soft：backend 异常按空结果继续降级，不击穿消息主链
      errorReason = `backend_error:${err instanceof Error ? err.message.slice(0, 80) : String(err)}`
    }
    const gated = evidenceGate(raw, { pathMustsPresent: compiled.pathMusts.length > 0 })
    attempts.push({
      level,
      hitsCount: raw.length,
      satisfied: gated.length > 0,
      ms: now() - t0,
      reason: errorReason ?? (gated.length > 0 ? "evidence_gate_passed" : "evidence_gate_rejected"),
    })
    if (now() - startMs >= deadlineMs) budgetExceeded = true
    return { gated }
  }

  /**
   * 德彪 AC6-r2 P2 · deadline 丢弃走此出口：追加一条 attempt 把「该级 gate 结论
   * 被 deadline 丢弃」写进审计 trail——否则 trail 只剩 evidence_gate_passed，
   * 读审计的人看不到结果实际没被采用、也看不到丢弃原因。
   */
  function deadlineMiss(level: 2 | 3, reason: string): ExecuteOutput {
    budgetExceeded = true
    attempts.push({
      level,
      hitsCount: 0,
      satisfied: false,
      ms: now() - startMs,
      reason,
    })
    return miss(level, reason)
  }

  function satisfied(level: 2 | 3, hits: RecallHit[]): ExecuteOutput {
    return {
      recallPath: level,
      recallSatisfied: true,
      hits,
      totalMs: now() - startMs,
      critiqueCalls: 0,
      budgetExceeded,
      attempts,
    }
  }

  /**
   * 正常 miss（ADR-005）：不是 escalate——无 escalateReason、不写 L5 事件。
   * unsupported 时 attempts 如实为空（零检索发生）；deadline 丢弃走 deadlineMiss
   * （丢弃原因进 attempts，r2 P2）；_note 供 caller 语义自查。
   */
  function miss(level: 2 | 3, _note: string): ExecuteOutput {
    return {
      recallPath: level,
      recallSatisfied: false,
      hits: [],
      totalMs: now() - startMs,
      critiqueCalls: 0,
      budgetExceeded,
      attempts,
    }
  }
}
