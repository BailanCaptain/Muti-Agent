import type { Provider, TimelineMessage } from "@multi-agent/shared"

// ── Block types ─────────────────────────────────────────────────────

export type MarkdownBlock = {
  kind: "markdown"
  content: string
}

export type ThinkingBlock = {
  kind: "thinking"
  content: string
  provider: Provider
}

export type CardBlock = {
  kind: "card"
  id: string
  title: string
  bodyMarkdown?: string
  tone?: "info" | "success" | "warning" | "danger"
  fields?: Array<{ label: string; value: string }>
}

export type DiffBlock = {
  kind: "diff"
  id: string
  filePath: string
  diff: string
}

export type Block = MarkdownBlock | ThinkingBlock | CardBlock | DiffBlock

// ── normalizeMessageToBlocks ────────────────────────────────────────

/**
 * Convert a TimelineMessage into a normalized Block array.
 *
 * AC6  — unified rendering path for content / thinking / inlineConfirmations.
 * AC10 — backward compat: when no structured blocks exist the message
 *        content falls back to a single markdown block.
 */
export function normalizeMessageToBlocks(message: TimelineMessage): Block[] {
  const blocks: Block[] = []

  // 1. Thinking always comes first (rendered separately by message-bubble)
  if (message.thinking) {
    blocks.push({
      kind: "thinking",
      content: message.thinking,
      provider: message.provider,
    })
  }

  // 2. Main content → single markdown block (AC10 backward compat)
  if (message.content) {
    blocks.push({ kind: "markdown", content: message.content })
  }

  return blocks
}
