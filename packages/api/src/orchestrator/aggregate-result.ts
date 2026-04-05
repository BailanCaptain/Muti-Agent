import type { Provider } from "@multi-agent/shared"
import type { Phase2Reply } from "./parallel-group"

type AggregateInput = {
  question: string | null
  completedResults: Map<Provider, { messageId: string; content: string }>
}

/**
 * Render a parallel group's completed results into a single markdown bubble.
 * Fed into ConnectorMessage.content and shown in the originator's timeline.
 * Insertion order of `completedResults` is preserved (Map iteration order).
 */
export function generateAggregatedResult(
  input: AggregateInput,
  aliases: Record<Provider, string>,
): string {
  const lines: string[] = ["## 并行思考结果汇总", ""]
  if (input.question) {
    lines.push(`**问题**: ${input.question}`, "")
  }
  for (const [provider, result] of input.completedResults) {
    lines.push(`### ${aliases[provider] ?? provider}`)
    lines.push(result.content.length > 0 ? result.content : "(空回答)")
    lines.push("")
  }
  return lines.join("\n")
}

/**
 * Render Phase 2 serial discussion replies into a markdown bubble.
 * Grouped by round, each showing the agent's reply in speaking order.
 * Fed into a separate ConnectorMessage so Phase 1 and Phase 2 stay distinct.
 */
export function generatePhase2Result(
  replies: Phase2Reply[],
  aliases: Record<Provider, string>,
): string {
  const lines: string[] = ["## 串行讨论记录（Phase 2）", ""]
  if (replies.length === 0) {
    lines.push("(无讨论记录)")
    return lines.join("\n")
  }

  let currentRound = 0
  for (const reply of replies) {
    if (reply.round !== currentRound) {
      if (currentRound !== 0) lines.push("")
      lines.push(`### 第 ${reply.round} 轮`)
      currentRound = reply.round
    }
    const alias = aliases[reply.provider] ?? reply.provider
    lines.push(`**${alias}**：`)
    lines.push(reply.content.length > 0 ? reply.content : "(空回答)")
    lines.push("")
  }
  return lines.join("\n")
}
