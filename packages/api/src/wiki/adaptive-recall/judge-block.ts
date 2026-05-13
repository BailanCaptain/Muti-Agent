/**
 * F027 P13.5 · Judge BLOCKED lint
 * 真相源：docs/plans/V16.5-final.md chap 12 行 1440-1444
 *
 * 拦截规则：
 *   recall_required=true & recall_satisfied=false & agent output 含"历史结论"
 *   且未带证据链 cite → **BLOCKED**
 *
 * 设计：
 *   - 历史结论模式：含"之前/上次/已经/一直以来/上回/前几天" + 完整动作描述
 *     （决定/拍/说/敲定/定了/改了/通过/确认/讨论过等）
 *   - 证据链 cite 检测：含 `[msg_xxx]` / `[decision_id=N]` / `[D-N]` / `[msg_<uuid>]`
 *     → 视为带证据，PASS
 *   - 没含历史结论 → PASS（agent 没乱说就不卡）
 */

import type { RecallHit } from "../memory-preflight/types"

/** 历史关键词（"之前/上次/已经..."） + 完整动作描述（决定/拍/说...）的组合 */
const HISTORY_CLAIM_PATTERNS: RegExp[] = [
  /(?:之前|上次|上回|早前|前几天|前阵子|历史上).{0,30}(?:决定|拍(?:了|板|过)?|说(?:过|了)|讨论(?:过|了)|敲定|定了|改了|通过|确认|做了|完成|跑过)/,
  /(?:已经|已).{0,15}(?:决定|拍(?:了|板|过)?|确认|完成|跑过|改了|敲定)/,
  /(?:一直以来|一直).{0,20}(?:都|是|按).{0,30}/,
  /我们.{0,5}(?:之前|上次).{0,30}/,
]

/** 证据链 cite 模式（任一命中视为带证据，PASS） */
const CITE_PATTERNS: RegExp[] = [
  /\[msg_[\w-]+/i, // [msg_uuid] / [msg_R-201-001]
  /\[decision_id\s*=\s*\d+/i, // [decision_id=42]
  /\[D-\d+/, // [D-12]
  /\[a2a_call\s*=\s*call-[\w-]+/i, // [a2a_call=call-xxx]（F026 引用）
]

export interface JudgeBlockInput {
  /** prompt_audit.recall_required */
  recallRequired: boolean
  /** prompt_audit.recall_satisfied */
  recallSatisfied: boolean
  /** agent 输出的 draft 文本 */
  agentOutput: string
  /** （可选）成功召回的 hits — 用于 cite 合法性二次校验（P13.5 主路径不用） */
  recallHits?: ReadonlyArray<RecallHit>
}

export type JudgeBlockVerdict =
  | { blocked: false; reason: string }
  | { blocked: true; reason: string; matchedPattern: string }

/**
 * 判定 agent output 是否应被 BLOCKED。
 *
 * 决策表：
 * |  required | satisfied | hasHistoryClaim | hasCite | verdict |
 * |-----------|-----------|-----------------|---------|---------|
 * | false     | *         | *               | *       | pass (gate 不卡) |
 * | true      | true      | *               | *       | pass (召回成功) |
 * | true      | false     | false           | *       | pass (agent 没乱说) |
 * | true      | false     | true            | true    | pass (有证据链 cite) |
 * | true      | false     | true            | false   | **BLOCKED** ★ |
 */
export function judgeRecallBlock(input: JudgeBlockInput): JudgeBlockVerdict {
  if (!input.recallRequired) {
    return { blocked: false, reason: "recall_not_required" }
  }
  if (input.recallSatisfied) {
    return { blocked: false, reason: "recall_satisfied" }
  }

  // recall_required=true & recall_satisfied=false → 检 agent 是否乱说历史
  const matched = matchHistoryClaim(input.agentOutput)
  if (!matched) {
    return { blocked: false, reason: "no_history_claim_in_output" }
  }

  if (hasCiteEvidence(input.agentOutput)) {
    return { blocked: false, reason: "history_claim_but_cited" }
  }

  return {
    blocked: true,
    reason: "agent_claims_history_without_recall_or_cite",
    matchedPattern: matched,
  }
}

function matchHistoryClaim(text: string): string | null {
  for (const p of HISTORY_CLAIM_PATTERNS) {
    if (p.test(text)) {
      return p.source.slice(0, 60)
    }
  }
  return null
}

function hasCiteEvidence(text: string): boolean {
  for (const p of CITE_PATTERNS) {
    if (p.test(text)) return true
  }
  return false
}
