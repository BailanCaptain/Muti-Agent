"use client"

import type { TimelineMessage } from "@multi-agent/shared"

/**
 * F026 P5 F3 · 超时墓碑
 *
 * 当 a2a connector message 关联的 call status='timeout' 时，
 * 渲染「@{target} 响应超时，{issuer} 请继续」让用户立刻看到派发链断点。
 *
 * 数据来源：T0 已落 LEFT JOIN a2a_calls，`a2aCallStatus` / `a2aConvenerId` 透传到前端。
 *
 * 渲染条件：`message.a2aCallStatus === 'timeout'`。
 *   - 派发占位 connector message 即使 target 没回也存在（appendConnectorMessage 立刻写库）
 *   - status 由 timeoutScan 在 working past deadline / pending older than 60s 时设置
 *   - 其他 status (pending/working/done/failed/cancelled) → 不渲染（不是墓碑场景）
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

export function TimeoutTombstone({ message }: { message: TimelineMessage }) {
  if (message.a2aCallStatus !== "timeout") return null

  const target = message.alias
  const issuer = formatAgentLabel(message.a2aConvenerId)

  return (
    <div
      className="border-b border-stone-300 bg-stone-100/80 px-4 py-1.5 text-caption font-medium text-stone-600"
      data-testid="timeout-tombstone"
    >
      🪦 <span className="font-semibold">@{target}</span> 响应超时，
      <span className="font-semibold">{issuer}</span> 请继续
    </div>
  )
}
