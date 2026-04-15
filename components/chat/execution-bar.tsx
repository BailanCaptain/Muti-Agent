"use client"

import { PROVIDERS, PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { ProviderAvatar } from "./provider-avatar"
import { useThreadStore } from "../stores/thread-store"

function FillBar({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100)
  const color = ratio > 0.7 ? "bg-red-400" : ratio > 0.5 ? "bg-amber-400" : "bg-emerald-400"
  return (
    <div className="relative h-1.5 w-10 rounded-full bg-slate-200" title={`上下文使用 ${pct}%`}>
      <div className={`absolute inset-y-0 left-0 rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function SOPBreadcrumb({ skill, phase, next }: { skill: string; phase?: string | null; next?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-indigo-600 bg-indigo-50 rounded px-1.5 py-0.5">
      <span className="font-semibold">{skill.toUpperCase()}</span>
      {phase && <><span className="text-indigo-300">&gt;</span><span>{phase}</span></>}
      {next && <><span className="text-indigo-300">&gt;</span><span className="text-indigo-400 truncate max-w-[100px]">{next}</span></>}
    </span>
  )
}

export function ExecutionBar() {
  const providers = useThreadStore((s) => s.providers)

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-t border-slate-200/60 bg-slate-50/50">
      {PROVIDERS.map((provider: Provider) => {
        const card = providers[provider]
        const isRunning = card?.running ?? false

        return (
          <div key={provider} className="flex items-center gap-1.5 text-xs text-slate-500">
            <ProviderAvatar identity={provider} size="xs" />
            <span
              className={`h-2 w-2 rounded-full ${
                isRunning
                  ? "bg-emerald-500 animate-pulse"
                  : "bg-slate-300"
              }`}
            />
            <span>
              {PROVIDER_ALIASES[provider]}
            </span>
            {card?.fillRatio != null && card.fillRatio > 0 && (
              <FillBar ratio={card.fillRatio} />
            )}
            {card?.sopSkill && (
              <SOPBreadcrumb skill={card.sopSkill} phase={card.sopPhase} next={card.sopNext} />
            )}
          </div>
        )
      })}
    </div>
  )
}
