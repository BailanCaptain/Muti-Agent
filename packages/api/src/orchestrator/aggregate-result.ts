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

