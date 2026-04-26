"use client"

import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import { useSettingsModalStore } from "@/components/stores/settings-modal-store"
import { useSettingsStore } from "@/components/stores/settings-store"
import { useThreadStore } from "@/components/stores/thread-store"
import type { Provider } from "@multi-agent/shared"
import {
  SEAL_THRESHOLDS_BY_PROVIDER,
  getContextWindowForModel,
} from "@multi-agent/shared"
import { Settings } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { FoldControls } from "./fold-controls"
import { AgentConfigDrawer } from "./right-panel/agent-config-drawer"
import { AgentList, type AgentListItem } from "./right-panel/agent-list"
import { GlobalDefaultsTab } from "./right-panel/global-defaults-tab"
import { ObservationBar } from "./right-panel/observation-bar"
import { resolveDisplayModel } from "./right-panel/resolve-display-model"
import { RoomBadge } from "./right-panel/room-badge"
import { RoomSwitches } from "./right-panel/room-switches"
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
    <aside className="flex h-screen w-[340px] flex-col gap-3 overflow-hidden border-l border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.86))] px-4 py-4 shadow-[-18px_0_48px_rgba(15,23,42,0.04)] backdrop-blur-xl">
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
