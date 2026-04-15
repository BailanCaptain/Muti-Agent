"use client"

import { useSettingsModalStore } from "@/components/stores/settings-modal-store"
import type { AuthorizationRule } from "@multi-agent/shared"
import { RotateCcw, Shield, Settings, Trash2, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

type SettingsTab = "rules" | "general"

const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

export function SettingsModal() {
  const isOpen = useSettingsModalStore((s) => s.isOpen)
  const close = useSettingsModalStore((s) => s.close)
  const [tab, setTab] = useState<SettingsTab>("rules")
  const [rules, setRules] = useState<AuthorizationRule[]>([])
  const [loading, setLoading] = useState(false)

  const fetchRules = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${baseUrl}/api/authorization/rules`)
      if (res.ok) {
        const data = (await res.json()) as { rules: AuthorizationRule[] }
        setRules(data.rules)
      }
    } catch (err) {
      console.error("[settings-modal] fetch rules error", err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) void fetchRules()
  }, [isOpen, fetchRules])

  const deleteRule = async (id: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/authorization/rules/${id}`, {
        method: "DELETE",
      })
      if (res.ok) {
        setRules((prev) => prev.filter((r) => r.id !== id))
      }
    } catch (err) {
      console.error("[settings-modal] delete rule error", err)
    }
  }

  const resetAllRules = async () => {
    const ids = rules.map((r) => r.id)
    await Promise.all(ids.map((id) => deleteRule(id)))
    setRules([])
  }

  if (!isOpen) return null

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: "rules", label: "权限规则" },
    { key: "general", label: "通用" },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="w-[600px] max-h-[80vh] overflow-hidden rounded-2xl bg-white shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200/70 px-6 py-4">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-slate-500" />
            <h2 className="text-lg font-semibold text-slate-900">设置</h2>
          </div>
          <button
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            onClick={close}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200/70 px-6">
          {tabs.map((t) => (
            <button
              className={`relative px-4 py-3 text-sm font-medium transition ${
                tab === t.key
                  ? "text-amber-600"
                  : "text-slate-500 hover:text-slate-700"
              }`}
              key={t.key}
              onClick={() => setTab(t.key)}
              type="button"
            >
              {t.label}
              {tab === t.key && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500" />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {tab === "rules" && (
            <div className="space-y-3">
              {loading ? (
                <div className="py-8 text-center text-sm text-slate-400">
                  加载中...
                </div>
              ) : rules.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-400">
                  <Shield className="mx-auto mb-2 h-8 w-8 text-slate-300" />
                  暂无权限规则
                </div>
              ) : (
                <>
                  {rules.map((rule) => (
                    <div
                      className="flex items-center justify-between rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-3"
                      key={rule.id}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${
                              rule.decision === "allow"
                                ? "bg-emerald-50 text-emerald-700 ring-emerald-200/80"
                                : "bg-rose-50 text-rose-700 ring-rose-200/80"
                            }`}
                          >
                            {rule.decision === "allow" ? "允许" : "拒绝"}
                          </span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200/80">
                            {rule.provider}
                          </span>
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600 ring-1 ring-slate-200/80">
                            {rule.scope}
                          </span>
                        </div>
                        <div className="mt-1.5 truncate text-xs text-slate-600">
                          {rule.action}
                        </div>
                        {rule.reason && (
                          <div className="mt-0.5 truncate text-[11px] text-slate-400">
                            {rule.reason}
                          </div>
                        )}
                      </div>
                      <button
                        className="ml-3 shrink-0 rounded-full p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-500"
                        onClick={() => void deleteRule(rule.id)}
                        title="删除规则"
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}

                  <div className="pt-2">
                    <button
                      className="flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-200/80 bg-rose-50/50 px-4 py-2.5 text-sm font-medium text-rose-600 transition hover:bg-rose-100/80"
                      onClick={() => void resetAllRules()}
                      type="button"
                    >
                      <RotateCcw className="h-4 w-4" />
                      一键重置所有规则
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "general" && (
            <div className="flex flex-col items-center justify-center py-12 text-sm text-slate-400">
              <Settings className="mb-3 h-10 w-10 text-slate-300" />
              更多设置即将推出
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
