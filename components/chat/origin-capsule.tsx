"use client"

import type { TimelineMessage } from "@multi-agent/shared"

/**
 * F026 P5 F2 · 溯源胶囊
 *
 * 在 a2a 派发产生的 connector message 顶部渲染「📨 {convener} 正在征询 {target}（为 {onBehalfOf}）」，
 * 让用户看清主流上的"代别人征询"链——避免误以为是 convener 自己的发问。
 *
 * 数据来源：T0 已落 `messages.a2a_call_id` LEFT JOIN a2a_calls，
 *   `a2aOnBehalfOf` / `a2aConvenerId` 由 mapTimelineMessage 透传到前端。
 *
 * 渲染条件：`message.a2aOnBehalfOf` 非空（== 协议层标记此次派发是 on-behalf-of）。
 *   不带 onBehalfOf 的普通消息 / 非 a2a 派发的消息 → 不渲染。
 */

function formatAgentLabel(id: string | null | undefined): string {
  if (!id) return ""
  if (id.startsWith("user:")) {
    const tail = id.slice("user:".length)
    return tail || "村长"
  }
  // "{provider}:{alias}" → 取 alias 后段
  const colonIdx = id.indexOf(":")
  return colonIdx > 0 ? id.slice(colonIdx + 1) : id
}

export function OriginCapsule({ message }: { message: TimelineMessage }) {
  if (!message.a2aOnBehalfOf) return null

  const convener = formatAgentLabel(message.a2aConvenerId)
  const onBehalf = formatAgentLabel(message.a2aOnBehalfOf)
  const target = message.alias

  return (
    <div
      className="border-b border-purple-100 bg-purple-50/50 px-4 py-1.5 text-[11px] text-purple-700"
      data-testid="origin-capsule"
    >
      📨 <span className="font-semibold">{convener}</span> 正在征询{" "}
      <span className="font-semibold">{target}</span>（为{" "}
      <span className="font-semibold">{onBehalf}</span>）
    </div>
  )
}
