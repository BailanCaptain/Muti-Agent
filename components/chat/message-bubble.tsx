"use client"

import { useFoldStore, useIsMessageFolded } from "@/components/stores/fold-store"
import { formatTokenCount } from "@/lib/format"
import type { DecisionRequest, Provider, TimelineMessage } from "@multi-agent/shared"
import { ChevronDown, ChevronRight, Copy, Trash2 } from "lucide-react"
import { useState } from "react"
import { DecisionCard } from "./decision-card"
import { MarkdownMessage } from "./markdown-message"
import { ProviderAvatar } from "./provider-avatar"

interface MessageBubbleProps {
  message: TimelineMessage
  inlineDecisions?: DecisionRequest[]
  onDecisionRespond?: (
    requestId: string,
    decisions: Array<{ optionId: string; verdict: "approved" | "rejected" | "modified"; modification?: string }>,
    userInput?: string,
  ) => void
  onDelete?: (id: string) => void
  onCopy?: (content: string) => void
}

function formatClock(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function buildFoldedPreview(content: string): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, "[代码块]")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[#>*\-+\d.]+\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain || "（空内容）"
}

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  )
}

const thinkingTheme: Record<
  Provider,
  {
    container: string
    button: string
    content: string
    icon: string
  }
> = {
  codex: {
    container: "bg-amber-50/50 border-amber-100/80",
    button: "text-amber-600 hover:text-amber-700",
    content: "text-slate-600 [&_blockquote]:border-amber-200 [&_code]:bg-amber-100/50",
    icon: "text-amber-500/80",
  },
  claude: {
    container: "bg-violet-50/50 border-violet-100/80",
    button: "text-violet-600 hover:text-violet-700",
    content: "text-slate-600 [&_blockquote]:border-violet-200 [&_code]:bg-violet-100/50",
    icon: "text-violet-500/80",
  },
  gemini: {
    container: "bg-sky-50/50 border-sky-100/80",
    button: "text-sky-600 hover:text-sky-700",
    content: "text-slate-600 [&_blockquote]:border-sky-200 [&_code]:bg-sky-100/50",
    icon: "text-sky-500/80",
  },
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
        总量 {formatTokenCount(totalTokens)}
      </span>
      <span className="rounded-full bg-slate-50 px-2 py-1">
        输入 {formatTokenCount(inputTokens)}
      </span>
      <span className="rounded-full bg-slate-50 px-2 py-1">
        输出 {formatTokenCount(outputTokens)}
      </span>
      <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-600">
        缓存 {cachedPercent}%
      </span>
    </div>
  )
}

export function MessageBubble({ message, inlineDecisions, onDecisionRespond, onDelete, onCopy }: MessageBubbleProps) {
  const [isThinkingOpen, setIsThinkingOpen] = useState(true)
  const isUser = message.role === "user"
  const avatarIdentity = isUser ? "user" : message.provider
  const displayAlias = isUser ? "你" : message.alias
  const theme = !isUser ? thinkingTheme[message.provider] : null

  // Only assistant messages are foldable — user messages are already short turns.
  const foldable = !isUser
  const folded = useIsMessageFolded(message.id, message.provider)
  const toggleMessage = useFoldStore((s) => s.toggleMessage)
  const isFolded = foldable && folded

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
            {foldable ? (
              <button
                className="flex items-center gap-1 rounded-full border border-slate-200/80 bg-slate-50/80 px-2 py-0.5 text-[10px] font-medium text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-100 hover:text-slate-800"
                onClick={() => toggleMessage(message.id, message.provider)}
                title={isFolded ? "展开消息" : "折叠消息"}
                type="button"
              >
                {isFolded ? (
                  <ChevronRight className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                <span>{isFolded ? "展开" : "折叠"}</span>
              </button>
            ) : null}
          </div>

          <div className="relative">
            {isFolded ? (
              <button
                className="flex w-full items-center gap-2 rounded-[26px] border border-dashed border-slate-200/80 bg-white/70 px-5 py-3 text-left text-xs text-slate-500 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition-colors hover:bg-white/90"
                onClick={() => toggleMessage(message.id, message.provider)}
                title="点击展开"
                type="button"
              >
                <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />
                <span className="truncate italic">{buildFoldedPreview(message.content)}</span>
              </button>
            ) : (
              <div
                className={`rounded-[26px] border px-5 py-4 shadow-[0_18px_40px_rgba(15,23,42,0.07)] ${
                  isUser
                    ? "border-orange-200/70 bg-gradient-to-br from-rose-50 via-orange-50 to-amber-50 text-slate-700"
                    : "border-slate-200/80 bg-white/95 text-slate-700"
                }`}
              >
                {!isUser && message.thinking && theme ? (
                  <div
                    className={`mb-4 overflow-hidden rounded-2xl border p-4 shadow-inner ${theme.container}`}
                  >
                    <button
                      className={`flex w-full items-center gap-2 text-[11px] font-medium transition ${theme.button}`}
                      onClick={() => setIsThinkingOpen(!isThinkingOpen)}
                      type="button"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform duration-200 ${isThinkingOpen ? "" : "-rotate-90"}`}
                      />
                      <BrainIcon className={`h-3.5 w-3.5 ${theme.icon}`} />
                      <span>深度思考</span>
                      {!isThinkingOpen && message.thinking && (
                        <span className="ml-2 truncate opacity-40">
                          {message.thinking.slice(0, 60)}...
                        </span>
                      )}
                    </button>
                    <div
                      className={`grid transition-all duration-300 ease-in-out ${
                        isThinkingOpen
                          ? "grid-rows-[1fr] opacity-100 mt-3"
                          : "grid-rows-[0fr] opacity-0 mt-0"
                      }`}
                    >
                      <div className="overflow-hidden">
                        <div className="max-h-60 overflow-y-auto border-t border-slate-200/60 pt-3 pr-1">
                          <MarkdownMessage
                            className={`text-[12px] leading-relaxed ${theme.content}`}
                            content={message.thinking}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                <MarkdownMessage content={message.content} />

                {inlineDecisions && inlineDecisions.length > 0 && onDecisionRespond && (
                  <div className="mt-3 space-y-2 border-t border-slate-200/60 pt-3">
                    {inlineDecisions.map((req) => (
                      <DecisionCard key={req.requestId} request={req} onRespond={onDecisionRespond} />
                    ))}
                  </div>
                )}

                {!isUser ? <MessageMeta message={message} /> : null}
              </div>
            )}

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
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
