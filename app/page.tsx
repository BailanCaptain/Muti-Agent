"use client"

import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { SessionSidebar } from "@/components/chat/session-sidebar"
import { SettingsModal } from "@/components/chat/settings-modal"
import { StatusPanel } from "@/components/chat/status-panel"
import { TimelinePanel } from "@/components/chat/timeline-panel"
import { BrowserPanel } from "@/components/preview/browser-panel"
import { dispatchArchiveStateChanged } from "@/components/stores/archive-event-handler"
import { useChatStore } from "@/components/stores/chat-store"
import { useDecisionBoardStore } from "@/components/stores/decision-board-store"
import { useDecisionStore } from "@/components/stores/decision-store"
import { useDispatchRetryStore } from "@/components/stores/dispatch-retry-store"
import { useLayoutStore } from "@/components/stores/layout-store"
import { useSettingsStore } from "@/components/stores/settings-store"
import { setDeltaHoleHandler, useThreadStore } from "@/components/stores/thread-store"
// F027 P3-5 (Day 14-15) · wake-up 触发因 store · WS event "wake.trigger" 拦截入这里
import { useWakeTriggerStore } from "@/components/stores/wake-trigger-store"
import { connectRealtime } from "@/components/ws/client"
// F031 · WS 广播流 gap 检测：观测带 seq 事件，跳号/epoch 变化/delta 空洞 → catch-up 全量重拉
import { streamMonitor } from "@/components/ws/stream-monitor"
import {
  type BlockedDispatchAttempt,
  PROVIDER_ALIASES,
  type SequencedRealtimeServerEvent,
} from "@multi-agent/shared"
import { PanelLeft, PanelLeftClose, PanelRight, PanelRightClose } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

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
  const bootstrap = useThreadStore((state) => state.bootstrap)
  const selectSessionGroup = useThreadStore((state) => state.selectSessionGroup)
  const applyAssistantDelta = useThreadStore((state) => state.applyAssistantDelta)
  const applyThinkingDelta = useThreadStore((state) => state.applyThinkingDelta)
  const resetAssistantStream = useThreadStore((state) => state.resetAssistantStream)
  const restoreAssistantContent = useThreadStore((state) => state.restoreAssistantContent)
  const applyMessageRetryFields = useThreadStore((state) => state.applyMessageRetryFields)
  const applyToolEvent = useThreadStore((state) => state.applyToolEvent)
  const applyContentBlock = useThreadStore((state) => state.applyContentBlock)
  const appendTimelineMessage = useThreadStore((state) => state.appendTimelineMessage)
  const replaceActiveGroup = useThreadStore((state) => state.replaceActiveGroup)
  const applySnapshotDelta = useThreadStore((state) => state.applySnapshotDelta)
  const applyMessageUpdate = useThreadStore((state) => state.applyMessageUpdate)
  const applyUsageSnapshot = useThreadStore((state) => state.applyUsageSnapshot)
  const reconcileOptimisticMessage = useThreadStore((state) => state.reconcileOptimisticMessage)
  const recordMessageInGroup = useThreadStore((state) => state.recordMessageInGroup)
  const applyTitleUpdate = useThreadStore((state) => state.applyTitleUpdate)
  const bumpArchiveStateVersion = useThreadStore((state) => state.bumpArchiveStateVersion)
  const clearActiveGroupIfMatches = useThreadStore((state) => state.clearActiveGroupIfMatches)
  const applyPendingChange = useThreadStore((state) => state.applyPendingChange)
  const setStatus = useChatStore((state) => state.setStatus)
  const setSocketState = useSettingsStore((state) => state.setSocketState)
  const incrementUnread = useThreadStore((state) => state.incrementUnread)
  const addDecisionRequest = useDecisionStore((state) => state.addRequest)
  // F033: decision.resolved 不再只 remove，pending 移轨 records（disabled 卡留在时间线）
  const resolveDecisionFromWs = useDecisionStore((state) => state.resolveFromWs)
  const receiveBoardFlush = useDecisionBoardStore((state) => state.receiveFlush)
  const removeBoardItem = useDecisionBoardStore((state) => state.removeItem)

  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPort, setPreviewPort] = useState(0)
  const [previewPath, setPreviewPath] = useState("/")
  const openPreview = useCallback((port: number, path?: string) => {
    setPreviewPort(port)
    setPreviewPath(path ?? "/")
    setPreviewOpen(true)
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrap effect runs once on mount
  useEffect(() => {
    void bootstrap().catch((error) => {
      setStatus(error instanceof Error ? error.message : "引导程序启动失败")
    })

    // F031 · catch-up = 复用 selectSessionGroup 全量重拉（与 onReconnect 同路径）。
    // 成功路径 selectSessionGroup 内部 setBaseline 已复位护栏；失败计数达上限降级。
    streamMonitor.onCatchUp(() => {
      const groupId = useThreadStore.getState().activeGroupId
      const resync = groupId ? selectSessionGroup(groupId, { force: true }) : bootstrap()
      void resync
        .then(() => streamMonitor.catchUpDone(true))
        .catch((error) => {
          streamMonitor.catchUpDone(false)
          setStatus(error instanceof Error ? `补拉失败：${error.message}` : "补拉失败")
        })
    })
    // F031 · delta 空洞（offset > 当前长度 = 消息内丢段）与 seq gap 共用 catch-up 通道
    setDeltaHoleHandler((info) => streamMonitor.reportHole(info))

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
        const resync = groupId ? selectSessionGroup(groupId, { force: true }) : bootstrap()
        void resync.catch((error) => {
          setStatus(error instanceof Error ? `重连恢复失败：${error.message}` : "重连恢复失败")
        })
      },
      onMessage: (event) => {
        const activeId = () => useThreadStore.getState().activeGroupId
        const isCurrentSession = (groupId: string) => groupId === activeId()

        // F031 · gap 检测前置观测：drop = seq ≤ 快照水位线（已覆盖的陈旧重放），跳过；
        // 跳号/epoch 变化在 observe 内部触发 catch-up，事件本身照常往下走
        if (streamMonitor.observe(event as SequencedRealtimeServerEvent) === "drop") return

        if (event.type === "assistant_delta") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyAssistantDelta(event.payload.messageId, event.payload.delta, event.payload.offset)
          return
        }

        if (event.type === "assistant_thinking_delta") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyThinkingDelta(event.payload.messageId, event.payload.delta, event.payload.offset)
          return
        }

        if (event.type === "assistant_tool_event") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyToolEvent(event.payload.messageId, event.payload.event)
          return
        }

        if (event.type === "assistant_content_block") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyContentBlock(event.payload.messageId, event.payload.block)
          return
        }

        // F027 P3-5 (Day 14-15) · wake-up 触发因 — G1 commit c227eef 后端广播
        // wake.trigger event；前端 record 到 wake-trigger-store，prompt-inspector
        // 顶部读取渲染 🔔 触发因块（V16.5.2）+ click pill in-place drawer 复用
        // F026 <A2ATreeView>。跨房间 — 不做 isCurrentSession 过滤（多 room 都记，
        // PromptInspectorTab 按 (roomId, alias) 查自己的）。
        if (event.type === "wake.trigger") {
          useWakeTriggerStore.getState().recordTrigger(event.payload)
          return
        }

        if (event.type === "message.created") {
          if (event.payload.sessionGroupId) {
            recordMessageInGroup(event.payload.sessionGroupId, event.payload.message)
          }
          if (event.payload.sessionGroupId && !isCurrentSession(event.payload.sessionGroupId)) {
            incrementUnread(event.payload.sessionGroupId)
          } else if (event.payload.clientMessageId) {
            reconcileOptimisticMessage(event.payload.clientMessageId, event.payload.message)
          } else {
            appendTimelineMessage(event.payload.message)
          }
          // F026 P3.1 · AC-14: assistant final 真正落库后清掉对应进度卡（兜底；
          // status="exhausted" 已由 store 自身清掉）
          if (event.payload.message.role === "assistant") {
            useDispatchRetryStore.getState().clearRetry(event.payload.message.id)
          }
          return
        }

        if (event.type === "message.updated") {
          // F043 P1-1（德彪 r1）· turn 收尾终稿全量重推 → 当前会话按 id upsert，
          // token 胶囊不刷新点亮。跨房间不动 timeline（切回时 HTTP 快照自带真值）。
          if (!event.payload.sessionGroupId || !isCurrentSession(event.payload.sessionGroupId)) {
            return
          }
          applyMessageUpdate(event.payload.message)
          return
        }

        if (event.type === "dispatch.validation_retry") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          useDispatchRetryStore.getState().recordRetry(event.payload)
          // F026 P3.1 · AC-22: retry 触发清掉 streaming buffer，
          // 避免 retry 后新 delta 与旧不合规 content 拼接污染。settled / exhausted 不需要 reset
          // （此时已不再产生新 delta，content 由 message.created → reconcileOptimisticMessage 写入）
          if (event.payload.status === "retrying") {
            resetAssistantStream(event.payload.messageId)
          }
          // F026 P3.1 review#2 fix: 两条 exhausted 分支后端没有新 delta + 不会发 message.created；
          // resetAssistantStream 清空气泡后必须用 payload.finalContent 把兜底入库内容回填，
          // 否则刷新前用户只看到空气泡 + 红 banner。
          if (event.payload.status === "exhausted" && event.payload.finalContent) {
            restoreAssistantContent(event.payload.messageId, event.payload.finalContent)
          }
          // F026 P4 follow-up · retry-badge-realtime fix:
          // settled / exhausted 终态时把后端送过来的 retry 终值同步到 timeline message,
          // 让 DispatchRetryBadge / ExhaustedBanner 不刷新就出现（之前只入库不广播）。
          if (
            (event.payload.status === "settled" || event.payload.status === "exhausted") &&
            event.payload.retryCount !== undefined &&
            event.payload.retryReasons !== undefined
          ) {
            applyMessageRetryFields(
              event.payload.messageId,
              event.payload.retryCount,
              event.payload.retryReasons,
            )
          }
          return
        }

        if (event.type === "thread_snapshot") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          // F026 review#4 fix · 断线重连后 snapshot 重载，清 pendingByRoot/settledByRoot；
          // 新 timeline 自带最新 a2aCallStatus（LEFT JOIN），terminal cache 不再需要。
          useThreadStore.setState({ pendingByRoot: {}, settledByRoot: {} })
          replaceActiveGroup(event.payload.activeGroup)
          return
        }

        if (event.type === "thread_snapshot_delta") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applySnapshotDelta(event.payload)
          return
        }

        if (event.type === "usage.snapshot") {
          // F043 AC8 · 轮中 usage 快照（节流后）→ 面板上下文条实时刷新
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyUsageSnapshot(event.payload)
          return
        }

        if (event.type === "decision.request") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          addDecisionRequest(event.payload)
          return
        }

        if (event.type === "decision.resolved") {
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          resolveDecisionFromWs(
            event.payload.requestId,
            event.payload.decisions,
            event.payload.userInput,
          )
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

        if (event.type === "preview.auto_open") {
          openPreview(event.payload.port, event.payload.path)
          return
        }

        if (event.type === "pending.change") {
          // F026 P5 F6 · CallRegistry mutation 后 emit pendingSet — 喂 ListeningPulse
          // banner + F1 AtPill 反查 status。仅当属于当前 active session 时入 store
          // （selectSessionGroup 切房间时已清空，避免跨房间状态泄漏）。
          if (!isCurrentSession(event.payload.sessionGroupId)) return
          applyPendingChange(event.payload)
          return
        }

        if (event.type === "session.title_updated") {
          applyTitleUpdate(
            event.payload.sessionGroupId,
            event.payload.title,
            event.payload.titleLockedAt,
          )
          return
        }

        // F022 Phase 3.5 (review P2 follow-up): 归档/软删/恢复广播 dispatch
        // 已抽到 dispatchArchiveStateChanged 纯函数（components/stores/archive-event-handler.ts），
        // 两条分支由 archive-event-handler.test.ts 覆盖。
        if (event.type === "session.archive_state_changed") {
          dispatchArchiveStateChanged(event.payload, {
            bumpArchiveStateVersion,
            clearActiveGroupIfMatches,
          })
          return
        }

        if (event.type === "status") {
          if (event.payload.sessionGroupId && !isCurrentSession(event.payload.sessionGroupId))
            return
          setStatus(event.payload.message)
        }
      },
    })

    return () => {
      // F031 · 卸载时解除 monitor/hole 接线，避免 handler 持有已卸载组件的闭包
      streamMonitor.onCatchUp(null)
      setDeltaHoleHandler(null)
      disconnect()
    }
  }, [
    addDecisionRequest,
    appendTimelineMessage,
    applyTitleUpdate,
    bumpArchiveStateVersion,
    clearActiveGroupIfMatches,
    incrementUnread,
    applyAssistantDelta,
    applyThinkingDelta,
    resetAssistantStream,
    bootstrap,
    openPreview,
    receiveBoardFlush,
    removeBoardItem,
    applyPendingChange,
    recordMessageInGroup,
    resolveDecisionFromWs,
    replaceActiveGroup,
    selectSessionGroup,
    setSocketState,
    setStatus,
  ])

  const sidebarCollapsed = useLayoutStore((state) => state.sidebarCollapsed)
  const statusPanelCollapsed = useLayoutStore((state) => state.statusPanelCollapsed)
  const toggleSidebar = useLayoutStore((state) => state.toggleSidebar)
  const toggleStatusPanel = useLayoutStore((state) => state.toggleStatusPanel)

  // F040 T7 手机适配：<md 三列布局会把主区挤没，挂载时默认收起两侧栏（都以抽屉形态用）；
  // 之后开合交给用户（persist 记忆），桌面不受影响。hydrated 门（T7 真机第五轮）：
  // dev 分片在手机/组网上下载慢，hydration 前这段窗口 store 还是持久化的桌面态
  // （两抽屉全开+数据全空压在屏上）——hydration 完成前手机上不渲染抽屉层。
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      const layout = useLayoutStore.getState()
      if (!layout.sidebarCollapsed) layout.toggleSidebar()
      if (!layout.statusPanelCollapsed) layout.toggleStatusPanel()
    }
    setHydrated(true)
  }, [])

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-surface">
      {sidebarCollapsed ? (
        <div className="hidden h-dvh w-12 shrink-0 flex-col items-center border-r border-slate-200 bg-surface py-4 md:flex">
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
        <>
          {/* F040 T7 手机（<md）：侧栏是覆盖式抽屉，点遮罩收起；md+ 恢复静态列 */}
          <button
            aria-label="关闭会话列表"
            data-testid="mobile-sidebar-overlay"
            className={`fixed inset-0 z-30 bg-slate-900/40 md:hidden ${hydrated ? "" : "max-md:hidden"}`}
            onClick={toggleSidebar}
            type="button"
          />
          <div
            data-testid="session-sidebar-drawer"
            className={`fixed inset-y-0 left-0 z-40 shadow-2xl md:static md:z-auto md:shrink-0 md:shadow-none ${hydrated ? "" : "max-md:hidden"}`}
          >
            <SessionSidebar />
          </div>
        </>
      )}
      <main className="flex flex-1 flex-col overflow-hidden">
        <ChatHeader>
          {sidebarCollapsed && (
            <button
              data-testid="mobile-sidebar-open"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 md:hidden"
              onClick={toggleSidebar}
              title="展开侧边栏"
              type="button"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          )}
          {!sidebarCollapsed && (
            <button
              className="hidden rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 md:block"
              onClick={toggleSidebar}
              title="折叠侧边栏"
              type="button"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
          {!statusPanelCollapsed && (
            <button
              className="hidden rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 md:block"
              onClick={toggleStatusPanel}
              title="折叠状态面板"
              type="button"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
          {statusPanelCollapsed && (
            <button
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 md:hidden"
              onClick={toggleStatusPanel}
              title="展开状态面板"
              type="button"
            >
              <PanelRight className="h-4 w-4" />
            </button>
          )}
        </ChatHeader>
        <div className="flex flex-1 flex-col overflow-hidden bg-surface-elevated">
          <TimelinePanel />
          <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:p-6">
            <div className="mx-auto max-w-4xl">
              <Composer />
            </div>
          </div>
        </div>
      </main>
      {previewOpen && (
        <div className="hidden w-[480px] shrink-0 md:block">
          <BrowserPanel
            initialPort={previewPort}
            initialPath={previewPath}
            onClose={() => setPreviewOpen(false)}
          />
        </div>
      )}
      {statusPanelCollapsed ? (
        <div className="hidden h-dvh w-12 shrink-0 flex-col items-center border-l border-slate-200 bg-surface py-4 md:flex">
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
        <>
          {/* F040 T7 手机（<md）：状态面板是右侧抽屉，点遮罩收起；md+ 恢复静态列 */}
          <button
            aria-label="关闭状态面板"
            className={`fixed inset-0 z-30 bg-slate-900/40 md:hidden ${hydrated ? "" : "max-md:hidden"}`}
            onClick={toggleStatusPanel}
            type="button"
          />
          <div
            className={`fixed inset-y-0 right-0 z-40 w-screen max-w-[min(85vw,400px)] shadow-2xl md:static md:z-auto md:w-auto md:max-w-none md:shrink-0 md:shadow-none ${hydrated ? "" : "max-md:hidden"}`}
          >
            <StatusPanel />
          </div>
        </>
      )}
      <SettingsModal />
    </div>
  )
}
