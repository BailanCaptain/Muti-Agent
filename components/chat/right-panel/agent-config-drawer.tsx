"use client"

import type { Provider } from "@multi-agent/shared"
import { X } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { ProviderAvatar } from "../provider-avatar"

type TabKey = "global" | "session"

type Props = {
  isOpen: boolean
  provider: Provider
  onClose: () => void
  globalSlot?: ReactNode
  sessionSlot?: ReactNode
  children?: ReactNode
}

const providerAlias: Record<Provider, string> = {
  claude: "黄仁勋",
  codex: "范德彪",
  gemini: "桂芬",
}

export function AgentConfigDrawer({
  isOpen,
  provider,
  onClose,
  globalSlot,
  sessionSlot,
  children,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>("global")
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!isOpen || !mounted) {
    return null
  }

  const alias = providerAlias[provider] ?? provider
  const tabClass = (active: boolean) =>
    `flex-1 rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
      active
        ? "bg-white text-slate-900 font-semibold shadow-[0_2px_6px_rgba(15,23,42,0.06)]"
        : "bg-transparent text-slate-500 hover:text-slate-700"
    }`

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose()
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-label={`${provider} 配置`}
        aria-hidden={isOpen ? "false" : "true"}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex w-[460px] max-w-[92vw] max-h-[80vh] flex-col rounded-[18px] border border-slate-200 bg-white shadow-[0_32px_64px_rgba(15,23,42,0.18)]"
      >
        <header className="flex items-center gap-3 px-5 pb-3 pt-5">
          <ProviderAvatar identity={provider} size="md" />
          <div className="flex-1">
            <h3 className="text-[15px] font-semibold text-slate-900">{alias} · 配置</h3>
            <div className="mt-0.5 font-mono text-[11px] text-slate-500">{provider}</div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div role="tablist" className="mx-5 flex gap-0.5 rounded-[10px] bg-slate-100 p-[3px]">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "global"}
            onClick={() => setActiveTab("global")}
            className={tabClass(activeTab === "global")}
          >
            全局默认
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "session"}
            onClick={() => setActiveTab("session")}
            className={tabClass(activeTab === "session")}
          >
            会话专属
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {activeTab === "global" ? globalSlot : sessionSlot}
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
