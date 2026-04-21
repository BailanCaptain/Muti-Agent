"use client"

import type { Provider } from "@multi-agent/shared"
import { Settings, Square } from "lucide-react"
import { ProviderAvatar } from "../provider-avatar"

export type AgentListItem = {
  provider: Provider
  alias: string
  model: string | null
  running: boolean
  hasSessionOverride?: boolean
  fillRatio?: number | null
}

type Props = {
  agents: AgentListItem[]
  onConfigClick?: (provider: Provider) => void
  onStopClick?: (provider: Provider) => void
}

function fillRatioTone(ratio: number) {
  if (ratio > 0.7) return { text: "text-rose-500", bar: "bg-rose-400" }
  if (ratio > 0.5) return { text: "text-amber-500", bar: "bg-amber-400" }
  return { text: "text-emerald-500", bar: "bg-emerald-400" }
}

const providerAccent: Record<Provider, { bar: string; soft: string }> = {
  claude: { bar: "bg-violet-400", soft: "from-violet-50/70 to-white" },
  codex: { bar: "bg-amber-400", soft: "from-amber-50/70 to-white" },
  gemini: { bar: "bg-sky-400", soft: "from-sky-50/70 to-white" },
}

export function AgentList({ agents, onConfigClick, onStopClick }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        <span>智能体 · 会话级</span>
        <span className="font-normal normal-case tracking-normal text-slate-400">
          ⚙ 配置 · <span className="text-amber-500">●</span> 已覆盖
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {agents.map((agent) => {
          const ratio = agent.fillRatio ?? null
          const hasRatio = ratio != null
          const tone = hasRatio ? fillRatioTone(ratio) : null
          const accent = providerAccent[agent.provider]
          return (
            <li
              key={agent.provider}
              className={`relative overflow-hidden rounded-[14px] border border-slate-200/80 bg-gradient-to-br ${accent.soft} px-3.5 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:shadow-[0_4px_14px_rgba(15,23,42,0.06)]`}
            >
              <span className={`absolute inset-y-3 left-0 w-[3px] rounded-r-full ${accent.bar}`} />
              <div className="grid grid-cols-[44px_1fr_auto] items-center gap-3">
                <ProviderAvatar identity={agent.provider} size="md" />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-[15px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">
                      {agent.alias}
                    </span>
                    <span
                      role="status"
                      data-state={agent.running ? "running" : "idle"}
                      aria-label={agent.running ? "运行中" : "空闲"}
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        agent.running ? "animate-pulse bg-amber-500" : "bg-slate-300"
                      }`}
                    />
                    <span className="shrink-0 text-[11px] text-slate-500">
                      {agent.running ? "运行中" : "空闲 · 待命"}
                    </span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center">
                    <span className="relative inline-flex shrink-0 items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 font-mono text-[10px] font-medium text-slate-500 ring-1 ring-slate-200/60">
                      {agent.model ?? "未设置"}
                      {agent.hasSessionOverride ? (
                        <span
                          data-testid="session-override-dot"
                          data-provider={agent.provider}
                          aria-label="存在会话专属覆盖"
                          className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 shadow-[0_0_0_2px_#fffbeb]"
                        />
                      ) : null}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {agent.running && onStopClick ? (
                    <button
                      type="button"
                      aria-label={`停止 ${agent.alias}`}
                      title="停止运行"
                      onClick={() => onStopClick(agent.provider)}
                      className="flex h-7 w-7 items-center justify-center rounded-[10px] bg-rose-50 text-rose-600 ring-1 ring-rose-200/70 transition hover:bg-rose-100 hover:text-rose-700"
                    >
                      <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`配置 ${agent.alias}`}
                    onClick={() => onConfigClick?.(agent.provider)}
                    className="flex h-7 w-7 items-center justify-center rounded-[10px] bg-white/80 text-slate-500 ring-1 ring-slate-200/60 transition hover:bg-white hover:text-slate-900"
                  >
                    <Settings className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2.5 pl-[56px]">
                <span className="text-[10px] uppercase tracking-[0.16em] text-slate-400">
                  上下文
                </span>
                {hasRatio && tone ? (
                  <>
                    <div className="h-1.5 flex-1 rounded-full bg-slate-200/60">
                      <div
                        className={`h-full rounded-full transition-all ${tone.bar}`}
                        style={{ width: `${Math.round(ratio * 100)}%` }}
                      />
                    </div>
                    <span className={`font-mono text-[11px] font-semibold tabular-nums ${tone.text}`}>
                      {Math.round(ratio * 100)}%
                    </span>
                  </>
                ) : (
                  <>
                    <div className="h-1.5 flex-1 rounded-full bg-slate-200/50" aria-hidden="true" />
                    <span className="text-[11px] font-medium text-slate-400">待运行</span>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
