"use client"

import { useFoldStore, useIsMessageFolded } from "@/components/stores/fold-store"
import { useSettingsStore } from "@/components/stores/settings-store"
import { formatTokenCount } from "@/lib/format"
import { normalizeMessageToBlocks } from "@/lib/blocks"
import type { DecisionRequest, Provider, SkillEvent, ToolEvent, TimelineMessage } from "@multi-agent/shared"
import { thinkingTheme, bubbleTheme, PROVIDER_ACCENT } from "../theme"
import { ChevronDown, ChevronRight, Copy, Trash2, Wrench, Zap } from "lucide-react"
import { memo, useState } from "react"
import { BlockRenderer } from "./block-renderer"
import { CollapsibleBlock } from "./collapsible-block"
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

/* ── Tool Events summary (light-themed) ── */

function ToolEventsSummary({ toolEvents }: { toolEvents: ToolEvent[] }) {
  const completed = toolEvents.filter((e) => e.type === "tool_result")
  const errors = completed.filter((e) => e.status === "error")
  return (
    <div className="space-y-1">
      {toolEvents
        .filter((e) => e.type === "tool_use")
        .map((e, i) => {
          const result = toolEvents.find(
            (r, j) => r.type === "tool_result" && j > toolEvents.indexOf(e) &&
              (j === toolEvents.indexOf(e) + 1 || !toolEvents.slice(toolEvents.indexOf(e) + 1, j).some((x) => x.type === "tool_use")),
          )
          const isError = result?.status === "error"
          return (
            <div
              key={`${e.toolName}-${i}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-slate-600"
            >
              <Wrench className="h-3 w-3 shrink-0 text-slate-400" />
              <span className="font-medium">{e.toolName}</span>
              {e.toolInput && (
                <span className="truncate text-slate-400">{e.toolInput}</span>
              )}
              <span className={`ml-auto shrink-0 text-[10px] font-medium ${isError ? "text-red-500" : "text-emerald-500"}`}>
                {result ? (isError ? "失败" : "完成") : "运行中..."}
              </span>
            </div>
          )
        })}
      {errors.length > 0 && (
        <div className="mt-1 text-[10px] text-red-500">{errors.length} 个工具调用失败</div>
      )}
    </div>
  )
}

/* ── Skill Events summary ── */

function SkillEventsList({ skillEvents }: { skillEvents: SkillEvent[] }) {
  return (
    <div className="space-y-1">
      {skillEvents.map((e, i) => (
        <div key={`${e.skillName}-${i}`} className="flex items-center gap-2 text-xs text-slate-600">
          <span className="font-medium">{e.skillName}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
            e.matchType === "slash" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"
          }`}>
            {e.matchType === "slash" ? "指令触发" : "自动匹配"}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── Token Meta ── */

function MessageMeta({ message }: { message: TimelineMessage }) {
  const inputTokens = message.inputTokens ?? 0
  const outputTokens = message.outputTokens ?? 0
  const totalTokens = inputTokens + outputTokens
  const cachedPercent = message.cachedPercent ?? 0

  if (totalTokens === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-slate-400">
      <span className="rounded-full bg-slate-100/90 px-2 py-0.5">{message.provider}</span>
      {message.model && (
        <span className="rounded-full bg-slate-100/70 px-2 py-0.5">{message.model}</span>
      )}
      <span className="rounded-full bg-slate-50 px-2 py-0.5">
        {formatTokenCount(totalTokens)} tokens
      </span>
      {cachedPercent > 0 && (
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-600">
          缓存 {cachedPercent}%
        </span>
      )}
    </div>
  )
}

/* ── Main Card ── */

export const MessageBubble = memo(function MessageBubble({ message, inlineDecisions, onDecisionRespond, onDelete, onCopy }: MessageBubbleProps) {
  const showThinking = useSettingsStore((state) => state.showThinking)
  const isUser = message.role === "user"
  const avatarIdentity = isUser ? "user" : message.provider
  const displayAlias = isUser ? "你" : message.alias

  const foldable = !isUser
  const folded = useIsMessageFolded(message.id, message.provider)
  const toggleMessage = useFoldStore((s) => s.toggleMessage)
  const isFolded = foldable && folded

  const isStreaming = message.messageType === "progress"
  const hasThinking = !isUser && message.thinking && showThinking
  const hasToolEvents = !isUser && message.toolEvents && message.toolEvents.length > 0
  const hasSkillEvents = message.skillEvents && message.skillEvents.length > 0
  const accent = PROVIDER_ACCENT[message.provider] ?? "#94A3B8"
  const theme = !isUser ? thinkingTheme[message.provider] : null

  const toolCount = message.toolEvents?.filter((e) => e.type === "tool_use").length ?? 0
  const skillCount = message.skillEvents?.length ?? 0

  if (isUser) {
    return (
      <div className="mb-4">
        <div className="rounded-2xl border border-orange-200/70 bg-gradient-to-br from-rose-50 via-orange-50 to-amber-50 px-5 py-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-400">
            <ProviderAvatar identity="user" size="sm" />
            <span className="font-semibold text-slate-700">{displayAlias}</span>
            <span>{formatClock(message.createdAt)}</span>
          </div>
          <div className="text-sm text-slate-700">
            <BlockRenderer
              blocks={normalizeMessageToBlocks(message).filter((b) => b.kind !== "thinking")}
              provider={message.provider}
            />
          </div>
          {hasSkillEvents && (
            <div className="mt-3">
              <CollapsibleBlock
                title={`Skill 匹配 (${skillCount})`}
                icon={<Zap className="h-3.5 w-3.5 text-amber-500" />}
                accentColor="#D97706"
              >
                <SkillEventsList skillEvents={message.skillEvents!} />
              </CollapsibleBlock>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-4">
      <div
        className={`overflow-hidden rounded-2xl border shadow-sm ${bubbleTheme[message.provider]}`}
      >
        {/* Card Header */}
        <div className="flex items-center gap-2.5 border-b border-slate-200/60 px-4 py-3">
          <ProviderAvatar identity={avatarIdentity} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-semibold text-slate-700">{displayAlias}</span>
              {message.model && (
                <span className="rounded-full bg-slate-100/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                  {message.model}
                </span>
              )}
              {isStreaming && (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
                  输出中...
                </span>
              )}
            </div>
          </div>
          <span className="text-[10px] text-slate-400">{formatClock(message.createdAt)}</span>
          {foldable && (
            <button
              className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              onClick={() => toggleMessage(message.id, message.provider)}
              title={isFolded ? "展开消息" : "折叠消息"}
              type="button"
            >
              {isFolded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>

        {isFolded ? (
          <button
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs text-slate-500 transition-colors hover:bg-white/60"
            onClick={() => toggleMessage(message.id, message.provider)}
            title="点击展开"
            type="button"
          >
            <ChevronRight className="h-3 w-3 shrink-0 text-slate-400" />
            <span className="truncate italic">{buildFoldedPreview(message.content)}</span>
          </button>
        ) : (
          <>
            {/* Collapsible Sections */}
            {(hasSkillEvents || hasToolEvents || hasThinking) && (
              <div className="space-y-2 px-4 pt-3">
                {hasSkillEvents && (
                  <CollapsibleBlock
                    title={`Skill 调用 (${skillCount})`}
                    icon={<Zap className="h-3.5 w-3.5 text-amber-500" />}
                    accentColor="#D97706"
                  >
                    <SkillEventsList skillEvents={message.skillEvents!} />
                  </CollapsibleBlock>
                )}

                {hasToolEvents && (
                  <CollapsibleBlock
                    title={`工具调用 (${toolCount})`}
                    icon={<Wrench className="h-3.5 w-3.5 text-slate-500" />}
                    accentColor={accent}
                    isStreaming={isStreaming}
                  >
                    <ToolEventsSummary toolEvents={message.toolEvents!} />
                  </CollapsibleBlock>
                )}

                {hasThinking && theme && (
                  <CollapsibleBlock
                    title="推理过程"
                    icon={<BrainIcon className="h-3.5 w-3.5 text-slate-500" />}
                    accentColor={accent}
                  >
                    <div className="max-h-60 overflow-y-auto pr-1">
                      <MarkdownMessage
                        className={`text-[12px] leading-relaxed ${theme.content}`}
                        content={message.thinking!}
                      />
                    </div>
                  </CollapsibleBlock>
                )}
              </div>
            )}

            {/* Content — always visible */}
            <div className="px-4 py-3 text-sm text-slate-700">
              <BlockRenderer
                blocks={normalizeMessageToBlocks(message).filter((b) => b.kind !== "thinking")}
                provider={message.provider}
              />
            </div>

            {/* Inline Decisions */}
            {inlineDecisions && inlineDecisions.length > 0 && onDecisionRespond && (
              <div className="space-y-2 border-t border-slate-200/60 px-4 py-3">
                {inlineDecisions.map((req) => (
                  <DecisionCard key={req.requestId} request={req} onRespond={onDecisionRespond} />
                ))}
              </div>
            )}

            {/* Card Footer */}
            <div className="flex items-center justify-between border-t border-slate-200/60 px-4 py-2">
              <MessageMeta message={message} />
              <div className="flex items-center gap-1">
                <button
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  onClick={() => onCopy?.(message.content)}
                  title="复制"
                  type="button"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  onClick={() => onDelete?.(message.id)}
                  title="删除"
                  type="button"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
})
