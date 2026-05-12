/**
 * F027 P11 · Hard Gate（chap 12 行 1369-1395）
 * detectRecallTrigger 两层：
 *   1. deterministic（快、确定）
 *      - scenario === 'a2a_handoff' → required
 *      - draft 含修改 plan/wiki 操作 → required
 *      - draft 含 review 操作 → required
 *      - draft 引用 message_id / decision_id → not required（已带证据）
 *   2. LLM 只判 edge case
 *      - draft 含 "之前/上次/已决定/一直以来" 但无证据链 → LLM judge
 *      - 其他 → not required
 *
 * Phase 1 边界：LLM judge backend stub（caller 传 null 时走保守 required=true）。
 */

import type { RecallJudgeProvider, TriggerContext, TriggerResult } from "./types"

const HISTORY_KEYWORD = /(之前|上次|已决定|已经决定|一直以来|历史决策|历史上|曾经)/
const MODIFY_WIKI = /(修改|改|更新|update|edit|amend).{0,8}(plan|wiki|spec|feature|design|sop)/i
const REVIEW_KEYWORD = /\b(review|审核|过一眼|review一下|check一下)\b/i

export async function detectRecallTrigger(
  ctx: TriggerContext,
  judge: RecallJudgeProvider | null,
): Promise<TriggerResult> {
  // ─── 第一层 deterministic ─────────────────────────────────────────────
  if (ctx.scenario === "a2a_handoff") {
    return { required: true, trigger: "a2a_handoff", source: "deterministic" }
  }
  if (ctx.scenario === "session_bootstrap") {
    return { required: true, trigger: "session_bootstrap", source: "deterministic" }
  }

  const draft = ctx.draft ?? ""

  if (MODIFY_WIKI.test(draft)) {
    return { required: true, trigger: "modify_plan_or_wiki", source: "deterministic" }
  }
  if (REVIEW_KEYWORD.test(draft)) {
    return { required: true, trigger: "review_action", source: "deterministic" }
  }

  const hasCitedEvidence =
    (ctx.citedMessageIds && ctx.citedMessageIds.length > 0) ||
    (ctx.citedDecisionIds && ctx.citedDecisionIds.length > 0)
  if (hasCitedEvidence) {
    return { required: false, trigger: "evidence_already_cited", source: "deterministic" }
  }

  // ─── 第二层 LLM 只判 edge case ────────────────────────────────────────
  if (HISTORY_KEYWORD.test(draft)) {
    if (!judge) {
      // 保守：无 judge 时含历史关键词 → required，避免 false negative 让 agent 编造
      return {
        required: true,
        trigger: "history_keyword_no_judge",
        source: "none",
      }
    }
    const j = await judge.judge({ draft, context: ctx })
    return {
      required: j.required,
      trigger: j.reason,
      source: "llm_judge",
    }
  }

  return { required: false, trigger: "turn_local", source: "deterministic" }
}

/**
 * Phase 1 默认 stub judge：始终 required=true（保守）。
 * 真 LLM judge 在 P13 (Adaptive Recall) 接入。
 */
export const conservativeStubJudge: RecallJudgeProvider = {
  async judge({ draft }) {
    return {
      required: true,
      reason: `stub_judge_default_required (draft_len=${draft.length})`,
    }
  },
}
