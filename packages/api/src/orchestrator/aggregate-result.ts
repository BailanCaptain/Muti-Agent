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
 * A structured decision item extracted from agent output.
 * Agents mark items with `[拍板]` and optionally provide `[A]/[B]/…` options.
 */
export type DecisionItemParsed = {
  question: string
  options: string[]
}

/**
 * Extract `[拍板]`-tagged items from an agent reply.
 *
 * Supports two formats:
 *
 * Simple (backward-compat):
 *   [拍板] 需要用户决定的问题
 *
 * Structured (preferred):
 *   [拍板] 需要用户决定的问题
 *     [A] 选项一
 *     [B] 选项二
 */
export function extractDecisionItems(content: string): DecisionItemParsed[] {
  const items: DecisionItemParsed[] = []
  const lines = content.split(/\r?\n/)
  let i = 0

  while (i < lines.length) {
    const line = lines[i].trim()
    const paibanMatch = line.match(/^\[(?:拍板|分歧点)\]\s*(.+)$/)

    if (!paibanMatch) {
      i++
      continue
    }

    const item: DecisionItemParsed = { question: paibanMatch[1].trim(), options: [] }
    i++

    // Collect [A]/[B]/… option lines that follow
    while (i < lines.length) {
      const optLine = lines[i].trim()

      // Skip blank lines between [拍板] and options
      if (!optLine) {
        i++
        continue
      }

      const optMatch = optLine.match(/^\[([A-Z])\]\s*(.+)$/)
      if (optMatch) {
        item.options.push(optMatch[2].trim())
        i++
        continue
      }

      // Non-option content — stop collecting for this item
      break
    }

    items.push(item)
  }

  return items
}

/**
 * Extract `[撤销拍板]` markers. Each line of the form
 * `[撤销拍板] <substring>` yields one withdrawal substring. Lines with
 * no text after the marker are ignored.
 */
export function extractWithdrawals(content: string): string[] {
  const results: string[] = []
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const match = line.trim().match(/^\[(?:撤销拍板|撤销分歧点)\]\s*(.+)$/)
    if (match && match[1].trim()) {
      results.push(match[1].trim())
    }
  }
  return results
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
