"use client"

import { useApprovalStore } from "@/components/stores/approval-store"
import { useDecisionStore } from "@/components/stores/decision-store"
import { useThreadStore } from "@/components/stores/thread-store"
import type { TimelineMessage } from "@multi-agent/shared"
import { useEffect, useMemo, useRef } from "react"
import { ApprovalCard } from "./approval-card"
import { CollapsibleGroup } from "./collapsible-group"
import { ConnectorBubble } from "./connector-bubble"
import { DecisionCard } from "./decision-card"
import { MessageBubble } from "./message-bubble"

type GroupedItem =
  | { type: "single"; message: TimelineMessage }
  | { type: "group"; header: TimelineMessage; members: TimelineMessage[] }

/**
 * Transform the flat timeline array into grouped rendering items.
 * Messages with the same `groupId` are collected into a single group entry.
 * - `header` role becomes the group title
 * - `member` role messages become the group body
 * - `convergence` role messages are always standalone (outside any group)
 * - Messages without a `groupId` are standalone
 */
function groupTimeline(timeline: TimelineMessage[]): GroupedItem[] {
  const result: GroupedItem[] = []

  const groupMap = new Map<string, { header?: TimelineMessage; members: TimelineMessage[] }>()

  // First pass: collect groups
  for (const msg of timeline) {
    if (!msg.groupId || msg.groupRole === "convergence") {
      // No group, or convergence (always standalone)
      continue
    }
    const group = groupMap.get(msg.groupId) ?? { members: [] }
    if (msg.groupRole === "header") {
      group.header = msg
    } else if (msg.groupRole === "member") {
      group.members.push(msg)
    }
    groupMap.set(msg.groupId, group)
  }

  // Second pass: build render list in original timeline order
  const emittedGroups = new Set<string>()
  for (const msg of timeline) {
    if (msg.groupId && msg.groupRole !== "convergence") {
      if (!emittedGroups.has(msg.groupId)) {
        emittedGroups.add(msg.groupId)
        const group = groupMap.get(msg.groupId)!
        if (group.header) {
          result.push({ type: "group", header: group.header, members: group.members })
        } else {
          // No header yet, render members individually
          for (const m of group.members) {
            result.push({ type: "single", message: m })
          }
        }
      }
      // Skip individual group messages (already emitted as part of group)
    } else {
      result.push({ type: "single", message: msg })
    }
  }

  return result
}

export function TimelinePanel() {
  const timeline = useThreadStore((state) => state.timeline)
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const pendingApprovals = useApprovalStore((state) => state.pending)
  const respondApproval = useApprovalStore((state) => state.respond)
  const allPendingDecisions = useDecisionStore((state) => state.pending)
  const respondDecision = useDecisionStore((state) => state.respond)
  const latestMessageId = timeline.at(-1)?.id
  const scrollRef = useRef<HTMLDivElement>(null)

  const sessionDecisions = useMemo(
    () => allPendingDecisions.filter((r) => r.sessionGroupId === activeGroupId),
    [allPendingDecisions, activeGroupId],
  )

  const { inlineDecisionsByMsgId, standAloneDecisions } = useMemo(() => {
    const byMsg = new Map<string, typeof sessionDecisions>()
    const standalone: typeof sessionDecisions = []
    for (const d of sessionDecisions) {
      if (d.anchorMessageId) {
        const list = byMsg.get(d.anchorMessageId)
        if (list) list.push(d)
        else byMsg.set(d.anchorMessageId, [d])
      } else {
        standalone.push(d)
      }
    }
    return { inlineDecisionsByMsgId: byMsg, standAloneDecisions: standalone }
  }, [sessionDecisions])

  const groupedItems = useMemo(() => groupTimeline(timeline), [timeline])

  useEffect(() => {
    if (scrollRef.current && latestMessageId) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [latestMessageId])

  return (
    <div
      className="flex flex-1 flex-col overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.92),transparent_26%),linear-gradient(180deg,rgba(248,250,252,0.96),rgba(247,249,252,0.72))] px-6 py-8"
      ref={scrollRef}
    >
      <div className="mx-auto w-full max-w-[980px]">
        {groupedItems.length === 0 ? (
          <div className="flex min-h-[40vh] items-center justify-center text-slate-400">
            <div className="rounded-[28px] border border-dashed border-slate-200 bg-white/70 px-8 py-6 text-center shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
              <p className="text-sm italic">尚无消息。</p>
            </div>
          </div>
        ) : (
          groupedItems.map((item) => {
            if (item.type === "group") {
              return (
                <CollapsibleGroup
                  key={item.header.id}
                  header={item.header}
                  members={item.members}
                  inlineDecisionsByMsgId={inlineDecisionsByMsgId}
                  onDecisionRespond={respondDecision}
                  onCopy={(content) => navigator.clipboard.writeText(content)}
                />
              )
            }

            const message = item.message
            return message.messageType === "connector" ? (
              <ConnectorBubble key={message.id} message={message} />
            ) : (
              <MessageBubble
                key={message.id}
                message={message}
                inlineDecisions={inlineDecisionsByMsgId.get(message.id)}
                onDecisionRespond={respondDecision}
                onCopy={(content) => navigator.clipboard.writeText(content)}
              />
            )
          })
        )}
        {standAloneDecisions.map((request) => (
          <DecisionCard key={request.requestId} request={request} onRespond={respondDecision} />
        ))}
        {pendingApprovals.map((request) => (
          <ApprovalCard key={request.requestId} request={request} onRespond={respondApproval} />
        ))}
      </div>
    </div>
  )
}
