"use client"

import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { SessionSidebar } from "@/components/chat/session-sidebar"
import { StatusPanel } from "@/components/chat/status-panel"
import { TimelinePanel } from "@/components/chat/timeline-panel"
import { useChatStore } from "@/components/stores/chat-store"
import { useSettingsStore } from "@/components/stores/settings-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { connectRealtime } from "@/components/ws/client"
import { useEffect } from "react"

export default function HomePage() {
  const bootstrap = useThreadStore((state) => state.bootstrap)
  const applyAssistantDelta = useThreadStore((state) => state.applyAssistantDelta)
  const appendTimelineMessage = useThreadStore((state) => state.appendTimelineMessage)
  const replaceActiveGroup = useThreadStore((state) => state.replaceActiveGroup)
  const setStatus = useChatStore((state) => state.setStatus)
  const setSocketState = useSettingsStore((state) => state.setSocketState)

  useEffect(() => {
    void bootstrap().catch((error) => {
      setStatus(error instanceof Error ? error.message : "Bootstrap failed")
    })

    // Keep one websocket subscription for the page and fan updates into the local stores.
    const disconnect = connectRealtime({
      onOpen: () => {
        setSocketState("connected")
        setStatus("Realtime connected")
      },
      onClose: () => {
        setSocketState("disconnected")
        setStatus("Realtime disconnected")
      },
      onError: () => {
        setSocketState("error")
        setStatus("Realtime connection failed")
      },
      onMessage: (event) => {
        // The page only routes normalized event envelopes; store-specific merge logic lives downstream.
        if (event.type === "assistant_delta") {
          applyAssistantDelta(event.payload.messageId, event.payload.delta)
          return
        }

        if (event.type === "message.created") {
          appendTimelineMessage(event.payload.message)
          return
        }

        if (event.type === "thread_snapshot") {
          replaceActiveGroup(event.payload.activeGroup)
          return
        }

        if (event.type === "status") {
          setStatus(event.payload.message)
        }
      },
    })

    return disconnect
  }, [
    appendTimelineMessage,
    applyAssistantDelta,
    bootstrap,
    replaceActiveGroup,
    setSocketState,
    setStatus,
  ])

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(255,244,214,0.45),transparent_22%),radial-gradient(circle_at_right,rgba(209,250,229,0.28),transparent_26%),linear-gradient(180deg,#f8fafc_0%,#f6f7fb_100%)]">
      <SessionSidebar />
      <main className="flex flex-1 flex-col overflow-hidden">
        <ChatHeader />
        <div className="flex flex-1 flex-col overflow-hidden bg-white/45 backdrop-blur-sm">
          <TimelinePanel />
          <div className="p-6">
            <div className="mx-auto max-w-4xl">
              <Composer />
            </div>
          </div>
        </div>
      </main>
      <StatusPanel />
    </div>
  )
}
