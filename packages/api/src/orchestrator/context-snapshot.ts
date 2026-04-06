import type { Provider } from "@multi-agent/shared"

// ── Types ────────────────────────────────────────────────────────────

export type ContextMessage = {
  id: string
  role: "user" | "assistant"
  agentId: string
  content: string
  createdAt: string
}

export type SnapshotOptions = {
  sessionGroupId: string
  triggerMessageId: string
  maxMessages?: number
}

export type RawMessage = {
  id: string
  threadId: string
  role: "user" | "assistant"
  content: string
  createdAt: string
}

export type ThreadMeta = {
  provider: Provider
  alias: string
}

// ── buildContextSnapshot ─────────────────────────────────────────────

const DEFAULT_MAX_MESSAGES = 20

export function buildContextSnapshot(
  allMessages: readonly RawMessage[],
  threadMeta: ReadonlyMap<string, ThreadMeta>,
  options: SnapshotOptions,
): readonly ContextMessage[] {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES

  const sorted = [...allMessages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  const triggerIndex = sorted.findIndex((m) => m.id === options.triggerMessageId)
  if (triggerIndex === -1) return Object.freeze([])

  const upToTrigger = sorted.slice(0, triggerIndex + 1)
  const windowed = upToTrigger.slice(-maxMessages)

  const result: ContextMessage[] = windowed.map((m) => {
    const meta = threadMeta.get(m.threadId)
    return {
      id: m.id,
      role: m.role,
      agentId: m.role === "user" ? "user" : (meta?.alias ?? "unknown"),
      content: m.content,
      createdAt: m.createdAt,
    }
  })

  return Object.freeze(result)
}

// ── truncateHeadTail ────────────────────────────────────────────────

/**
 * Head+tail truncation: preserves the opening context AND the conclusion.
 * If content fits within maxLength, returns as-is.
 * Otherwise: first 60% + omission marker + last 30%.
 */
export function truncateHeadTail(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content
  }

  const headLen = Math.floor(maxLength * 0.6)
  const tailLen = Math.floor(maxLength * 0.3)
  const omitted = content.length - headLen - tailLen

  return (
    content.slice(0, headLen) +
    `\n...(省略 ${omitted} 字)...\n` +
    content.slice(content.length - tailLen)
  )
}

// ── extractTaskSnippet ───────────────────────────────────────────────

const SENTENCE_BOUNDARY = /[.。\n！!？?]/

export function extractTaskSnippet(content: string, targetAlias: string): string {
  const mention = `@${targetAlias}`
  const mentionPos = content.indexOf(mention)
  if (mentionPos === -1) return content.slice(0, 500)

  // Split on sentence boundaries
  const sentences = content.split(SENTENCE_BOUNDARY)

  // Find the sentence that contains the mention
  let offset = 0
  let matchingSentence = ""
  for (const sentence of sentences) {
    const segmentEnd = offset + sentence.length
    if (mentionPos >= offset && mentionPos < segmentEnd) {
      matchingSentence = sentence.trim()
      break
    }
    // +1 for the delimiter character
    offset = segmentEnd + 1
  }

  if (matchingSentence.length < 20) {
    return content.slice(0, 500)
  }

  return matchingSentence.slice(0, 500)
}
