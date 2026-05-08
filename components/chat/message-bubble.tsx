"use client"

import { useFoldStore, useIsMessageFolded } from "@/components/stores/fold-store"
import { useSettingsStore } from "@/components/stores/settings-store"
import { normalizeMessageToBlocks } from "@/lib/blocks"
import { formatTokenCount } from "@/lib/format"
import type {
  DecisionRequest,
  DispatchValidationRetryReason,
  Provider,
  TimelineMessage,
  ToolEvent,
} from "@multi-agent/shared"
import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Plug,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react"
import { memo, useState } from "react"
import { PROVIDER_ACCENT, bubbleTheme, thinkingTheme } from "../theme"
import { BlockRenderer } from "./block-renderer"
import { CollapsibleBlock } from "./collapsible-block"
import { DecisionCard } from "./decision-card"
import {
  DispatchRetryProgressCard,
  DispatchRetryStreamingLock,
  useDispatchRetryStreamingLock,
} from "./dispatch-retry-progress-card"
import { MarkdownMessage } from "./markdown-message"
import { ProviderAvatar } from "./provider-avatar"

interface MessageBubbleProps {
  message: TimelineMessage
  inlineDecisions?: DecisionRequest[]
  onDecisionRespond?: (
    requestId: string,
    decisions: Array<{
      optionId: string
      verdict: "approved" | "rejected" | "modified"
      modification?: string
    }>,
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

const THINKING_NOISE_RE =
  /^(Reading (prompt|additional input) from stdin.*|YOLO mode is enabled.*|All tool calls will be automatically approved.*|Loaded cached credentials.*|Using model:.*|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s.*|Tip:.*|\[runtime\].*|codex_core.*|failed to stat skills entry.*)$/gm

function cleanThinking(raw: string): string {
  return raw
    .replace(THINKING_NOISE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
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

function classifyToolEvents(events: ToolEvent[]) {
  const mcp: ToolEvent[] = []
  const skill: ToolEvent[] = []
  const tool: ToolEvent[] = []
  let lastSource: "mcp" | "skill" | "tool" = "tool"

  for (const e of events) {
    const src = e.source ?? (e.type === "tool_result" ? lastSource : "tool")

    if (e.type === "tool_use") lastSource = src as "mcp" | "skill" | "tool"

    if (src === "mcp") mcp.push(e)
    else if (src === "skill") skill.push(e)
    else tool.push(e)
  }

  return { mcp, skill, tool }
}

function cleanMcpToolName(name: string): string {
  if (name.startsWith("mcp:")) {
    const slash = name.indexOf("/")
    return slash >= 0 ? name.slice(slash + 1) : name.slice(4)
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__")
    return parts[parts.length - 1] ?? name
  }
  return name
}

/* ── Tool Events summary (light-themed) ── */

function ToolEventsSummary({
  toolEvents,
  cleanName,
}: { toolEvents: ToolEvent[]; cleanName?: (name: string) => string }) {
  const completed = toolEvents.filter((e) => e.type === "tool_result")
  const errors = completed.filter((e) => e.status === "error")
  return (
    <div className="space-y-1">
      {toolEvents
        .filter((e) => e.type === "tool_use")
        .map((e, i) => {
          const result = toolEvents.find(
            (r, j) =>
              r.type === "tool_result" &&
              j > toolEvents.indexOf(e) &&
              (j === toolEvents.indexOf(e) + 1 ||
                !toolEvents.slice(toolEvents.indexOf(e) + 1, j).some((x) => x.type === "tool_use")),
          )
          const isError = result?.status === "error"
          const displayName = cleanName ? cleanName(e.toolName) : e.toolName
          return (
            <div
              key={`${e.toolName}-${i}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs text-slate-600"
            >
              <Wrench className="h-3 w-3 shrink-0 text-slate-400" />
              <span className="font-medium">{displayName}</span>
              {e.toolInput && <span className="truncate text-slate-400">{e.toolInput}</span>}
              <span
                className={`ml-auto shrink-0 text-[10px] font-medium ${isError ? "text-red-500" : "text-emerald-500"}`}
              >
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

/* ── F026 P3.1: 派发协议 retry badge / 硬警示 ── */

const DISPATCH_RETRY_EXHAUSTED_THRESHOLD = 3

const DISPATCH_RETRY_REASON_LABEL: Record<DispatchValidationRetryReason, string> = {
  nested_call_tag: "嵌套 [Call:]",
  naked_at_with_real_teammate: "行首裸 @ 缺 [Call:] 包装",
}

function DispatchRetryBadge({
  retryCount,
  retryReasons,
}: {
  retryCount: number
  retryReasons: DispatchValidationRetryReason[]
}) {
  const [expanded, setExpanded] = useState(false)
  const exhausted = retryCount >= DISPATCH_RETRY_EXHAUSTED_THRESHOLD

  if (exhausted) return null // 兜底警示走 banner（DispatchRetryExhaustedBanner），不再贴小 badge

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 transition hover:bg-amber-100"
      title={`派发协议自动重写 ${retryCount} 次`}
    >
      <AlertTriangle className="mr-0.5 inline-block h-2.5 w-2.5" />
      重写 {retryCount} 次
      {expanded && retryReasons.length > 0
        ? ` · ${retryReasons.map((r) => DISPATCH_RETRY_REASON_LABEL[r] ?? r).join(" / ")}`
        : ""}
    </button>
  )
}

function DispatchRetryExhaustedBanner({
  retryCount,
  retryReasons,
}: {
  retryCount: number
  retryReasons: DispatchValidationRetryReason[]
}) {
  const reasonText =
    retryReasons.length > 0
      ? retryReasons.map((r) => DISPATCH_RETRY_REASON_LABEL[r] ?? r).join(" / ")
      : "派发协议反复写错"
  return (
    <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-[12px] text-rose-700">
      <AlertCircle className="mr-1 inline-block h-3.5 w-3.5" />
      派发协议反复写错（已重试 {retryCount} 次） — 派发未触发，请手动 @ 触发 ·
      <span className="ml-1 text-rose-600/80">原因：{reasonText}</span>
    </div>
  )
}

/* ── Main Card ── */

export const MessageBubble = memo(function MessageBubble({
  message,
  inlineDecisions,
  onDecisionRespond,
  onDelete,
  onCopy,
}: MessageBubbleProps) {
  const showThinking = useSettingsStore((state) => state.showThinking)
  const isUser = message.role === "user"
  const avatarIdentity = isUser ? "user" : message.provider
  const displayAlias = isUser ? "你" : message.alias

  const foldable = !isUser
  const folded = useIsMessageFolded(message.id, message.provider)
  const toggleMessage = useFoldStore((s) => s.toggleMessage)
  const isFolded = foldable && folded

  const isStreaming = message.messageType === "progress"
  // F026 P3.1 · AC-22: retry 期间锁住 content 渲染，避免用户看到"从头流"诡异感
  const retryLock = useDispatchRetryStreamingLock(message.id)
  const cleanedThinking = !isUser && message.thinking ? cleanThinking(message.thinking) : ""
  const hasThinking = !isUser && cleanedThinking && showThinking
  const allToolEvents = (!isUser && message.toolEvents) || []
  const {
    mcp: mcpEvents,
    skill: skillToolEvents,
    tool: regularToolEvents,
  } = classifyToolEvents(allToolEvents)
  const hasToolEvents = regularToolEvents.length > 0
  const hasMcpEvents = mcpEvents.length > 0
  const hasSkillEvents = skillToolEvents.length > 0
  const accent = PROVIDER_ACCENT[message.provider] ?? "#94A3B8"
  const theme = !isUser ? thinkingTheme[message.provider] : null

  const toolCount = regularToolEvents.filter((e) => e.type === "tool_use").length
  const mcpCount = mcpEvents.filter((e) => e.type === "tool_use").length
  const skillCount = skillToolEvents.filter((e) => e.type === "tool_use").length

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
              {/* F026 P3.1: 派发协议 retry badge — header 显眼 */}
              {message.retryCount !== undefined && message.retryCount > 0 && (
                <DispatchRetryBadge
                  retryCount={message.retryCount}
                  retryReasons={message.retryReasons ?? []}
                />
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
              {isFolded ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>

        {/* F026 P3.1 · AC-14: 派发协议 retry 实时进度卡（assistant final 入库前显示） */}
        <DispatchRetryProgressCard messageId={message.id} />

        {/* F026 P3.1: 派发协议 retry 耗尽 → 红 banner 硬警示 */}
        {message.retryCount !== undefined &&
          message.retryCount >= DISPATCH_RETRY_EXHAUSTED_THRESHOLD && (
            <DispatchRetryExhaustedBanner
              retryCount={message.retryCount}
              retryReasons={message.retryReasons ?? []}
            />
          )}

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
            {(hasSkillEvents || hasToolEvents || hasMcpEvents || hasThinking) && (
              <div className="space-y-2 px-4 pt-3">
                {hasSkillEvents && (
                  <CollapsibleBlock
                    title={`Skill 调用 (${skillCount})`}
                    icon={<Zap className="h-3.5 w-3.5 text-amber-500" />}
                    accentColor={accent}
                  >
                    <ToolEventsSummary toolEvents={skillToolEvents} />
                  </CollapsibleBlock>
                )}

                {hasMcpEvents && (
                  <CollapsibleBlock
                    title={`MCP 调用 (${mcpCount})`}
                    icon={<Plug className="h-3.5 w-3.5 text-violet-500" />}
                    accentColor={accent}
                    isStreaming={isStreaming}
                  >
                    <ToolEventsSummary toolEvents={mcpEvents} cleanName={cleanMcpToolName} />
                  </CollapsibleBlock>
                )}

                {hasToolEvents && (
                  <CollapsibleBlock
                    title={`工具调用 (${toolCount})`}
                    icon={<Wrench className="h-3.5 w-3.5 text-slate-500" />}
                    accentColor={accent}
                    isStreaming={isStreaming}
                  >
                    <ToolEventsSummary toolEvents={regularToolEvents} />
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
                        content={cleanedThinking}
                      />
                    </div>
                  </CollapsibleBlock>
                )}
              </div>
            )}

            {/* Content — always visible (AC-22: retry 期间用占位锁替换) */}
            <div className="px-4 py-3 text-sm text-slate-700">
              {retryLock.isLocked ? (
                <DispatchRetryStreamingLock
                  attemptIndex={retryLock.attemptIndex}
                  maxAttempts={retryLock.maxAttempts}
                />
              ) : (
                <BlockRenderer
                  blocks={normalizeMessageToBlocks(message).filter((b) => b.kind !== "thinking")}
                  provider={message.provider}
                />
              )}
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
