"use client"

import { useApprovalStore } from "@/components/stores/approval-store"
import { useRuntimeConfigStore } from "@/components/stores/runtime-config-store"
import { useSettingsModalStore } from "@/components/stores/settings-modal-store"
import { useSettingsStore } from "@/components/stores/settings-store"
import { useThreadStore } from "@/components/stores/thread-store"
import { formatTokenCount } from "@/lib/format"
import type { AuthorizationRule, Provider } from "@multi-agent/shared"
import { Info, MessageSquare, Settings, Shield } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { FoldControls } from "./fold-controls"
import { ProviderAvatar } from "./provider-avatar"

type StatusTab = "session" | "approval"

const panelClassName =
  "rounded-[28px] border border-slate-200/70 bg-white/85 p-4 shadow-[0_18px_42px_rgba(15,23,42,0.06)]"

const providerTheme: Record<
  Provider,
  {
    badge: string
    card: string
    dot: string
    focus: string
    button: string
    progress: string
  }
> = {
  codex: {
    badge: "bg-amber-50 text-amber-700 ring-amber-200/80",
    card: "border-amber-100/80 bg-amber-50/40",
    dot: "bg-amber-500",
    focus: "focus:border-amber-300 focus:ring-amber-100/80",
    button: "bg-amber-500 hover:bg-amber-600",
    progress: "bg-amber-500",
  },
  claude: {
    badge: "bg-violet-50 text-violet-700 ring-violet-200/80",
    card: "border-violet-100/80 bg-violet-50/40",
    dot: "bg-violet-500",
    focus: "focus:border-violet-300 focus:ring-violet-100/80",
    button: "bg-violet-500 hover:bg-violet-600",
    progress: "bg-violet-500",
  },
  gemini: {
    badge: "bg-sky-50 text-sky-700 ring-sky-200/80",
    card: "border-sky-100/80 bg-sky-50/40",
    dot: "bg-sky-500",
    focus: "focus:border-sky-300 focus:ring-sky-100/80",
    button: "bg-sky-500 hover:bg-sky-600",
    progress: "bg-sky-500",
  },
}

const invocationStatusTheme = {
  ACTIVE: {
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-200/80",
    dot: "bg-emerald-500",
  },
  IDLE: {
    badge: "bg-slate-100 text-slate-600 ring-slate-200/80",
    dot: "bg-slate-400",
  },
  ERROR: {
    badge: "bg-rose-50 text-rose-700 ring-rose-200/80",
    dot: "bg-rose-500",
  },
} as const

const invocationStatusOrder = {
  ACTIVE: 0,
  ERROR: 1,
  IDLE: 2,
} as const

function formatStartedAt(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatCachePercent(cachedTokens: number, inputTokens: number) {
  if (inputTokens <= 0) {
    return 0
  }

  return Math.round((cachedTokens / inputTokens) * 100)
}

const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

/* ────────── Default Config (interactive) ────────── */

function DefaultConfigSection({
  provider,
  theme,
}: {
  provider: Provider
  theme: (typeof providerTheme)[Provider]
}) {
  const catalog = useRuntimeConfigStore((state) => state.catalog)
  const runtimeConfig = useRuntimeConfigStore((state) => state.config)
  const setAgentOverride = useRuntimeConfigStore((state) => state.setAgentOverride)

  return (
    <div className="mt-3 border-t border-slate-200/60 pt-2">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
        默认配置
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-12 text-[10px] text-slate-400">模型</span>
          <input
            className={`min-w-0 flex-1 rounded-2xl border border-white/80 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none transition focus:ring-4 ${theme.focus}`}
            list={`default-model-${provider}`}
            value={runtimeConfig[provider]?.model ?? ""}
            onChange={(e) =>
              void setAgentOverride(provider, {
                ...runtimeConfig[provider],
                model: e.target.value,
              })
            }
            placeholder="使用系统默认"
          />
          <datalist id={`default-model-${provider}`}>
            {catalog?.[provider]?.models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.label}
              </option>
            ))}
          </datalist>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 text-[10px] text-slate-400">强度</span>
          <select
            className="min-w-0 flex-1 rounded-2xl border border-white/80 bg-white px-3 py-1.5 text-xs text-slate-700 outline-none transition focus:ring-4 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
            disabled={!catalog?.[provider]?.efforts.length}
            value={runtimeConfig[provider]?.effort ?? ""}
            onChange={(e) =>
              void setAgentOverride(provider, {
                ...runtimeConfig[provider],
                effort: e.target.value,
              })
            }
          >
            <option value="">默认</option>
            {catalog?.[provider]?.efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}

/* ────────── Session Tab ────────── */

function SessionTabContent({
  showThinking,
  setShowThinking,
}: {
  showThinking: boolean
  setShowThinking: (v: boolean) => void
}) {
  const socketState = useSettingsStore((state) => state.socketState)
  const providers = useThreadStore((state) => state.providers)
  const catalogs = useThreadStore((state) => state.catalogs)
  const updateModel = useThreadStore((state) => state.updateModel)
  const timeline = useThreadStore((state) => state.timeline)
  const invocationStats = useThreadStore((state) => state.invocationStats)
  const runtimeConfig = useRuntimeConfigStore((state) => state.config)
  const [draftModels, setDraftModels] = useState<Record<string, string>>({})

  const providerEntries = Object.entries(providers) as Array<
    [Provider, (typeof providers)[Provider]]
  >
  const isAnyRunning = providerEntries.some(([, provider]) => provider.running)

  const stats = useMemo(() => ({
    total: timeline.length,
    agents: timeline.filter((message) => message.role === "assistant" && message.alias !== "System")
      .length,
    system: timeline.filter((message) => message.alias === "System").length,
    evidence: timeline.filter((message) =>
      /(https?:\/\/|```|^\s*>|\|.+\|)/m.test(`${message.content}\n${message.thinking ?? ""}`),
    ).length,
    followUp: timeline.filter((message) => message.role === "user").length,
  }), [timeline])

  const metricCards = [
    { label: "总计", value: stats.total },
    { label: "智能体消息", value: stats.agents },
    { label: "系统", value: stats.system },
    { label: "证据", value: stats.evidence },
    { label: "跟进", value: stats.followUp },
  ]

  const sortedInvocationStats = [...invocationStats].sort((left, right) => {
    const orderDelta = invocationStatusOrder[left.status] - invocationStatusOrder[right.status]
    if (orderDelta !== 0) {
      return orderDelta
    }

    return right.startedAt.localeCompare(left.startedAt)
  })

  return (
    <>
      {/* Room Health */}
      <div className={`${panelClassName} mb-5`}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-800">房间健康度</p>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              {isAnyRunning
                ? "至少有一个智能体正在流式输出或处理中。"
                : "当前没有活跃任务。房间正在等待下一条指令。"}
            </p>
          </div>
          <div
            className={`mt-1 h-2.5 w-2.5 rounded-full ${
              socketState === "connected"
                ? isAnyRunning
                  ? "animate-pulse bg-orange-500"
                  : "bg-emerald-500"
                : "bg-slate-300"
            }`}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">连接</div>
            <div className="mt-1 font-mono text-sm font-semibold text-slate-900">
              {socketState === "connected" ? "在线" : socketState === "error" ? "错误" : "离线"}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">活跃</div>
            <div className="mt-1 font-mono text-sm font-semibold text-slate-900">
              {providerEntries.filter(([, provider]) => provider.running).length}
            </div>
          </div>
        </div>
      </div>

      {/* Message Stats */}
      <div className={`${panelClassName} mb-5`}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">消息统计</h3>
          <MessageSquare className="h-4 w-4 text-slate-400" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {metricCards.map((item) => (
            <div
              className="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-3 py-3"
              key={item.label}
            >
              <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">
                {item.label}
              </div>
              <div className="mt-1 font-mono text-lg font-semibold text-slate-900">
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Fold Controls + Thinking Toggle */}
      <div className="mb-5">
        <FoldControls />
      </div>

      <div className={`${panelClassName} mb-5`}>
        <label className="flex items-center gap-3 cursor-pointer">
          <span className="text-sm text-slate-600">心里话模式</span>
          <div className="relative">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={showThinking}
              onChange={() => setShowThinking(!showThinking)}
            />
            <div className="w-10 h-5 bg-slate-200 rounded-full peer-checked:bg-violet-500 transition" />
            <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition peer-checked:translate-x-5" />
          </div>
        </label>
      </div>

      {/* Agent Config — session only (no default fold) */}
      <div className={`${panelClassName} mb-5`}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">智能体配置</h3>
          <Info className="h-4 w-4 text-slate-400" />
        </div>

        <div className="space-y-4">
          {providerEntries.map(([provider, card]) => {
            const theme = providerTheme[provider]
            const draft = draftModels[provider] ?? card.currentModel ?? ""
            const isDirty = draft !== (card.currentModel ?? "")

            return (
              <div className={`rounded-[24px] border p-3.5 ${theme.card}`} key={provider}>
                <div className="mb-3 flex items-start gap-3">
                  <ProviderAvatar identity={provider} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-semibold text-slate-800">
                        {card.alias}
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${theme.badge}`}
                      >
                        {provider}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                      <span
                        className={`h-2 w-2 rounded-full ${card.running ? theme.dot : "bg-slate-300"}`}
                      />
                      <span>{card.running ? "正在处理当前任务" : "空闲并就绪"}</span>
                    </div>
                  </div>
                </div>

                <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
                  当前会话
                </div>
                <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-slate-400">
                  <span>模型</span>
                  <span className="font-mono text-slate-500">{card.currentModel ?? "未设置"}</span>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    className={`min-w-0 flex-1 rounded-2xl border border-white/80 bg-white px-3 py-2 text-xs text-slate-700 outline-none transition focus:ring-4 ${theme.focus}`}
                    list={`status-model-${provider}`}
                    onChange={(event) =>
                      setDraftModels((current) => ({
                        ...current,
                        [provider]: event.target.value,
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && isDirty) {
                        void updateModel(provider, draft)
                        setDraftModels((current) => {
                          const next = { ...current }
                          delete next[provider]
                          return next
                        })
                      }
                    }}
                    placeholder="选择一个模型"
                    value={draft}
                  />
                  <datalist id={`status-model-${provider}`}>
                    {catalogs[provider]?.modelSuggestions?.map((model) => (
                      <option key={model} value={model} />
                    ))}
                  </datalist>

                  {isDirty ? (
                    <button
                      className={`shrink-0 rounded-full px-3 py-2 text-[11px] font-semibold text-white shadow-sm transition ${theme.button}`}
                      onClick={() => {
                        void updateModel(provider, draft)
                        setDraftModels((current) => {
                          const next = { ...current }
                          delete next[provider]
                          return next
                        })
                      }}
                      type="button"
                    >
                      保存
                    </button>
                  ) : null}
                </div>

                {/* Default config (from runtime-config) */}
                <DefaultConfigSection provider={provider} theme={theme} />
              </div>
            )
          })}
        </div>
      </div>

      {/* Invocation Chain */}
      <div className={panelClassName}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">会话链</h3>
          <span className="font-mono text-[11px] text-slate-400">
            {sortedInvocationStats.length} 次会话
          </span>
        </div>

        <div className="space-y-3">
          {sortedInvocationStats.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-slate-200 bg-slate-50/80 px-4 py-5 text-sm text-slate-400">
              尚无会话遥测数据。
            </div>
          ) : (
            sortedInvocationStats.map((stat) => {
              const theme = providerTheme[stat.provider]
              const statusTheme = invocationStatusTheme[stat.status]
              const totalTokens = stat.inputTokens + stat.outputTokens
              const outputRatio = totalTokens > 0 ? (stat.outputTokens / totalTokens) * 100 : 0
              const progressWidth = totalTokens > 0 ? Math.max(6, Math.min(100, outputRatio)) : 0

              return (
                <div
                  className="rounded-[24px] border border-slate-200/70 bg-slate-50/80 p-3.5"
                  key={stat.sessionId}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`h-2.5 w-2.5 rounded-full ${statusTheme.dot}`} />
                        <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          会话 #{stat.sessionId.slice(0, 8)}
                        </span>
                      </div>
                      <div className="mt-2 font-mono text-[11px] text-slate-500">{stat.model}</div>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${theme.badge}`}
                      >
                        {stat.provider}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusTheme.badge}`}
                      >
                        {stat.status === "ACTIVE"
                          ? "活动"
                          : stat.status === "ERROR"
                            ? "错误"
                            : "空闲"}
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400">
                    <span>{formatStartedAt(stat.startedAt)}</span>
                    <span className="font-mono text-emerald-600">
                      缓存 {formatCachePercent(stat.cachedTokens, stat.inputTokens)}%
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="rounded-2xl bg-white px-2.5 py-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400">
                        输入
                      </div>
                      <div className="mt-1 font-mono text-[11px] font-semibold text-slate-800">
                        {formatTokenCount(stat.inputTokens)}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-white px-2.5 py-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400">
                        输出
                      </div>
                      <div className="mt-1 font-mono text-[11px] font-semibold text-slate-800">
                        {formatTokenCount(stat.outputTokens)}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-white px-2.5 py-2">
                      <div className="text-[10px] uppercase tracking-[0.16em] text-slate-400">
                        总量
                      </div>
                      <div className="mt-1 font-mono text-[11px] font-semibold text-slate-800">
                        {formatTokenCount(totalTokens)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200/80">
                      <div
                        className={`h-full rounded-full transition-all ${theme.progress}`}
                        style={{ width: `${progressWidth}%` }}
                      />
                    </div>
                    <span className="font-mono text-[10px] text-slate-400">
                      {Math.round(outputRatio)}%
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </>
  )
}

/* ────────── Approval Rules Tab ────────── */

function ApprovalTabContent() {
  const pending = useApprovalStore((state) => state.pending)
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
    } catch {
      // Network error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchRules()
  }, [fetchRules])

  return (
    <div className="space-y-5">
      {/* Pending Approvals */}
      <div className={panelClassName}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">待审批</h3>
          <span className="font-mono text-[11px] text-slate-400">
            {pending.length} 条
          </span>
        </div>

        {pending.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-4 text-center text-sm text-slate-400">
            暂无待审批请求
          </div>
        ) : (
          <div className="space-y-2">
            {pending.map((req) => (
              <div
                className="rounded-2xl border border-amber-200/80 bg-amber-50/40 px-3 py-2.5"
                key={req.requestId}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                  <span className="text-xs font-semibold text-slate-700">{req.action}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-slate-200/80">
                    {req.provider}
                  </span>
                </div>
                <div className="mt-1 truncate text-[11px] text-slate-400">{req.reason}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Authorization Rules */}
      <div className={panelClassName}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">授权规则</h3>
          <Shield className="h-4 w-4 text-slate-400" />
        </div>

        {loading ? (
          <div className="py-4 text-center text-xs text-slate-400">加载中...</div>
        ) : rules.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-4 text-center text-sm text-slate-400">
            暂无授权规则
          </div>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div
                className="rounded-2xl border border-slate-200/70 bg-slate-50/80 px-3 py-2.5"
                key={rule.id}
              >
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
                <div className="mt-1 truncate text-xs text-slate-600">{rule.action}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ────────── Main StatusPanel ────────── */

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`
}

export function StatusPanel() {
  const socketState = useSettingsStore((state) => state.socketState)
  const providers = useThreadStore((state) => state.providers)
  const stopAgent = useThreadStore((state) => state.stopAgent)
  const [activeTab, setActiveTab] = useState<StatusTab>("session")
  const showThinking = useSettingsStore((state) => state.showThinking)
  const setShowThinking = useSettingsStore((state) => state.setShowThinking)
  const [elapsed, setElapsed] = useState<Record<string, number>>({})
  const openSettings = useSettingsModalStore((s) => s.open)

  const runtimeLoaded = useRuntimeConfigStore((state) => state.loaded)
  const runtimeLoad = useRuntimeConfigStore((state) => state.load)

  useEffect(() => {
    if (!runtimeLoaded) void runtimeLoad()
  }, [runtimeLoaded, runtimeLoad])

  const providerEntries = Object.entries(providers) as Array<
    [Provider, (typeof providers)[Provider]]
  >
  const isAnyRunning = providerEntries.some(([, provider]) => provider.running)

  // Timer for running agents
  useEffect(() => {
    const interval = setInterval(() => {
      const next: Record<string, number> = {}
      for (const [provider, card] of providerEntries) {
        if (card.running) {
          next[provider] = (elapsed[provider] ?? 0) + 1
        }
      }
      setElapsed(next)
    }, 1000)
    return () => clearInterval(interval)
  }, [providerEntries]) // eslint-disable-line react-hooks/exhaustive-deps

  const modeLabel =
    socketState === "connected"
      ? isAnyRunning
        ? "运行中"
        : "就绪"
      : socketState === "error"
        ? "连接错误"
        : "离线"

  const tabs: { key: StatusTab; label: string }[] = [
    { key: "session", label: "指挥中心" },
    { key: "approval", label: "审批规则" },
  ]

  return (
    <aside className="flex h-screen w-[340px] flex-col overflow-y-auto overflow-x-hidden border-l border-slate-200/80 bg-[linear-gradient(180deg,rgba(248,250,252,0.96),rgba(255,255,255,0.86))] px-5 py-6 shadow-[-18px_0_48px_rgba(15,23,42,0.04)] backdrop-blur-xl">
      {/* Header with settings gear */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-400">
            控制面板
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-[0.01em] text-slate-900">状态看板</h2>
          <p className="mt-1 text-xs text-slate-400">当前模式: {modeLabel}</p>
        </div>
        <button
          className="mt-1 rounded-full p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          onClick={openSettings}
          title="打开设置"
          type="button"
        >
          <Settings className="h-5 w-5" />
        </button>
      </div>

      {/* Active Agent Chips — above Tab Bar */}
      {isAnyRunning && (
        <div className={`${panelClassName} mb-4`}>
          <div className="flex flex-wrap gap-2">
            {providerEntries
              .filter(([, card]) => card.running)
              .map(([provider, card]) => {
                const theme = providerTheme[provider]
                return (
                  <div
                    className={`flex items-center gap-2 rounded-full border px-3 py-1.5 ${theme.card}`}
                    key={provider}
                  >
                    <ProviderAvatar identity={provider} size="xs" />
                    <span className="text-[11px] font-semibold text-slate-700">{card.alias}</span>
                    <span className="text-[10px] text-slate-400">运行中...</span>
                    <span className="font-mono text-[10px] text-slate-500">
                      {formatElapsed(elapsed[provider] ?? 0)}
                    </span>
                    <button
                      className="ml-1 flex items-center gap-0.5 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-600 transition hover:bg-rose-200"
                      onClick={() => void stopAgent(provider)}
                      title={`停止 ${card.alias}`}
                      type="button"
                    >
                      停止
                    </button>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div className="mb-5 flex border-b border-slate-200/70">
        {tabs.map((t) => (
          <button
            className={`relative flex-1 px-2 py-2.5 text-center text-xs font-medium transition ${
              activeTab === t.key
                ? "text-amber-600"
                : "text-slate-400 hover:text-slate-600"
            }`}
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            type="button"
          >
            {t.label}
            {activeTab === t.key && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500" />
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "session" && (
        <SessionTabContent showThinking={showThinking} setShowThinking={setShowThinking} />
      )}
      {activeTab === "approval" && <ApprovalTabContent />}
    </aside>
  )
}
