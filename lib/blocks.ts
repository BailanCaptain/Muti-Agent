import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { parseRichSegments } from "./rich-content"

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

export type ImageBlock = {
  kind: "image"
  url: string
  alt?: string
  meta?: { source?: string; timestamp?: string; viewport?: { width: number; height: number } }
}

export type ChecklistBlock = {
  kind: "checklist"
  id: string
  title?: string
  items: Array<{ id: string; text: string; checked?: boolean }>
}

// F036 #10：以下两型与 @multi-agent/shared 的 Rich{Table,Progress}Block z.infer 结构一致
// （parseRichSegments 把 schema 验证后的 result.data 直接当 Block push）。
export type TableBlock = {
  kind: "table"
  id: string
  title?: string
  columns: string[]
  rows: string[][]
}

export type ProgressBlock = {
  kind: "progress"
  id: string
  title?: string
  items: Array<{
    label: string
    value: number
    tone?: "info" | "success" | "warning" | "danger"
    caption?: string
  }>
}

export type Block =
  | MarkdownBlock
  | ThinkingBlock
  | CardBlock
  | DiffBlock
  | ImageBlock
  | ChecklistBlock
  | TableBlock
  | ProgressBlock

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

  // 2. Main content → markdown（F030：assistant 消息走 cc_rich 围栏解析，
  //    切出 card/checklist 交错段；通道语义是 agent→小孙，user 粘贴围栏不触发）
  if (message.content) {
    if (message.role === "assistant") {
      blocks.push(...parseRichSegments(message.content))
    } else {
      blocks.push({ kind: "markdown", content: message.content })
    }
  }

  // 3. ContentBlocks → typed blocks (F008 AC7)
  if (message.contentBlocks) {
    for (const cb of message.contentBlocks) {
      if (cb.type === "image") {
        blocks.push({
          kind: "image",
          url: cb.url,
          alt: cb.alt,
          meta: cb.meta,
        })
      }
    }
  }

  return blocks
}
