import type { SessionRepository } from "../db/repositories"
import type { SessionMemoryRecord } from "../db/sqlite"
import { type HaikuRunner, createOpus46Runner } from "../runtime/haiku-runner"

/** 会话摘要压缩超时（重任务·长上下文，远大于 runner 默认 15s）。 */
const SUMMARY_COMPRESS_TIMEOUT_MS = 60_000

export class MemoryService {
  private readonly invalidatedGroups = new Set<string>()

  constructor(
    private readonly repository: SessionRepository,
    /**
     * F027 B1-a（小孙 2026-06-06 拍）：会话摘要压缩 runner，默认 Claude Opus 4.6（弃 Gemini）。
     * 走 stdin（haiku-runner 已修 ENAMETOOLONG）；测试可注入 fake。
     */
    private readonly summaryRunner: HaikuRunner = createOpus46Runner(),
  ) {}

  invalidateSummary(sessionGroupId: string) {
    this.invalidatedGroups.add(sessionGroupId)
  }

  summarizeSession(sessionGroupId: string): SessionMemoryRecord {
    const allMessages = this.repository.listAllMessagesForGroup(sessionGroupId)

    const recent = allMessages.slice(-20)
    const summaryLines = recent.map((m) => {
      const speaker = m.role === "user" ? "用户" : m.alias
      const content = m.content.length > 200 ? m.content.slice(0, 200) + "..." : m.content
      return `[${speaker}]: ${content}`
    })
    const summary = summaryLines.join("\n")

    const keywords = extractKeywords(allMessages.map((m) => m.content).join(" "))

    return this.repository.createMemory(sessionGroupId, summary, keywords)
  }

  /**
   * Generate a rolling summary using Gemini API for compression.
   * Falls back to extractive-only summary if no API key or on failure.
   */
  async generateRollingSummary(sessionGroupId: string): Promise<string> {
    const allMessages = this.repository.listAllMessagesForGroup(sessionGroupId)

    // 抽取式摘要打底（关键决策 / [拍板] / 话题关键词）
    const extractive = buildExtractiveSummary(allMessages)
    const keywords = extractKeywords(allMessages.map((m) => m.content).join(" "))
    // F027 B1-a：Claude Opus 4.6 抽象压缩（弃 Gemini）；任何失败 fail-soft 退回 extractive
    const summary = await this.compressSummary(extractive, allMessages)
    this.repository.createMemory(sessionGroupId, summary, keywords)
    return summary
  }

  /**
   * Check for existing summary first, only generate if stale
   * (>10 user messages since last summary).
   */
  async getOrCreateSummary(sessionGroupId: string): Promise<string | null> {
    const forceRefresh = this.invalidatedGroups.has(sessionGroupId)
    if (forceRefresh) this.invalidatedGroups.delete(sessionGroupId)

    // Check for existing summary
    const existing = this.repository.getLatestMemory(sessionGroupId)

    if (existing && !forceRefresh) {
      const userMessagesSinceSummary = this.repository.countUserMessagesSince(
        sessionGroupId,
        existing.createdAt,
      )

      if (userMessagesSinceSummary <= 10) {
        return existing.summary
      }
    }

    // No existing summary or it's stale — check if there are any messages at all
    const allMsgs = this.repository.listAllMessagesForGroup(sessionGroupId, 1)

    if (allMsgs.length === 0) {
      return null
    }

    // Generate a new rolling summary
    return this.generateRollingSummary(sessionGroupId)
  }

  /**
   * F027 B1-a（小孙 2026-06-06 拍）：会话抽象摘要压缩用 Claude Opus 4.6（弃 Gemini CLI）。
   *
   * runner 走 **stdin**（haiku-runner 已修 ENAMETOOLONG）—— 摘要 prompt 拼最多 100 条消息
   * （每条截断 800 字）可达数十 KB，原 gemini/claude `-p <prompt>` 当 argv 传会 spawn 超限
   * （与 B3 实测的 haiku-runner ENAMETOOLONG 同根）。
   * runner 任何失败（timeout / empty-output / exit / spawn-error）→ fail-soft 退回 extractive 摘要。
   */
  private async compressSummary(
    extractive: string,
    allMessages: Array<{ role: string; content: string; alias: string; createdAt: string }>,
  ): Promise<string> {
    const conversationText = allMessages
      .slice(-100)
      .map((m) => {
        const speaker = m.role === "user" ? "用户" : m.alias
        return `[${speaker} ${m.createdAt}]: ${m.content.slice(0, 800)}`
      })
      .join("\n")

    const prompt = `你是一个会话摘要生成器。请根据以下对话记录，生成一份 500-1000 字的结构化摘要。

格式要求：
## 话题
（列出讨论的主要话题）

## 关键决策
（列出已做出的关键决策，特别注意标记了 [分歧点] 的内容）

## 待办
（列出尚未完成的任务和行动项）

## 共识与分歧
（列出团队达成的共识和仍有分歧的点）

以下是提取式摘要：
${extractive}

以下是完整对话记录（按时间排序）：
${conversationText}`

    const result = await this.summaryRunner.runPrompt(prompt, {
      timeoutMs: SUMMARY_COMPRESS_TIMEOUT_MS,
    })
    return result.ok && result.text ? result.text : extractive
  }

  getLastSummary(sessionGroupId: string): string | null {
    const record = this.repository.getLatestMemory(sessionGroupId)
    return record?.summary ?? null
  }

  searchMemories(keyword: string): SessionMemoryRecord[] {
    return this.repository.searchMemories(keyword)
  }

  getMemoriesForGroup(sessionGroupId: string): SessionMemoryRecord[] {
    return this.repository.listMemories(sessionGroupId)
  }
}

/**
 * Build an extractive summary highlighting key decisions, [拍板] items, and topic keywords.
 */
function buildExtractiveSummary(
  allMessages: Array<{ role: string; content: string; alias: string; createdAt: string }>,
): string {
  const sections: string[] = []

  // Extract [分歧点] / [拍板] items (both accepted for backward compat)
  const divergenceItems: string[] = []
  for (const msg of allMessages) {
    if (
      msg.content.includes("[分歧点]") ||
      msg.content.includes("[拍板]") ||
      msg.content.includes("【拍板】")
    ) {
      const speaker = msg.role === "user" ? "用户" : msg.alias
      divergenceItems.push(`[${speaker}]: ${msg.content.slice(0, 300)}`)
    }
  }
  if (divergenceItems.length > 0) {
    sections.push("### 关键决策（分歧点）\n" + divergenceItems.join("\n"))
  }

  // Extract topic keywords
  const keywords = extractKeywords(allMessages.map((m) => m.content).join(" "))
  if (keywords) {
    sections.push("### 话题关键词\n" + keywords)
  }

  // Recent conversation as structured Timeline (last 20 messages)
  const recent = allMessages.slice(-20)
  const timelineLines = recent.map((m) => {
    const speaker = m.role === "user" ? "用户" : m.alias
    const time = m.createdAt.slice(11, 16)
    const content = m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content
    return `${time} ${speaker}: ${content}`
  })
  sections.push("[Timeline]\n" + timelineLines.join("\n"))

  // Extract unfinished tasks
  const unfinishedItems: string[] = []
  for (const msg of allMessages) {
    const todoMatches = msg.content.match(/待办|TODO|待定|下一步|next step/gi)
    if (todoMatches) {
      const speaker = msg.role === "user" ? "用户" : msg.alias
      unfinishedItems.push(`- ${speaker}: ${msg.content.slice(0, 150)}`)
    }
  }
  if (unfinishedItems.length > 0) {
    sections.push("[未完成]\n" + unfinishedItems.slice(-5).join("\n"))
  }

  return sections.join("\n\n")
}

function extractKeywords(text: string): string {
  // Simple keyword extraction: find frequently occurring meaningful words
  const words = text
    .replace(/[^\u4e00-\u9fff\w]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2)

  const freq = new Map<string, number>()
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }

  // Filter out very common words, take top 10 by frequency
  const sorted = [...freq.entries()]
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word)

  return sorted.join(",")
}
