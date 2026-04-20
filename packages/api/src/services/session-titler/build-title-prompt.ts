import type { SessionRepository } from "../../storage/repositories"

/**
 * Compose a Haiku prompt from the most recent messages in a session group.
 * Pulls up to `maxMessages` from each thread in the group, merges by createdAt,
 * then asks Haiku to classify the session and produce `{F|B|D|Q}-{≤8字}`.
 * If the conversation references a filed feature/bug id (F\d+ / B\d+), Haiku
 * is told to preserve that id as the prefix (e.g. `F022-侧栏重塑`).
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
    "请先判断会话类型，再用中文给出不超过 8 个字的简短描述。",
    "",
    "类型前缀（大写字母 + 短横线）：",
    "- F{编号}- 已立项的新 feature（对话中出现 F\\d+ 编号，如 F022）",
    "- B{编号}- 已立项的 bug（对话中出现 B\\d+ 编号，如 B026）",
    "- D- 讨论 / 设计 / brainstorm / 未立项的功能点子",
    "- Q- 咨询 / 问答 / 教学",
    "",
    "关键规则：",
    "- 只有当对话里**明确出现** `F\\d+` 或 `B\\d+` 编号时，才可用 F{编号}- / B{编号}- 前缀，编号**原样照抄**（如 F022 不能写成 F22 或 F-022）",
    "- 没有看到编号就**不要**自己用 F- 或 B-，归到 D-",
    "- 判不准时默认 D-",
    "",
    "输出格式：{前缀}-{≤8字描述}。",
    "要求：",
    "- 直接输出结果，不要加引号、标点或任何解释",
    "- 描述聚焦主题，不要出现 '对话'/'会话' 这类空词",
    "",
    "对话：",
    transcript || "（无有效消息）",
  ].join("\n")
}
