"use client"

import type { DecisionRequest } from "@multi-agent/shared"
import { Check, ListChecks, Pencil, Users, X } from "lucide-react"
import { useState } from "react"
import { ProviderAvatar } from "./provider-avatar"

type ItemState = {
  verdict: "approved" | "rejected" | "modified" | null
  modification: string
}

interface DecisionCardProps {
  request: DecisionRequest
  onRespond: (
    requestId: string,
    decisions: Array<{
      optionId: string
      verdict: "approved" | "rejected" | "modified"
      modification?: string
    }>,
    userInput?: string,
  ) => void
}

/* ─── Fan-in / multi-select card (original behaviour) ─── */
function FanInCard({ request, onRespond }: DecisionCardProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [text, setText] = useState("")
  const isMulti = request.multiSelect ?? false
  const allowText = request.allowTextInput ?? false

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

  const trimmedText = text.trim()
  const canSubmit = selected.size > 0 || (allowText && trimmedText.length > 0)

  return (
    <div className="mx-auto my-3 max-w-[980px] rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-sky-50/60 p-4 shadow-[0_4px_16px_rgba(59,130,246,0.10)]">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2.5">
        {request.sourceProvider && (
          <ProviderAvatar identity={request.sourceProvider} size="sm" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-semibold text-slate-800">
              {request.title}
            </span>
          </div>
          {request.description && (
            <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-slate-500">
              {request.description}
            </p>
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
                  ? "border border-blue-300 bg-blue-100/80 shadow-sm"
                  : "border border-slate-200/80 bg-white/70 hover:border-slate-300 hover:bg-white"
              }`}
              onClick={() => toggle(option.id)}
            >
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all ${
                  isSelected
                    ? "border-blue-500 bg-blue-500"
                    : "border-slate-300 bg-white"
                }`}
              >
                {isSelected && <Check className="h-3 w-3 text-white" />}
              </div>
              {option.provider && (
                <ProviderAvatar identity={option.provider} size="sm" />
              )}
              <div className="min-w-0 flex-1">
                <span
                  className={`text-sm font-medium ${isSelected ? "text-slate-800" : "text-slate-700"}`}
                >
                  {option.label}
                </span>
                {option.description && (
                  <p className="mt-0.5 text-xs text-slate-400">
                    {option.description}
                  </p>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Free-text input */}
      {allowText && (
        <div className="mt-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={request.textInputPlaceholder ?? "输入你的想法或指令…"}
            rows={2}
            className="w-full resize-y rounded-xl border border-blue-200/80 bg-white/80 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200/60"
          />
        </div>
      )}

      {/* Submit */}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!canSubmit}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium shadow-sm transition-colors ${
            canSubmit
              ? "bg-blue-500 text-white hover:bg-blue-600"
              : "cursor-not-allowed bg-slate-100 text-slate-400"
          }`}
          onClick={() => {
            if (canSubmit) {
              const decisions = [...selected].map((id) => ({
                optionId: id,
                verdict: "approved" as const,
              }))
              onRespond(request.requestId, decisions, trimmedText || undefined)
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

/* ─── Inline-confirmation card (per-item verdict) ─── */
function InlineConfirmationCard({ request, onRespond }: DecisionCardProps) {
  const [items, setItems] = useState<Map<string, ItemState>>(
    () =>
      new Map(
        request.options.map((o) => [o.id, { verdict: null, modification: "" }]),
      ),
  )
  const [userInput, setUserInput] = useState("")

  function setVerdict(
    optionId: string,
    verdict: "approved" | "rejected" | "modified",
  ) {
    setItems((prev) => {
      const next = new Map(prev)
      const current = next.get(optionId)!
      // Toggle off if clicking the same verdict
      if (current.verdict === verdict) {
        next.set(optionId, { ...current, verdict: null })
      } else {
        next.set(optionId, { ...current, verdict })
      }
      return next
    })
  }

  function setModification(optionId: string, text: string) {
    setItems((prev) => {
      const next = new Map(prev)
      const current = next.get(optionId)!
      next.set(optionId, { ...current, modification: text })
      return next
    })
  }

  const allDecided = [...items.values()].every((s) => s.verdict !== null)
  const trimmedUserInput = userInput.trim()

  function handleSubmit() {
    if (!allDecided) return
    const decisions = [...items.entries()].map(([optionId, state]) => ({
      optionId,
      verdict: state.verdict!,
      ...(state.verdict === "modified" && state.modification.trim()
        ? { modification: state.modification.trim() }
        : {}),
    }))
    onRespond(
      request.requestId,
      decisions,
      trimmedUserInput || undefined,
    )
  }

  return (
    <div className="mx-auto my-3 max-w-[980px] rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-purple-50/60 p-4 shadow-[0_4px_16px_rgba(139,92,246,0.10)]">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2.5">
        {request.sourceProvider && (
          <ProviderAvatar identity={request.sourceProvider} size="sm" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-violet-500" />
            <span className="text-sm font-semibold text-slate-800">
              {request.title}
            </span>
          </div>
          {request.description && (
            <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-slate-500">
              {request.description}
            </p>
          )}
        </div>
      </div>

      {/* Per-option verdict rows */}
      <div className="space-y-2">
        {request.options.map((option, idx) => {
          const state = items.get(option.id)!
          return (
            <div
              key={option.id}
              className="rounded-xl border border-violet-100/80 bg-white/70 px-3.5 py-2.5"
            >
              {/* Option label */}
              <div className="mb-1.5 text-sm font-medium text-slate-700">
                {idx + 1}. {option.label}
              </div>

              {/* Verdict buttons */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                    state.verdict === "approved"
                      ? "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-300"
                      : "bg-slate-50 text-slate-500 hover:bg-emerald-50 hover:text-emerald-600"
                  }`}
                  onClick={() => setVerdict(option.id, "approved")}
                >
                  <Check className="h-3 w-3" />
                  同意
                </button>
                <button
                  type="button"
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                    state.verdict === "rejected"
                      ? "bg-red-100 text-red-700 ring-1 ring-red-300"
                      : "bg-slate-50 text-slate-500 hover:bg-red-50 hover:text-red-600"
                  }`}
                  onClick={() => setVerdict(option.id, "rejected")}
                >
                  <X className="h-3 w-3" />
                  否决
                </button>
                <button
                  type="button"
                  className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                    state.verdict === "modified"
                      ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300"
                      : "bg-slate-50 text-slate-500 hover:bg-amber-50 hover:text-amber-600"
                  }`}
                  onClick={() => setVerdict(option.id, "modified")}
                >
                  <Pencil className="h-3 w-3" />
                  修改
                </button>
              </div>

              {/* Modification textarea */}
              {state.verdict === "modified" && (
                <textarea
                  value={state.modification}
                  onChange={(e) =>
                    setModification(option.id, e.target.value)
                  }
                  placeholder="输入修改内容…"
                  rows={2}
                  className="mt-2 w-full resize-y rounded-lg border border-amber-200/80 bg-white/80 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-200/60"
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Overall user input */}
      <div className="mt-3">
        <textarea
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder="补充说明（可选）…"
          rows={2}
          className="w-full resize-y rounded-xl border border-violet-200/80 bg-white/80 px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-violet-300 focus:outline-none focus:ring-2 focus:ring-violet-200/60"
        />
      </div>

      {/* Submit */}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!allDecided}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium shadow-sm transition-colors ${
            allDecided
              ? "bg-violet-500 text-white hover:bg-violet-600"
              : "cursor-not-allowed bg-slate-100 text-slate-400"
          }`}
          onClick={handleSubmit}
        >
          <Check className="h-3.5 w-3.5" />
          提交决策
        </button>
      </div>
    </div>
  )
}

/* ─── Public DecisionCard — routes by kind ─── */
export function DecisionCard({ request, onRespond }: DecisionCardProps) {
  if (request.kind === "fan_in_selector") {
    return <FanInCard request={request} onRespond={onRespond} />
  }
  return <InlineConfirmationCard request={request} onRespond={onRespond} />
}
