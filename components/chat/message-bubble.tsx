"use client"

import { formatTokenCount } from "@/lib/format"
import type { TimelineMessage } from "@multi-agent/shared"
import { ChevronDown, ChevronRight, Copy, Share2, Trash2 } from "lucide-react"
import { useState } from "react"
import { MarkdownMessage } from "./markdown-message"
import { ProviderAvatar } from "./provider-avatar"

interface MessageBubbleProps {
  message: TimelineMessage
  onDelete?: (id: string) => void
  onCopy?: (content: string) => void
}

function formatClock(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function MessageMeta({ message }: { message: TimelineMessage }) {
  const inputTokens = message.inputTokens ?? 0
  const outputTokens = message.outputTokens ?? 0
  const totalTokens = inputTokens + outputTokens
  const cachedPercent = message.cachedPercent ?? 0

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-slate-200/80 pt-3 font-mono text-[10px] text-slate-400">
      <span className="rounded-full bg-slate-100/90 px-2 py-1 text-slate-500">
        {message.provider}
      </span>
      {message.model ? (
        <span className="rounded-full bg-slate-100/70 px-2 py-1 text-slate-500">
          {message.model}
        </span>
      ) : null}
      <span className="rounded-full bg-slate-50 px-2 py-1">
        total {formatTokenCount(totalTokens)}
      </span>
      <span className="rounded-full bg-slate-50 px-2 py-1">in {formatTokenCount(inputTokens)}</span>
      <span className="rounded-full bg-slate-50 px-2 py-1">
        out {formatTokenCount(outputTokens)}
      </span>
      <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-600">
        cache {cachedPercent}%
      </span>
    </div>
  )
}

export function MessageBubble({ message, onDelete, onCopy }: MessageBubbleProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(true)
  const isUser = message.role === "user"
  const avatarIdentity = isUser ? "user" : message.provider
  const displayAlias = isUser ? "Host" : message.alias

  return (
    <div className={`group mb-6 flex w-full flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div className={`flex max-w-[85%] gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
        <div className="mt-1 shrink-0">
          <ProviderAvatar identity={avatarIdentity} size="md" />
        </div>

        <div className="flex flex-col gap-1">
          <div
            className={`flex items-center gap-2 px-1 text-[11px] ${isUser ? "flex-row-reverse" : "flex-row"} text-slate-400`}
          >
            <span className="font-semibold tracking-[0.02em] text-slate-700">
              {displayAlias}
              {!isUser && message.model ? (
                <span className="ml-1.5 rounded-full bg-slate-100/90 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-500">
                  ({message.model})
                </span>
              ) : null}
            </span>
            <span>{formatClock(message.createdAt)}</span>
            {!isUser ? (
              <span className="cursor-pointer text-slate-300 hover:text-slate-500">&#9654;</span>
            ) : null}
          </div>

          <div className="relative">
            <div
              className={`rounded-[26px] border px-5 py-4 shadow-[0_18px_40px_rgba(15,23,42,0.07)] ${
                isUser
                  ? "border-orange-200/70 bg-gradient-to-br from-rose-50 via-orange-50 to-amber-50 text-slate-700"
                  : "border-slate-200/80 bg-white/95 text-slate-700"
              }`}
            >
              {!isUser && message.thinking ? (
                <div className="mb-4 overflow-hidden rounded-2xl border border-emerald-100/80 bg-emerald-50/50 p-4">
                  <button
                    className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 transition hover:text-emerald-800"
                    onClick={() => setIsThinkingOpen(!isThinkingOpen)}
                    type="button"
                  >
                    {isThinkingOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                    Inner Thoughts
                  </button>
                  {isThinkingOpen ? (
                    <div className="mt-3 max-h-60 overflow-y-auto border-t border-emerald-100/80 pt-3 pr-1">
                      <MarkdownMessage
                        className="text-[12px] leading-5 text-emerald-950/70 [&_blockquote]:border-emerald-200/80 [&_blockquote]:text-emerald-900/70 [&_code]:bg-emerald-100/80 [&_hr]:border-emerald-100/90 [&_thead]:bg-emerald-100/70"
                        content={message.thinking}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}

              <MarkdownMessage content={message.content} />

              {!isUser ? <MessageMeta message={message} /> : null}
            </div>

            <div
              className={`absolute top-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 ${
                isUser ? "right-full mr-2" : "left-full ml-2"
              }`}
            >
              <button
                className="rounded-full bg-white/95 p-1.5 shadow-sm ring-1 ring-black/5 hover:bg-slate-50"
                onClick={() => onCopy?.(message.content)}
                type="button"
              >
                <Copy className="h-3.5 w-3.5 text-slate-400" />
              </button>
              <button
                className="rounded-full bg-white/95 p-1.5 shadow-sm ring-1 ring-black/5 hover:bg-slate-50"
                onClick={() => onDelete?.(message.id)}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5 text-slate-400" />
              </button>
              <button
                className="rounded-full bg-white/95 p-1.5 shadow-sm ring-1 ring-black/5 hover:bg-slate-50"
                type="button"
              >
                <Share2 className="h-3.5 w-3.5 text-slate-400" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
