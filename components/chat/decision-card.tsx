"use client"

import type { DecisionRequest } from "@multi-agent/shared"
import { Check, GitBranch, ListChecks, Users } from "lucide-react"
import { useState } from "react"
import { ProviderAvatar } from "./provider-avatar"

interface DecisionCardProps {
  request: DecisionRequest
  onRespond: (requestId: string, selectedIds: string[]) => void
}

export function DecisionCard({ request, onRespond }: DecisionCardProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const isFanIn = request.kind === "fan_in_selector"
  const isMulti = request.multiSelect ?? false

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (isMulti) {
        next.has(id) ? next.delete(id) : next.add(id)
      } else {
        next.clear()
        if (!prev.has(id)) next.add(id)
      }
      return next
    })
  }

  const borderColor = isFanIn ? "border-blue-200" : "border-violet-200"
  const bgGradient = isFanIn
    ? "from-blue-50 to-sky-50/60"
    : "from-violet-50 to-purple-50/60"
  const shadowColor = isFanIn
    ? "rgba(59,130,246,0.10)"
    : "rgba(139,92,246,0.10)"
  const Icon = isFanIn ? Users : ListChecks

  return (
    <div
      className={`mx-auto my-3 max-w-[980px] rounded-2xl border ${borderColor} bg-gradient-to-br ${bgGradient} p-4 shadow-[0_4px_16px_${shadowColor}]`}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 mb-3">
        {request.sourceProvider && (
          <ProviderAvatar identity={request.sourceProvider} size="sm" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${isFanIn ? "text-blue-500" : "text-violet-500"}`} />
            <span className="font-semibold text-sm text-slate-800">{request.title}</span>
          </div>
          {request.description && (
            <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">{request.description}</p>
          )}
        </div>
      </div>

      {/* Options */}
      <div className="space-y-1.5">
        {request.options.map((option) => {
          const isSelected = selected.has(option.id)
          return (
            <button
              key={option.id}
              type="button"
              className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-all ${
                isSelected
                  ? isFanIn
                    ? "bg-blue-100/80 border border-blue-300 shadow-sm"
                    : "bg-violet-100/80 border border-violet-300 shadow-sm"
                  : "bg-white/70 border border-slate-200/80 hover:bg-white hover:border-slate-300"
              }`}
              onClick={() => toggle(option.id)}
            >
              {/* Selection indicator */}
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all ${
                  isSelected
                    ? isFanIn
                      ? "border-blue-500 bg-blue-500"
                      : "border-violet-500 bg-violet-500"
                    : "border-slate-300 bg-white"
                }`}
              >
                {isSelected && <Check className="h-3 w-3 text-white" />}
              </div>

              {/* Avatar for fan-in options */}
              {option.provider && (
                <ProviderAvatar identity={option.provider} size="sm" />
              )}

              {/* Label */}
              <div className="flex-1 min-w-0">
                <span className={`text-sm font-medium ${isSelected ? "text-slate-800" : "text-slate-700"}`}>
                  {option.label}
                </span>
                {option.description && (
                  <p className="text-xs text-slate-400 mt-0.5">{option.description}</p>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Submit */}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={selected.size === 0}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium shadow-sm transition-colors ${
            selected.size > 0
              ? isFanIn
                ? "bg-blue-500 text-white hover:bg-blue-600"
                : "bg-violet-500 text-white hover:bg-violet-600"
              : "bg-slate-100 text-slate-400 cursor-not-allowed"
          }`}
          onClick={() => {
            if (selected.size > 0) {
              onRespond(request.requestId, [...selected])
            }
          }}
        >
          <Check className="h-3.5 w-3.5" />
          确认
        </button>
      </div>
    </div>
  )
}
