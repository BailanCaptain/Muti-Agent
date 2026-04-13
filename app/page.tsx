"use client"

import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { SettingsModal } from "@/components/chat/settings-modal"
import { SessionSidebar } from "@/components/chat/session-sidebar"
import { StatusPanel } from "@/components/chat/status-panel"
import { TimelinePanel } from "@/components/chat/timeline-panel"
import { useApprovalNotification } from "@/components/hooks/use-approval-notification"
import { useChatStore } from "@/components/stores/chat-store"
import { useLayoutStore } from "@/components/stores/layout-store"
import { useSettingsStore } from "@/components/stores/settings-store"
import { useApprovalStore } from "@/components/stores/approval-store"
import { useDecisionBoardStore } from "@/components/stores/decision-board-store"
import { useDecisionStore } from "@/components/stores/decision-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { PROVIDER_ALIASES, type BlockedDispatchAttempt } from "@multi-agent/shared"
import { connectRealtime } from "@/components/ws/client"
import { PanelLeft, PanelLeftClose, PanelRight, PanelRightClose } from "lucide-react"
import { useEffect } from "react"

function formatBlockedDispatchMessage(attempts: BlockedDispatchAttempt[]) {
  if (!attempts.length) {
    return "跟进提及被阻止。"
  }

  const getAlias = (attempt: BlockedDispatchAttempt) =>
    PROVIDER_ALIASES[attempt.to.provider] || attempt.to.provider

  if (attempts.length === 1) {
    return `针对 ${getAlias(attempts[0])} 的跟进提及被阻止，因为当前协作链已被取消。请发送新的用户消息以重新开始。`
  }

  const aliases = attempts.map(getAlias).join(", ")
  return `针对 ${aliases} 的跟进提及被阻止，因为当前协作链已被取消。请发送新的用户消息以重新开始。`
}

export default function HomePage() {
  useApprovalNotification()

  const bootstrap = useThreadStore((state) => state.bootstrap)
  const selectSessionGroup = useThreadStore((state) => state.selectSessionGroup)
  const applyAssistantDelta = useThreadStore((state) => state.applyAssistantDelta)
  const applyThinkingDelta = useThreadStore((state) => state.applyThinkingDelta)
  const applyToolEvent = useThreadStore((state) => state.applyToolEvent)
  const appendTimelineMessage = useThreadStore((state) => state.appendTimelineMessage)
  const replaceActiveGroup = useThreadStore((state) => state.replaceActiveGroup)
  const setStatus = useChatStore((state) => state.setStatus)
  const setSocketState = useSettingsStore((state) => state.setSocketState)
  const incrementUnread = useThreadStore((state) => state.incrementUnread)
  const addApprovalRequest = useApprovalStore((state) => state.addRequest)
  const removeApprovalRequest = useApprovalStore((state) => state.removeRequest)
  const addDecisionRequest = useDecisionStore((state) => state.addRequest)
  const removeDecisionRequest = useDecisionStore((state) => state.removeRequest)
  const receiveBoardFlush = useDecisionBoardStore((state) => state.receiveFlush)
  const removeBoardItem = useDecisionBoardStore((state) => state.removeItem)

  useEffect(() => {
    void bootstrap().catch((error) => {
      setStatus(error instanceof Error ? error.message : "引导程序启动失败")
    })

    // Keep one websocket subscription for the page and fan updates into the local stores.
    const disconnect = connectRealtime({
      onOpen: () => {
        setSocketState("connected")
        setStatus("实时连接成功")
      },
      onClose: () => {
        setSocketState("disconnected")
        setStatus("连接中断，正在重连…")
      },
      onError: () => {
        setSocketState("error")
        setStatus("实时连接失败，正在重连…")
      },
      onReconnect: () => {
        // B001 Fix 2: frames may have been lost while the socket was down — re-sync from server.
        const groupId = useThreadStore.getState().activeGroupId
        const resync = groupId ? selectSessionGroup(groupId) : bootstrap()
        void resync.catch((error) => {
          setStatus(error instanceof Error ? `重连恢复失败：${error.message}` : "重连恢复失败")
        })
      },
      onMessage: (event) => {
        const activeId = () => useThreadStore.getState().activeGroupId
        const isCurrentSession = (groupId: string) => groupId === activeId()

        if (event.type === "assistant_delta") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyAssistantDelta(event.payload.messageId, event.payload.delta)
          return
        }

        if (event.type === "assistant_thinking_delta") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyThinkingDelta(event.payload.messageId, event.payload.delta)
          return
        }

        if (event.type === "assistant_tool_event") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyToolEvent(event.payload.messageId, event.payload.event)
          return
        }

        if (event.type === "message.created") {
          if (event.payload.sessionGroupId && !isCurrentSession(event.payload.sessionGroupId)) {
            incrementUnread(event.payload.sessionGroupId)
          } else {
            appendTimelineMessage(event.payload.message)
          }
          return
        }

        if (event.type === "thread_snapshot") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          replaceActiveGroup(event.payload.activeGroup)
          return
        }

        if (event.type === "approval.request") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          addApprovalRequest(event.payload)
          return
        }

        if (event.type === "approval.resolved") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          removeApprovalRequest(event.payload.requestId)
          return
        }

        if (event.type === "approval.auto_granted") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          setStatus(`${event.payload.action} — 已自动放行 (规则匹配)`)
          return
        }

        if (event.type === "decision.request") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          addDecisionRequest(event.payload)
          return
        }

        if (event.type === "decision.resolved") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          removeDecisionRequest(event.payload.requestId)
          return
        }

        if (event.type === "decision.board_flush") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          receiveBoardFlush(event.payload)
          return
        }

        if (event.type === "decision.board_item_resolved") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          removeBoardItem(event.payload.itemId)
          return
        }

        if (event.type === "dispatch.blocked") {
          const groupId = event.payload.attempts[0]?.sessionGroupId
          if (groupId && !isCurrentSession(groupId)) return
          setStatus(formatBlockedDispatchMessage(event.payload.attempts))
          return
        }

        if (event.type === "status") {
          if (event.payload.sessionGroupId && !isCurrentSession(event.payload.sessionGroupId)) return
          setStatus(event.payload.message)
        }
      },
    })

    return disconnect
  }, [
    addApprovalRequest,
    addDecisionRequest,
    appendTimelineMessage,
    incrementUnread,
    applyAssistantDelta,
    applyThinkingDelta,
    bootstrap,
    receiveBoardFlush,
    removeApprovalRequest,
    removeBoardItem,
    removeDecisionRequest,
    replaceActiveGroup,
    selectSessionGroup,
    setSocketState,
    setStatus,
  ])

  const sidebarCollapsed = useLayoutStore((state) => state.sidebarCollapsed)
  const statusPanelCollapsed = useLayoutStore((state) => state.statusPanelCollapsed)
  const toggleSidebar = useLayoutStore((state) => state.toggleSidebar)
  const toggleStatusPanel = useLayoutStore((state) => state.toggleStatusPanel)

  return (
    <div className="flex h-screen w-full overflow-hidden bg-[radial-gradient(circle_at_20%_20%,rgba(245,208,254,0.18),transparent_35%),radial-gradient(circle_at_80%_20%,rgba(255,244,214,0.18),transparent_35%),radial-gradient(circle_at_50%_80%,rgba(224,242,254,0.18),transparent_35%),linear-gradient(180deg,#f8fafc_0%,#f1f5f9_100%)]">
      {sidebarCollapsed ? (
        <div className="flex h-screen w-12 shrink-0 flex-col items-center border-r border-slate-200/70 bg-[linear-gradient(180deg,#fcf9f4_0%,#f7f8fb_100%)] py-4">
          <button
            className="rounded-lg p-2 text-slate-400 transition hover:bg-white/70 hover:text-slate-600"
            onClick={toggleSidebar}
            title="展开侧边栏"
            type="button"
          >
            <PanelLeft className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <SessionSidebar />
      )}
      <main className="flex flex-1 flex-col overflow-hidden">
        <ChatHeader>
          {!sidebarCollapsed && (
            <button
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              onClick={toggleSidebar}
              title="折叠侧边栏"
              type="button"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
          {!statusPanelCollapsed && (
            <button
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              onClick={toggleStatusPanel}
              title="折叠状态面板"
              type="button"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
        </ChatHeader>
        <div className="flex flex-1 flex-col overflow-hidden bg-white/45 backdrop-blur-sm">
          <TimelinePanel />
          <div className="p-6">
            <div className="mx-auto max-w-4xl">
              <Composer />
            </div>
          </div>
        </div>
      </main>
      {statusPanelCollapsed ? (
        <div className="flex h-screen w-12 shrink-0 flex-col items-center border-l border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.86))] py-4">
          <button
            className="rounded-lg p-2 text-slate-400 transition hover:bg-white/70 hover:text-slate-600"
            onClick={toggleStatusPanel}
            title="展开状态面板"
            type="button"
          >
            <PanelRight className="h-5 w-5" />
          </button>
        </div>
      ) : (
        <StatusPanel />
      )}
      <SettingsModal />
    </div>
  )
}
