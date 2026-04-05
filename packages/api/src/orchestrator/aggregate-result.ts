import type { Provider } from "@multi-agent/shared"

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
