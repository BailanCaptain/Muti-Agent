"use client"

import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { ShieldAlert } from "lucide-react"

type Props = {
  message: TimelineMessage
}

const providerNoticeTone: Record<Provider, { card: string; icon: string; shadow: string }> = {
  claude: {
    card: "border-violet-200 bg-violet-50/70 text-violet-900",
    icon: "text-violet-600",
    shadow: "shadow-[0_4px_12px_rgba(124,58,237,0.08)]",
  },
  codex: {
    card: "border-amber-200 bg-amber-50/70 text-amber-900",
    icon: "text-amber-600",
    shadow: "shadow-[0_4px_12px_rgba(217,119,6,0.08)]",
  },
  gemini: {
    card: "border-sky-200 bg-sky-50/70 text-sky-900",
    icon: "text-sky-600",
    shadow: "shadow-[0_4px_12px_rgba(14,165,233,0.08)]",
  },
}

/**
 * F021 Phase 6 (AC-32): seal trigger 系统通知。
 * 不是 agent 的常规 assistant final，而是平台事件的可视锚点 ——
 * 后端 message-service seal branch 持久化 messageType="system_notice" 的消息，
 * 前端 timeline-panel 据此走本组件分支（与 ConnectorBubble / MessageBubble 平行）。
 * tone 跟 agent-card 一致：claude=violet / codex=amber / gemini=sky。
 */
export function SystemNoticeBubble({ message }: Props) {
  const tone = providerNoticeTone[message.provider]
  return (
    <div className="mb-6 flex w-full justify-center">
      <div
        role="note"
        data-testid="system-notice-card"
        data-provider={message.provider}
        className={`flex max-w-[680px] items-start gap-3 rounded-2xl border px-5 py-3 ${tone.card} ${tone.shadow}`}
      >
        <ShieldAlert className={`mt-0.5 h-5 w-5 shrink-0 ${tone.icon}`} aria-hidden="true" />
        <div className="text-[13px] leading-relaxed">{message.content}</div>
      </div>
    </div>
  )
}
