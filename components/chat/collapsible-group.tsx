"use client"

import { useFoldStore, useIsGroupFolded } from "@/components/stores/fold-store"
import type { DecisionRequest, TimelineMessage } from "@multi-agent/shared"
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react"
import { buildFoldedPreview } from "./message-bubble"
import { MessageBubble } from "./message-bubble"
import { ProviderAvatar } from "./provider-avatar"

interface CollapsibleGroupProps {
  header: TimelineMessage
  members: TimelineMessage[]
  inlineDecisionsByMsgId?: Map<string, DecisionRequest[]>
  onDecisionRespond?: (
    requestId: string,
    decisions: Array<{ optionId: string; verdict: "approved" | "rejected" | "modified"; modification?: string }>,
    userInput?: string,
  ) => void
  onCopy?: (content: string) => void
}

/**
 * Derives a human-readable title line for the collapsed group header.
 */
function buildGroupTitle(header: TimelineMessage, members: TimelineMessage[]): string {
  const source = header.connectorSource
  const label = source?.label ?? "消息组"

  if (label.includes("并行") || label.includes("独立思考")) {
    const targetCount = source?.targets?.length ?? 0
    const completedCount = members.length
    return `${label}  ✅${completedCount}/${targetCount || completedCount} 完成`
  }

  if (label.includes("串行") || label.includes("讨论")) {
    // Derive rough "round" count: count distinct provider transitions
    let rounds = 1
    for (let i = 1; i < members.length; i++) {
      if (members[i].provider !== members[i - 1].provider) {
        rounds++
      }
    }
    return `${label}  (${members.length}条消息 · ${rounds}轮)`
  }

  // A2A handoff: use fromAlias/toAlias if available
  if (source?.fromAlias && source?.toAlias) {
    return `${source.fromAlias} 请求 ${source.toAlias} 协助`
  }

  return label
}

/**
 * Collapsible container that renders a group of related timeline messages.
 * Default state: collapsed. Shows a compact summary row.
 * Expanded state: renders each member as a compact MessageBubble inside
 * a shared container.
 */
export function CollapsibleGroup({
  header,
  members,
  inlineDecisionsByMsgId,
  onDecisionRespond,
  onCopy,
}: CollapsibleGroupProps) {
  const groupId = header.groupId!
  const isCollapsed = useIsGroupFolded(groupId)
  const toggleGroup = useFoldStore((s) => s.toggleGroup)
  const source = header.connectorSource
  const targets = source?.targets ?? []

  // Unique providers among members for avatar display
  const memberProviders = [...new Set(members.map((m) => m.provider))]

  const title = buildGroupTitle(header, members)
  const lastMember = members.at(-1)
  const preview = lastMember ? buildFoldedPreview(lastMember.content) : ""

  return (
    <div className="mb-6 flex w-full flex-col items-stretch">
      <div className="mx-auto w-full max-w-[780px] overflow-hidden rounded-[28px] border border-indigo-200/70 bg-gradient-to-br from-indigo-50/70 via-white to-violet-50/50 shadow-[0_18px_40px_rgba(79,70,229,0.08)]">
        {/* ── Header row (always visible) ── */}
        <button
          className="flex w-full cursor-pointer select-none items-center gap-3 px-6 py-3.5 text-left transition-colors hover:bg-indigo-50/40"
          onClick={() => toggleGroup(groupId)}
          type="button"
        >
          {/* Fold arrow */}
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
            {isCollapsed ? (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </span>

          {/* Title + preview */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold tracking-wide text-indigo-900">
                {title}
              </span>
              {/* Message count badge */}
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100/80 px-2 py-0.5 text-[10px] font-medium text-indigo-600">
                <MessageSquare className="h-3 w-3" />
                {members.length}
              </span>
            </div>
            {isCollapsed && preview ? (
              <p className="mt-0.5 truncate text-[11px] italic text-slate-400">
                {preview}
              </p>
            ) : null}
          </div>

          {/* Participant avatars */}
          {(targets.length > 0 || memberProviders.length > 0) ? (
            <div className="ml-auto flex shrink-0 -space-x-1.5">
              {(targets.length > 0 ? targets : memberProviders).map((provider) => (
                <ProviderAvatar key={provider} identity={provider} size="xs" />
              ))}
            </div>
          ) : null}
        </button>

        {/* ── Expanded body ── */}
        <div
          className={`grid transition-all duration-300 ease-in-out ${
            isCollapsed
              ? "grid-rows-[0fr] opacity-0"
              : "grid-rows-[1fr] opacity-100"
          }`}
        >
          <div className="overflow-hidden">
            <div className="border-t border-indigo-100/80 px-4 pb-4 pt-3">
              {members.map((member) => (
                <div key={member.id} className="mb-3 last:mb-0">
                  <MessageBubble
                    message={member}
                    inlineDecisions={inlineDecisionsByMsgId?.get(member.id)}
                    onDecisionRespond={onDecisionRespond}
                    onCopy={onCopy ? (content: string) => onCopy(content) : undefined}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
