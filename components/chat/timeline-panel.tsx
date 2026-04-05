"use client"

import { useApprovalStore } from "@/components/stores/approval-store"
import { useDecisionStore } from "@/components/stores/decision-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { useEffect, useRef } from "react"
import { ApprovalCard } from "./approval-card"
import { DecisionCard } from "./decision-card"
import { MessageBubble } from "./message-bubble"

export function TimelinePanel() {
  const timeline = useThreadStore((state) => state.timeline)
  const pendingApprovals = useApprovalStore((state) => state.pending)
  const respondApproval = useApprovalStore((state) => state.respond)
  const pendingDecisions = useDecisionStore((state) => state.pending)
  const respondDecision = useDecisionStore((state) => state.respond)
  const latestMessageId = timeline.at(-1)?.id
  const scrollRef = useRef<HTMLDivElement>(null)

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
        {timeline.length === 0 ? (
          <div className="flex min-h-[40vh] items-center justify-center text-slate-400">
            <div className="rounded-[28px] border border-dashed border-slate-200 bg-white/70 px-8 py-6 text-center shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
              <p className="text-sm italic">尚无消息。</p>
            </div>
          </div>
        ) : (
          timeline.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onCopy={(content) => navigator.clipboard.writeText(content)}
            />
          ))
        )}
        {pendingDecisions.map((request) => (
          <DecisionCard key={request.requestId} request={request} onRespond={respondDecision} />
        ))}
        {pendingApprovals.map((request) => (
          <ApprovalCard key={request.requestId} request={request} onRespond={respondApproval} />
        ))}
      </div>
    </div>
  )
}
