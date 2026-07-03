"use client"

import type { Provider, TimelineMessage } from "@multi-agent/shared"
import { ShieldAlert } from "lucide-react"

type Props = {
  message: TimelineMessage
}

// F039: 投影 rgba 同步调和身份色（violet/amber/teal 500 档 hex→rgb）；gemini 归队 teal。
const providerNoticeTone: Record<Provider, { card: string; icon: string; shadow: string }> = {
  claude: {
    card: "border-violet-200 bg-violet-50/70 text-violet-900",
    icon: "text-violet-600",
    shadow: "shadow-[0_4px_12px_rgba(119,99,171,0.08)]",
  },
  codex: {
    card: "border-amber-200 bg-amber-50/70 text-amber-900",
    icon: "text-amber-600",
    shadow: "shadow-[0_4px_12px_rgba(150,104,0,0.08)]",
  },
  gemini: {
    card: "border-teal-200 bg-teal-50/70 text-teal-900",
    icon: "text-teal-600",
    shadow: "shadow-[0_4px_12px_rgba(0,132,121,0.08)]",
  },
}

/**
 * F021 Phase 6 (AC-32): seal trigger 系统通知。
 * 不是 agent 的常规 assistant final，而是平台事件的可视锚点 ——
 * 后端 message-service seal branch 持久化 messageType="system_notice" 的消息，
 * 前端 timeline-panel 据此走本组件分支（与 ConnectorBubble / MessageBubble 平行）。
 * tone 跟 agent-card 一致：claude=violet / codex=amber / gemini=teal（F039 归队，曾误用 sky）。
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
        <div className="text-compact leading-relaxed">{message.content}</div>
      </div>
    </div>
  )
}
