"use client"

import type { TimelineMessage } from "@multi-agent/shared"
import { ChevronDown, ChevronRight, Users } from "lucide-react"
import { useState } from "react"
import { MarkdownMessage } from "./markdown-message"
import { ProviderAvatar } from "./provider-avatar"

interface ConnectorBubbleProps {
  message: TimelineMessage
}

function formatClock(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/**
 * Renders a multi-mention parallel-thinking aggregate bubble.
 * Distinct from MessageBubble: spans full width, no user/provider alignment,
 * shows participants inline. One bubble summarizes N agents' replies.
 *
 * Phase 2 discussion bubbles ("串行讨论记录") default to collapsed — the
 * transcript can run long, and users typically care about the synthesizer's
 * output, not every round's back-and-forth.
 */
export function ConnectorBubble({ message }: ConnectorBubbleProps) {
  const source = message.connectorSource
  const label = source?.label ?? "并行思考结果"
  const targets = source?.targets ?? []
  const initiator = source?.initiator
  const isPhase2 = label === "串行讨论记录"
  const [expanded, setExpanded] = useState(!isPhase2)

  return (
    <div className="mb-6 flex w-full flex-col items-stretch">
      <div className="mx-auto w-full max-w-[780px] rounded-[28px] border border-indigo-200/70 bg-gradient-to-br from-indigo-50/70 via-white to-violet-50/50 px-6 py-5 shadow-[0_18px_40px_rgba(79,70,229,0.08)]">
        <header
          className={`flex flex-wrap items-center gap-3 ${
            expanded ? "mb-4 border-b border-indigo-100/80 pb-3" : ""
          } ${isPhase2 ? "cursor-pointer select-none" : ""}`}
          onClick={isPhase2 ? () => setExpanded((v) => !v) : undefined}
          role={isPhase2 ? "button" : undefined}
          tabIndex={isPhase2 ? 0 : undefined}
          onKeyDown={
            isPhase2
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    setExpanded((v) => !v)
                  }
                }
              : undefined
          }
        >
          {isPhase2 ? (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
              {expanded ? (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              )}
            </span>
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
              <Users className="h-4 w-4" aria-hidden="true" />
            </span>
          )}
          <div className="flex flex-col">
            <span className="text-[13px] font-semibold tracking-wide text-indigo-900">
              {label}
              {isPhase2 && !expanded ? (
                <span className="ml-2 text-[11px] font-normal text-indigo-500/80">
                  （点击展开）
                </span>
              ) : null}
            </span>
            <span className="text-[10px] text-indigo-500/80">{formatClock(message.createdAt)}</span>
          </div>

          {targets.length > 0 ? (
            <div className="ml-auto flex items-center gap-2">
              {initiator ? (
                <div className="flex items-center gap-1.5 border-r border-indigo-200/60 pr-2">
                  <span className="text-[10px] text-indigo-500/80">发起：</span>
                  <ProviderAvatar identity={initiator} size="xs" />
                </div>
              ) : null}
              <span className="text-[10px] text-indigo-500/80">参与：</span>
              <div className="flex -space-x-1.5">
                {targets.map((provider) => (
                  <ProviderAvatar key={provider} identity={provider} size="xs" />
                ))}
              </div>
            </div>
          ) : null}
        </header>

        {expanded ? <MarkdownMessage content={message.content} /> : null}
      </div>
    </div>
  )
}
