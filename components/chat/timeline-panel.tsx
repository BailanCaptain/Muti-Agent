"use client"

import { useDecisionStore } from "@/components/stores/decision-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { ConnectorBubble } from "./connector-bubble"
import { InlineDecisionBoard } from "./decision-board-modal"
import { DecisionCard, DecisionRecordCard } from "./decision-card"
import { splitDecisionsForTimeline } from "./decision-timeline"
import { MessageBubble, buildFoldedPreview } from "./message-bubble"
import { SystemNoticeBubble } from "./system-notice-bubble"
import { TimelineMinimap, buildMinimapMarkers } from "./timeline-minimap"
import { TimelineWelcome } from "./timeline-welcome"

export function TimelinePanel() {
  const timeline = useThreadStore((state) => state.timeline)
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const allPendingDecisions = useDecisionStore((state) => state.pending)
  const allDecisionRecords = useDecisionStore((state) => state.records)
  const respondDecision = useDecisionStore((state) => state.respond)
  const latestMessageId = timeline.at(-1)?.id
  const scrollRef = useRef<HTMLDivElement>(null)

  // F033: pending（活卡）与 records（已决 disabled 卡）分轨拆解，纯函数已单测
  const {
    inlineDecisionsByMsgId,
    standAloneDecisions,
    inlineRecordsByMsgId,
    standaloneRecords,
  } = useMemo(
    () => splitDecisionsForTimeline(allPendingDecisions, allDecisionRecords, activeGroupId),
    [allPendingDecisions, allDecisionRecords, activeGroupId],
  )

  type RenderItem =
    | { kind: "message"; data: (typeof timeline)[number] }
    | { kind: "decision"; data: (typeof standAloneDecisions)[number] }
    | { kind: "record"; data: (typeof standaloneRecords)[number] }

  const renderItems: RenderItem[] = useMemo(() => {
    const items: RenderItem[] = []
    for (const m of timeline) {
      items.push({ kind: "message", data: m })
    }
    // 已决卡在前（历史留痕），pending 卡在后（等待操作，靠近底部）
    for (const r of standaloneRecords) {
      items.push({ kind: "record", data: r })
    }
    for (const d of standAloneDecisions) {
      items.push({ kind: "decision", data: d })
    }
    return items
  }, [timeline, standAloneDecisions, standaloneRecords])

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

  // F036 #9 导航标记锚点：序位投影（见 timeline-minimap.tsx）。把 renderItems 降维成纯
  // MinimapItem 交 buildMinimapMarkers（纯函数·已单测）。决策不打标（pending-only，见该函数注释）。
  const minimapMarkers = useMemo(
    () =>
      buildMinimapMarkers(
        renderItems.map((item) =>
          // F033: record（已决卡）与 decision 同样不打标（decision pending-only 语义不变）
          item.kind === "decision" || item.kind === "record"
            ? { kind: "decision" as const }
            : {
                kind: "message" as const,
                role: item.data.role,
                messageType: item.data.messageType,
                alias: item.data.alias,
                content: item.data.content,
              },
        ),
        buildFoldedPreview,
      ),
    [renderItems],
  )

  const handleJump = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: "start" })
    },
    [virtualizer],
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div
      // F039: 原 rgba(248,250,252) 渐变是 F036 前的股票 slate-50 冷蓝残留，整个聊天区蒙冷膜；
      // 回归 clowder 模型——聊天主区 = surface-elevated（4 档中最亮的暖近白）。
      className="flex flex-1 flex-col overflow-y-auto bg-surface-elevated px-3 py-4 md:px-6 md:py-8"
      ref={scrollRef}
    >
      <div className="mx-auto w-full max-w-[980px]">
        {renderItems.length === 0 ? (
          <div className="flex min-h-[40vh] items-center justify-center">
            <TimelineWelcome />
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
                  ) : item.kind === "record" ? (
                    <DecisionRecordCard record={item.data} />
                  ) : item.data.messageType === "connector" ? (
                    <ConnectorBubble message={item.data} />
                  ) : item.data.messageType === "system_notice" ? (
                    <SystemNoticeBubble message={item.data} />
                  ) : (
                    <MessageBubble
                      message={item.data}
                      inlineDecisions={inlineDecisionsByMsgId.get(item.data.id)}
                      inlineRecords={inlineRecordsByMsgId.get(item.data.id)}
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
      <TimelineMinimap markers={minimapMarkers} onJump={handleJump} />
    </div>
  )
}
