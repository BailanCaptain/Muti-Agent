"use client"

import { useApprovalStore } from "@/components/stores/approval-store"
import { useDecisionStore } from "@/components/stores/decision-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { useEffect, useRef } from "react"
import { ApprovalCard } from "./approval-card"
import { DecisionCard } from "./decision-card"
import { FoldControls } from "./fold-controls"
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
      {timeline.length > 0 ? (
        // Sticky at the right edge of the scroll container so the global fold controls stay reachable
        // as the user scrolls through long threads. `-mt-8` offsets the parent's py-8 so the toolbar
        // pins flush to the top; `-mx-6` extends the gradient strip across the full width.
        <div className="pointer-events-none sticky top-0 z-10 -mx-6 -mt-8 mb-2 flex justify-end bg-gradient-to-b from-slate-50/95 via-slate-50/70 to-transparent px-6 pt-4 pb-3">
          <div className="pointer-events-auto">
            <FoldControls />
          </div>
        </div>
      ) : null}
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
