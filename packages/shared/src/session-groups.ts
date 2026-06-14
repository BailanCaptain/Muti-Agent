import type { Provider } from "./constants"
import type { SessionGroupSummary } from "./realtime"
import { stripRichFencesForPreview } from "./rich-blocks"

export type SessionGroupMessageInput = {
  provider: Provider
  alias: string
  content: string
  createdAt: string
}

export function applyMessageToSessionGroup<T extends SessionGroupSummary>(
  group: T,
  message: SessionGroupMessageInput,
): T {
  const participants = group.participants.includes(message.provider)
    ? group.participants
    : [...group.participants, message.provider]

  const otherPreviews = group.previews.filter((p) => p.provider !== message.provider)
  const previews = [
    ...otherPreviews,
    {
      provider: message.provider,
      alias: message.alias,
      // F030 r3 P2：剔除 cc_rich 围栏再截断，避免未闭合卡片 JSON 漏进 session-group 摘要
      text: stripRichFencesForPreview(message.content).slice(0, 80),
    },
  ]

  return {
    ...group,
    participants,
    previews,
    messageCount: group.messageCount + 1,
    updatedAt: message.createdAt,
    updatedAtLabel: new Date(message.createdAt).toLocaleString("zh-CN"),
  }
}

export function applyMessageToSessionGroups<T extends SessionGroupSummary>(
  groups: T[],
  groupId: string,
  message: SessionGroupMessageInput,
): T[] {
  const idx = groups.findIndex((g) => g.id === groupId)
  if (idx === -1) return groups
  const updated = applyMessageToSessionGroup(groups[idx], message)
  // 保留原位置：侧栏按 createdAt 稳定排序，收到新消息只更新展示字段，不重排。
  return groups.map((g, i) => (i === idx ? updated : g))
}
