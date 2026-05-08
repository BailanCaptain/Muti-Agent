"use client"

import { useDecisionStore } from "@/components/stores/decision-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { ConnectorBubble } from "./connector-bubble"
import { InlineDecisionBoard } from "./decision-board-modal"
import { DecisionCard } from "./decision-card"
import { MessageBubble } from "./message-bubble"
import { SystemNoticeBubble } from "./system-notice-bubble"

export function TimelinePanel() {
  const timeline = useThreadStore((state) => state.timeline)
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
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

  type RenderItem =
    | { kind: "message"; data: (typeof timeline)[number] }
    | { kind: "decision"; data: (typeof standAloneDecisions)[number] }

  const renderItems: RenderItem[] = useMemo(() => {
    const items: RenderItem[] = []
    for (const m of timeline) {
      items.push({ kind: "message", data: m })
    }
    for (const d of standAloneDecisions) {
      items.push({ kind: "decision", data: d })
    }
    return items
  }, [timeline, standAloneDecisions])

  const virtualizer = useVirtualizer({
    count: renderItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 200,
    overscan: 5,
  })

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (latestMessageId && renderItems.length > 0) {
      virtualizer.scrollToIndex(renderItems.length - 1, { align: "end" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestMessageId])

  const handleCopy = useCallback((content: string) => {
    navigator.clipboard.writeText(content)
  }, [])

  return (
    <div
      className="flex flex-1 flex-col overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.92),transparent_26%),linear-gradient(180deg,rgba(248,250,252,0.96),rgba(247,249,252,0.72))] px-6 py-8"
      ref={scrollRef}
    >
      <div className="mx-auto w-full max-w-[980px]">
        {renderItems.length === 0 ? (
          <div className="flex min-h-[40vh] items-center justify-center text-slate-400">
            <div className="rounded-[28px] border border-dashed border-slate-200 bg-white/70 px-8 py-6 text-center shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
              <p className="text-sm italic">尚无消息。</p>
            </div>
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = renderItems[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {item.kind === "decision" ? (
                    <DecisionCard
                      request={item.data}
                      onRespond={respondDecision}
                    />
                  ) : item.data.messageType === "connector" ? (
                    <ConnectorBubble message={item.data} />
                  ) : item.data.messageType === "system_notice" ? (
                    <SystemNoticeBubble message={item.data} />
                  ) : (
                    <MessageBubble
                      message={item.data}
                      inlineDecisions={inlineDecisionsByMsgId.get(item.data.id)}
                      onDecisionRespond={respondDecision}
                      onCopy={handleCopy}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
        <InlineDecisionBoard />
      </div>
    </div>
  )
}
