import type { SessionRepository } from "../../storage/repositories"

/**
 * Compose a Haiku prompt from the most recent messages in a session group.
 * Pulls up to `maxMessages` from each thread in the group, merges by createdAt,
 * then asks Haiku to produce a title ≤10 chars.
 */
export function buildTitlePromptFromRecentMessages(
  sessionGroupId: string,
  repo: Pick<SessionRepository, "listThreadsByGroup" | "listMessages">,
  maxMessages = 6,
): string {
  const threads = repo.listThreadsByGroup(sessionGroupId)
  const collected: { createdAt: string; role: string; content: string }[] = []
  for (const t of threads) {
    const msgs = repo.listMessages(t.id)
    for (const m of msgs) {
      if (m.messageType !== "final") continue
      const content = (m.content ?? "").trim()
      if (!content) continue
      collected.push({ createdAt: m.createdAt, role: m.role, content })
    }
  }
  collected.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const recent = collected.slice(-maxMessages)
  const transcript = recent
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.slice(0, 200)}`)
    .join("\n")

  return [
    "请根据以下对话内容，用中文生成一个不超过 10 个字的简短标题，概括对话主题。",
    "要求：",
    "- 直接输出标题，不要加引号、标点或任何解释",
    "- 不超过 10 个字",
    "- 内容聚焦对话主题，不要出现 '对话'/'会话' 这类空词",
    "",
    "对话：",
    transcript || "（无有效消息）",
  ].join("\n")
}
