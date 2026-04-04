import crypto from "node:crypto"
import type { SessionRepository } from "../db/repositories/session-repository"
import type { SessionMemoryRecord } from "../db/sqlite"

export class MemoryService {
  constructor(private readonly repository: SessionRepository) {}

  summarizeSession(sessionGroupId: string): SessionMemoryRecord {
    // 1. Get all messages for the group from all threads
    const threads = this.repository.listThreadsByGroup(sessionGroupId)
    const allMessages: Array<{ role: string; content: string; alias: string; createdAt: string }> =
      []

    for (const thread of threads) {
      const messages = this.repository.listMessages(thread.id)
      for (const msg of messages) {
        allMessages.push({
          role: msg.role,
          content: msg.content,
          alias: thread.alias,
          createdAt: msg.createdAt,
        })
      }
    }

    // 2. Sort by time
    allMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    // 3. Build condensed summary (last 20 messages, truncated)
    const recent = allMessages.slice(-20)
    const summaryLines = recent.map((m) => {
      const speaker = m.role === "user" ? "用户" : m.alias
      const content = m.content.length > 200 ? m.content.slice(0, 200) + "..." : m.content
      return `[${speaker}]: ${content}`
    })
    const summary = summaryLines.join("\n")

    // 4. Extract keywords (simple: split Chinese/English words, take top frequent)
    const keywords = extractKeywords(allMessages.map((m) => m.content).join(" "))

    // 5. Persist
    return this.repository.createMemory(sessionGroupId, summary, keywords)
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
