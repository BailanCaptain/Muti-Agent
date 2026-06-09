"use client"

import { useLayoutStore } from "@/components/stores/layout-store"
import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { useSettingsModalStore } from "@/components/stores/settings-modal-store"
import { useSettingsStore } from "@/components/stores/settings-store"
import { useThreadStore } from "@/components/stores/thread-store"
import type { Provider } from "@multi-agent/shared"
import { SEAL_THRESHOLDS_BY_PROVIDER, getContextWindowForModel } from "@multi-agent/shared"
import { Settings } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { FoldControls } from "./fold-controls"
import { AgentConfigDrawer } from "./right-panel/agent-config-drawer"
import { AgentList, type AgentListItem } from "./right-panel/agent-list"
import { GlobalDefaultsTab } from "./right-panel/global-defaults-tab"
import { ObservationBar } from "./right-panel/observation-bar"
import { ResizeHandle } from "./right-panel/resize-handle"
import { resolveDisplayModel } from "./right-panel/resolve-display-model"
import { RoomBadge } from "./right-panel/room-badge"
import { RoomSwitches } from "./right-panel/room-switches"
// F027 P3-2 (Day 12-13) · RuntimeLog 5-tab 容器，挂在 5 sticky 段下方
import { RuntimeLog } from "./right-panel/runtime-log"
// F027 P3-1 扩展（小孙 2026-06-02 · 方案一 split）· 上下两区之间的拖动分隔线
import { ResizeHandleVertical } from "./right-panel/runtime-log/resize-handle-vertical"
import { SessionOverridesTab } from "./right-panel/session-overrides-tab"

export function StatusPanel() {
  const activeGroup = useThreadStore((state) => state.activeGroup)
  const activeGroupId = useThreadStore((state) => state.activeGroupId)
  const providers = useThreadStore((state) => state.providers)
  const timeline = useThreadStore((state) => state.timeline)
  const stopAgent = useThreadStore((state) => state.stopAgent)
  const showThinking = useSettingsStore((state) => state.showThinking)
  const setShowThinking = useSettingsStore((state) => state.setShowThinking)
  const openSettings = useSettingsModalStore((state) => state.open)
  // F027 P3-1 (Phase 3 Week 3 Day 11) · 拖宽 width 由 layout-store 集中管理
  const statusPanelWidth = useLayoutStore((state) => state.statusPanelWidth)
  // F027 P3-1 扩展（方案一 split）· 日志折叠时不显示上下分隔线
  const runtimeLogCollapsed = useRuntimeLogStore((state) => state.collapsed)

  const runtimeLoaded = useRuntimeConfigStore((state) => state.loaded)
  const runtimeLoad = useRuntimeConfigStore((state) => state.load)
  const loadSession = useRuntimeConfigStore((state) => state.loadSession)
  const sessionConfig = useRuntimeConfigStore((state) => state.sessionConfig)
  const globalConfig = useRuntimeConfigStore((state) => state.config)
  const activeSessionId = useRuntimeConfigStore((state) => state.activeSessionId)

  const [drawerProvider, setDrawerProvider] = useState<Provider | null>(null)

  useEffect(() => {
    if (!runtimeLoaded) void runtimeLoad()
  }, [runtimeLoaded, runtimeLoad])

  useEffect(() => {
    if (activeGroupId && activeGroupId !== activeSessionId) {
      void loadSession(activeGroupId)
    }
  }, [activeGroupId, activeSessionId, loadSession])

  const providerEntries = useMemo(
    () => Object.entries(providers) as Array<[Provider, (typeof providers)[Provider]]>,
    [providers],
  )

  const agents: AgentListItem[] = useMemo(
    () =>
      providerEntries.map(([provider, card]) => {
        const sessionPct = sessionConfig[provider]?.sealPct
        const globalPct = globalConfig[provider]?.sealPct
        const fallback = SEAL_THRESHOLDS_BY_PROVIDER[provider]
        const actionPct = sessionPct ?? globalPct ?? fallback.action
        const window =
          sessionConfig[provider]?.contextWindow ??
          globalConfig[provider]?.contextWindow ??
          getContextWindowForModel(card.currentModel)
        return {
          provider,
          alias: card.alias,
          model: resolveDisplayModel(provider, sessionConfig, globalConfig, card.currentModel),
          running: card.running,
          hasSessionOverride: Boolean(sessionConfig[provider]),
          fillRatio: card.fillRatio ?? null,
          window: window ?? null,
          actionPct,
          sealed: card.sealed ?? false,
        }
      }),
    [providerEntries, sessionConfig, globalConfig],
  )

  const stats = useMemo(() => {
    const messages = timeline.length
    const evidence = timeline.filter((message) =>
      /(https?:\/\/|```|^\s*>|\|.+\|)/m.test(`${message.content}\n${message.thinking ?? ""}`),
    ).length
    const followUp = timeline.filter((message) => message.role === "user").length
    return { messages, evidence, followUp }
  }, [timeline])

  const drawerIsRunning = drawerProvider ? (providers[drawerProvider]?.running ?? false) : false

  return (
    <aside
      // F027 P3-1 (Phase 3 Week 3 Day 11 + r2 范-r1 P2-1 + v3.4 patch):
      //   - 宽度从 F021 旧值 w-[340px] 改为 zustand layout-store statusPanelWidth (360-1200, v3.4 max 升)
      //   - r2 P2-1: 加 shrink-0 + style min/maxWidth 防 flex layout 收缩低于 360
      //     （原 r1 单纯 style width 在 flex row + 480px preview panel 同窗时会被
      //     flex shrink-1 默认行为缩到 < 360，违反 AC 实际渲染范围）
      // ResizeHandle 绝对定位在 aside 左边缘，aside relative 给它作锚点。
      style={{
        width: `${statusPanelWidth}px`,
        minWidth: `${360}px`,
        maxWidth: `${1200}px`,
      }}
      className="relative flex h-screen shrink-0 flex-col gap-3 overflow-hidden border-l border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.86))] px-4 py-4 shadow-[-18px_0_48px_rgba(15,23,42,0.04)] backdrop-blur-xl"
    >
      <ResizeHandle />
      {/* F027 P3-1 扩展（小孙 2026-06-02）：上方 5 段包成可收缩+可滚动区（flex-1 min-h-0），
          这样 RuntimeLog 竖直拖高时上方内容自动让位/滚动，不会被 aside overflow-hidden 顶出屏幕。 */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <div className="flex items-center justify-between gap-2">
          <RoomBadge
            title={activeGroup?.title ?? "未命名"}
            roomId={activeGroup?.id ?? ""}
            globalRoomId={activeGroup?.roomId ?? null}
          />
          <button
            type="button"
            onClick={openSettings}
            aria-label="打开设置"
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
        <ObservationBar
          messages={stats.messages}
          evidence={stats.evidence}
          followUp={stats.followUp}
          sessionChainHref="#invocation-chain"
        />
        <AgentList
          agents={agents}
          onConfigClick={(p) => setDrawerProvider(p)}
          onStopClick={(p) => void stopAgent(p)}
        />
        <FoldControls />
        <RoomSwitches showThinking={showThinking} onToggleThinking={setShowThinking} />
      </div>

      {/* F027 P3-1 扩展（方案一 split）· 上区 / 日志区之间的拖动分隔线（折叠时隐藏） */}
      {!runtimeLogCollapsed && <ResizeHandleVertical />}

      {/* F027 P3-2 (Day 12-13) · ★ RuntimeLog 5-tab 容器 — 挂在分隔线下方，固定/可拖高度 */}
      <RuntimeLog />

      {drawerProvider ? (
        <AgentConfigDrawer
          isOpen
          provider={drawerProvider}
          onClose={() => setDrawerProvider(null)}
          globalSlot={<GlobalDefaultsTab provider={drawerProvider} />}
          sessionSlot={
            <SessionOverridesTab provider={drawerProvider} isRunning={drawerIsRunning} />
          }
        />
      ) : null}
    </aside>
  )
}
