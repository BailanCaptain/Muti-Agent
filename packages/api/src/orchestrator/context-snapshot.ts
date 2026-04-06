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

/**
 * Tiered context snapshot type — defined locally to avoid depending on
 * a shared package version that may not yet include it. Structurally
 * identical to TieredContextSnapshot in @multi-agent/shared.
 */
export type TieredContextSnapshot = {
  /** L1 rolling summary of the conversation so far (~1K tokens) */
  rollingSummary: string | null
  /** The target agent's own recent messages, full text (~2K tokens) */
  selfHistory: Array<{ role: "user" | "assistant"; content: string; createdAt: string }>
  /** Recent cross-agent messages with head+tail truncation (~3K tokens) */
  recentGlobal: Array<{
    agentId: string
    role: "user" | "assistant"
    content: string
    createdAt: string
  }>
}

export type TieredContextOptions = {
  allMessages: readonly RawMessage[]
  threadMeta: ReadonlyMap<string, ThreadMeta>
  triggerMessageId: string
  targetProvider: Provider
  rollingSummary: string | null
  selfHistoryLimit?: number       // default 5
  recentGlobalLimit?: number      // default 10
  maxContentLength?: number       // default 800 (per message)
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

// ── buildTieredContext ───────────────────────────────────────────────

/**
 * Build a tiered context snapshot with:
 * 1. Rolling summary (L1)
 * 2. Self-history: target agent's own messages, full text
 * 3. Recent global: cross-agent messages with head+tail truncation
 */
export function buildTieredContext(options: TieredContextOptions): TieredContextSnapshot {
  const selfHistoryLimit = options.selfHistoryLimit ?? 5
  const recentGlobalLimit = options.recentGlobalLimit ?? 10
  const maxContentLength = options.maxContentLength ?? 800

  // 1. Sort all messages by createdAt, filter up to triggerMessageId
  const sorted = [...options.allMessages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  const triggerIndex = sorted.findIndex((m) => m.id === options.triggerMessageId)
  const upToTrigger = triggerIndex === -1 ? sorted : sorted.slice(0, triggerIndex + 1)

  // 2. Extract "self history": messages where threadMeta maps to targetProvider
  const selfMessages = upToTrigger.filter((m) => {
    const meta = options.threadMeta.get(m.threadId)
    return meta?.provider === options.targetProvider
  })

  const selfHistory = selfMessages.slice(-selfHistoryLimit).map((m) => ({
    role: m.role,
    content: m.content, // Full text, no truncation
    createdAt: m.createdAt,
  }))

  // Collect self message IDs to deduplicate
  const selfMessageIds = new Set(selfMessages.slice(-selfHistoryLimit).map((m) => m.id))

  // 3. Extract "recent global": last M messages across all threads, with head+tail truncation
  // Remove duplicates (messages in self-history shouldn't also appear in recent-global)
  const globalCandidates = upToTrigger.filter((m) => !selfMessageIds.has(m.id))
  const recentGlobalRaw = globalCandidates.slice(-recentGlobalLimit)

  const recentGlobal = recentGlobalRaw.map((m) => {
    const meta = options.threadMeta.get(m.threadId)
    return {
      agentId: m.role === "user" ? "user" : (meta?.alias ?? "unknown"),
      role: m.role,
      content: truncateHeadTail(m.content, maxContentLength),
      createdAt: m.createdAt,
    }
  })

  return {
    rollingSummary: options.rollingSummary,
    selfHistory,
    recentGlobal,
  }
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
