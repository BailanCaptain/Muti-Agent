import type { Provider } from "@multi-agent/shared"
import type { Phase2Reply } from "./parallel-group"

/**
 * Build the Phase 2 (serial discussion) turn prompt for one agent.
 *
 * Phase 2 runs after Phase 1 parallel independent thinking is complete.
 * In Phase 2, agents take turns in @-mention order, each seeing:
 *   - Phase 1 aggregate (everyone's independent answer)
 *   - All Phase 2 replies posted so far in prior rounds AND this round
 *
 * This lets agents react to each other, surface consensus / disagreement,
 * and converge — without a synthesizer speaking for them prematurely.
 */
export function buildPhase2Turn(input: {
  agentAlias: string
  round: number
  totalRounds: number
  phase1Aggregate: string
  priorReplies: Phase2Reply[]
  aliases: Record<Provider, string>
}): string {
  const { agentAlias, round, totalRounds, phase1Aggregate, priorReplies, aliases } = input

  const lines: string[] = [
    `[当前模式：串行讨论 · Phase 2 · 第 ${round}/${totalRounds} 轮]`,
    `你是 ${agentAlias}。请按顺序发言，参考上面所有人已经说过的话。`,
    "",
    "规则：",
    "- 明确你同意/不同意哪些观点，给理由",
    "- 基于他人发言更新你的立场（如果被说服了就直说）",
    "- 不要复述已经达成的共识，只补充新观点或分歧",
    "- 发言要精炼，不要写长篇大论",
    "- 不要替村长做最终决策，也不要扮演综合者",
    "- 如果讨论中出现了需要村长拍板的取舍（满足拍板三条件时），用结构化格式：",
    "  ```",
    "  [拍板] 问题描述",
    "    [A] 选项一",
    "    [B] 选项二",
    "  ```",
    "  每条 [拍板] 必须附带至少两个 [A]/[B]/… 选项，让村长直接选",
    "- 如果你已经没有新观点或分歧要补充，回复的最后一行只写 [consensus]（不加任何其他字）",
    "",
    "--- Phase 1 独立思考汇总 ---",
    phase1Aggregate,
  ]

  if (priorReplies.length > 0) {
    lines.push("", "--- Phase 2 讨论记录 ---")
    for (const reply of priorReplies) {
      const alias = aliases[reply.provider] ?? reply.provider
      lines.push(`[第 ${reply.round} 轮 · ${alias}]: ${reply.content}`)
    }
  }

  lines.push("", `--- 轮到你（${agentAlias}）发言 ---`)

  return lines.join("\n")
}
