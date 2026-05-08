/**
 * F026-P3 Task5 · Burst Context（cold-target burst 兜底）
 *
 * 抄移自 clowder-ai `domains/cats/services/agents/routing/context-transport.ts`
 * (F148 Hierarchical Context Transport) 的 detectRecentBurst + protectSemanticChains +
 * buildTombstone + formatTombstone 四个纯函数，适配 Multi-Agent 的 ContextMessage 形态：
 *   - StoredMessage.timestamp (ms)   → ContextMessage.createdAt (ISO string)
 *   - StoredMessage.catId (cat 唯一)  → ContextMessage.agentId (alias，user 时为 "user")
 *   - StoredMessage.toolEvents       → 不存在；去掉 tool-chain 保护，仅保 Q→A
 *   - retrieval hint search_evidence → MCP get_room_context, msg_id=<head>~<tail>
 *
 * 适用场景：cold-target（被 @ 的 agent 没有 nativeSessionId、SessionBootstrap 也无料），
 * 在 assemblePrompt content 里注入 burst section 让下游不调 MCP 即可看懂主线。
 */

import type { ContextMessage } from "./context-snapshot"

// ── Types ─────────────────────────────────────────────────────────────

export type BurstConfig = {
  /** 最近 burst 的"安静期"切点，默认 15 min。> gap 视为话题切换。 */
  burstSilenceGapMs: number
  /** burst 最少几条（保最近 N 条不被 gap 切掉）。 */
  minBurstMessages: number
  /** burst 最多几条（防 burst 自身爆体积）。 */
  maxBurstMessages: number
  /** tombstone 关键词上限。 */
  maxTombstoneKeywords: number
}

export const DEFAULT_BURST_CONFIG: BurstConfig = {
  burstSilenceGapMs: 15 * 60_000,
  minBurstMessages: 4,
  maxBurstMessages: 12,
  maxTombstoneKeywords: 5,
}

export type ContextTombstone = {
  omittedCount: number
  timeRange: { from: number; to: number }
  participants: string[]
  keywords: string[]
}

// ── detectRecentBurst ────────────────────────────────────────────────

/**
 * 从消息尾部往前找最近的 burst（紧密对话块），遇到 ≥ burstSilenceGapMs 的安静期切。
 * 保证 ≥ minBurstMessages 条，≤ maxBurstMessages 条。
 * Q→A 边界保护：不在 user 提问 / assistant 回答之间切。
 */
export function detectRecentBurst(
  messages: readonly ContextMessage[],
  config: BurstConfig,
): { burst: ContextMessage[]; omitted: ContextMessage[] } {
  const len = messages.length
  if (len === 0) return { burst: [], omitted: [] }

  const ts = messages.map((m) => new Date(m.createdAt).getTime())

  // 从尾部往前找 silence gap
  let cutIndex = 0
  for (let i = len - 1; i > 0; i--) {
    const gap = ts[i] - ts[i - 1]
    const tailCount = len - i
    if (gap >= config.burstSilenceGapMs && tailCount >= config.minBurstMessages) {
      cutIndex = i
      break
    }
  }

  // 应用 maxBurstMessages cap
  let burstStart = cutIndex
  const burstLen = len - cutIndex
  if (burstLen > config.maxBurstMessages) {
    burstStart = len - config.maxBurstMessages
  }

  // Q→A 边界保护
  burstStart = protectSemanticChains(messages, burstStart)

  // 最少 minBurstMessages 兜底
  const finalBurstLen = len - burstStart
  if (finalBurstLen < config.minBurstMessages) {
    burstStart = Math.max(0, len - config.minBurstMessages)
  }

  return {
    burst: [...messages.slice(burstStart)],
    omitted: [...messages.slice(0, burstStart)],
  }
}

/**
 * Q→A 链保护：burstStart 那条若是 assistant，且 burstStart-1 是 user，把 user 拉进来。
 * Multi-Agent 没有 toolEvents，跳过 clowder 的 tool_use→tool_result 保护。
 */
function protectSemanticChains(messages: readonly ContextMessage[], burstStart: number): number {
  if (burstStart <= 0) return burstStart

  const firstInBurst = messages[burstStart]
  const preceding = messages[burstStart - 1]

  // Q→A 链：first-in-burst 是 assistant，前一条是 user
  if (firstInBurst.role === "assistant" && preceding.role === "user") {
    return protectSemanticChains(messages, burstStart - 1)
  }

  return burstStart
}

// ── buildTombstone + formatTombstone ────────────────────────────────

const STOP_WORDS = new Set([
  // English stopwords
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "and",
  "but",
  "or",
  "not",
  "no",
  "nor",
  "so",
  "yet",
  "for",
  "in",
  "on",
  "at",
  "to",
  "of",
  "by",
  "from",
  "with",
  "as",
  "into",
  "about",
  "up",
  "out",
  "off",
  "over",
  "under",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "what",
  "which",
  "who",
  "whom",
  "how",
  "when",
  "where",
  "why",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "some",
  "any",
  "just",
  "also",
  "very",
  "too",
  "only",
  "still",
  "here",
  "there",
  "if",
  "because",
  "while",
  "after",
  "before",
])

/**
 * 为 omitted 消息生成 tombstone（占位墓碑）。零 LLM 成本。
 * participants 取 assistant agentId 的 distinct（user 不算 participant）。
 */
export function buildTombstone(
  omitted: readonly ContextMessage[],
  threadTitle: string,
  config: BurstConfig,
): ContextTombstone | null {
  if (omitted.length === 0) return null
  void threadTitle // reserved for future fallback

  const participants = [
    ...new Set(
      omitted.filter((m) => m.role === "assistant" && m.agentId !== "user").map((m) => m.agentId),
    ),
  ]

  const timeRange = {
    from: new Date(omitted[0].createdAt).getTime(),
    to: new Date(omitted[omitted.length - 1].createdAt).getTime(),
  }

  // 简单词频做关键词
  const wordCounts = new Map<string, number>()
  for (const msg of omitted) {
    const words = msg.content
      .toLowerCase()
      .split(/[^a-zA-Z0-9一-鿿]+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    for (const w of words) {
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1)
    }
  }
  const keywords = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, config.maxTombstoneKeywords)
    .map(([word]) => word)

  return { omittedCount: omitted.length, timeRange, participants, keywords }
}

export type FormatTombstoneOptions = {
  /** 用 omitted 头条 msg_id 作为 retrieval hint 起点，下游可调 MCP 查原文。 */
  headMsgId?: string
  /** 用 omitted 末条 msg_id 作为 retrieval hint 终点。 */
  tailMsgId?: string
}

/**
 * Tombstone 序列化为紧凑 context 字符串（约 40-60 tokens）。
 * 包在 [Tombstone] / [/Tombstone] 标记里，便于下游 prompt parser 识别。
 * Retrieval hint 退化为 `MCP get_room_context, msg_id=<head>~<tail>`（Multi-Agent 无 search_evidence）。
 */
export function formatTombstone(t: ContextTombstone, opts: FormatTombstoneOptions = {}): string {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 16) // HH:MM UTC
  const from = fmt(t.timeRange.from)
  const to = fmt(t.timeRange.to)
  const participants = t.participants.length > 0 ? t.participants.join(", ") : "user"
  const keywords = t.keywords.length > 0 ? t.keywords.join(", ") : "N/A"
  const range =
    opts.headMsgId && opts.tailMsgId
      ? `msg_id=${opts.headMsgId}~${opts.tailMsgId}`
      : opts.headMsgId
        ? `msg_id=${opts.headMsgId}`
        : ""
  const hint = range ? `详情可调 MCP get_room_context, ${range}` : "详情可调 MCP get_room_context"
  return `[Tombstone] 此前省略 ${t.omittedCount} 条 · 时间窗 ${from}-${to} UTC · 参与者 ${participants} · 关键词 ${keywords} · ${hint} [/Tombstone]`
}

// ── formatBurstSection ────────────────────────────────────────────────

export type FormatBurstSectionOptions = {
  /** 单条 content 字符上限（防 burst 自身爆），默认 1500。 */
  maxContentChars?: number
}

/**
 * 把 burst 消息数组格式化成 [Burst]/[/Burst] 包裹的字符串，每条一行：
 *   [<role> · <agentId> · HH:MM] <content>
 * Empty burst → 空字符串。单条 content 默认截 1500 字（防 burst 整段失控）。
 */
export function formatBurstSection(
  burst: readonly ContextMessage[],
  opts: FormatBurstSectionOptions = {},
): string {
  if (burst.length === 0) return ""
  const cap = opts.maxContentChars ?? 1500
  const fmtTs = (iso: string) => new Date(iso).toISOString().slice(11, 16)
  const lines = burst.map((m) => {
    const ts = fmtTs(m.createdAt)
    const content = m.content.length > cap ? `${m.content.slice(0, cap)}…(超出截断)` : m.content
    return `[${m.role}·${m.agentId}·${ts}] ${content}`
  })
  return [`[Burst — 最近 ${burst.length} 条相关讨论]`, ...lines, "[/Burst]"].join("\n")
}
