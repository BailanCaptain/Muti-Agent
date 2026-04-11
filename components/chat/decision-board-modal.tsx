"use client"

import {
  type BoardChoice,
  useDecisionBoardStore,
} from "@/components/stores/decision-board-store"
import type { DecisionBoardItem } from "@multi-agent/shared"
import { AlertTriangle, Check, CheckCircle2, Scale } from "lucide-react"
import { useCallback, useState } from "react"
import { ProviderAvatar } from "./provider-avatar"

/**
 * B007: Inline decision board — replaces the old full-screen modal.
 * Renders as a card embedded in the timeline, separating converged
 * observations (informational) from unresolved divergence points
 * (actionable). Styled to be distinct but not overwhelming.
 */
export function InlineDecisionBoard() {
  const {
    isOpen,
    sessionGroupId,
    items,
    choices,
    customModes,
    close,
  } = useDecisionBoardStore()
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const convergedItems = items.filter((i) => i.converged)
  const divergentItems = items.filter((i) => !i.converged)

  const submit = useCallback(
    async (skipped: boolean) => {
      if (!sessionGroupId || submitting) return
      setSubmitting(true)
      setSubmitError(null)

      const decisions = skipped
        ? []
        : divergentItems.map((item) => {
            const picked = choices[item.id]
            const fallback: BoardChoice | null = item.options[0]
              ? { kind: "option", optionId: item.options[0].id }
              : null
            const choice: BoardChoice = picked ?? fallback ?? { kind: "custom", text: "" }
            return { itemId: item.id, choice }
          })

      try {
        const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787"
        const res = await fetch(`${apiBase}/decision-board/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionGroupId, decisions, skipped }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`)
        }
        close()
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err))
      } finally {
        setSubmitting(false)
      }
    },
    [choices, close, divergentItems, sessionGroupId, submitting],
  )

  if (!isOpen || items.length === 0) return null

  return (
    <div
      className="mx-auto my-4 w-full max-w-[980px] overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 shadow-[0_4px_24px_rgba(15,23,42,0.08)]"
      style={{ animation: "decisionBoardSlideUp 220ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
    >
      {/* Header */}
      <header className="border-b border-slate-100 px-6 py-4">
        <div className="flex items-center gap-2.5">
          <Scale className="h-5 w-5 text-slate-500" />
          <h3 className="text-base font-semibold text-slate-800">
            讨论结果
          </h3>
        </div>
        {divergentItems.length > 0 && (
          <p className="mt-1 text-xs text-slate-400">
            团队讨论已结束，以下 {divergentItems.length} 个分歧点需要你决定
          </p>
        )}
      </header>

      <div className="max-h-[50vh] overflow-y-auto px-6 py-4">
        {/* Converged section */}
        {convergedItems.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-emerald-600">
              <CheckCircle2 className="h-4 w-4" />
              团队已收敛（{convergedItems.length}）
            </div>
            <div className="space-y-2">
              {convergedItems.map((item) => (
                <ConvergedItemCard key={item.id} item={item} />
              ))}
            </div>
          </div>
        )}

        {/* Divergent section */}
        {divergentItems.length > 0 && (
          <div>
            {convergedItems.length > 0 && (
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-600">
                <AlertTriangle className="h-4 w-4" />
                未收敛分歧点（{divergentItems.length}）
              </div>
            )}
            <div className="space-y-3">
              {divergentItems.map((item) => (
                <DivergentItemCard key={item.id} item={item} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer — only show actions when there are divergent items */}
      {divergentItems.length > 0 && (
        <footer className="flex items-center justify-end gap-2.5 border-t border-slate-100 px-6 py-3">
          {submitError && (
            <p className="mr-auto text-xs text-rose-500">提交失败：{submitError}</p>
          )}
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={submitting}
            className="rounded-lg border border-slate-200 px-4 py-1.5 text-xs text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:opacity-40"
          >
            暂不回答
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={submitting}
            className="rounded-lg bg-blue-500 px-5 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-blue-600 disabled:opacity-40"
          >
            {submitting ? "提交中…" : "提交决定"}
          </button>
        </footer>
      )}

      {/* Converged-only: auto-close button */}
      {divergentItems.length === 0 && (
        <footer className="flex items-center justify-end border-t border-slate-100 px-6 py-3">
          <button
            type="button"
            onClick={() => close()}
            className="rounded-lg bg-emerald-500 px-5 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-600"
          >
            <Check className="mr-1 inline h-3.5 w-3.5" />
            知道了
          </button>
        </footer>
      )}

      <style jsx global>{`
        @keyframes decisionBoardSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

/** Read-only card for a converged item */
function ConvergedItemCard({ item }: { item: DecisionBoardItem }) {
  return (
    <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 px-4 py-2.5">
      <p className="text-sm text-slate-700">{item.question}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
        {item.raisers.map((r) => (
          <span
            key={`${r.provider}-${r.alias}`}
            className="inline-flex items-center gap-1 rounded-full bg-emerald-100/60 px-2 py-0.5 text-emerald-700"
          >
            <ProviderAvatar identity={r.provider} size="xs" />
            {r.alias}
          </span>
        ))}
      </div>
    </div>
  )
}

/** Actionable card for a divergent item — user picks an option */
function DivergentItemCard({ item }: { item: DecisionBoardItem }) {
  const { choices, customModes, setOptionChoice, setCustomMode, setCustomText } =
    useDecisionBoardStore()
  const choice = choices[item.id]
  const customMode = customModes[item.id] ?? false

  return (
    <div className="rounded-lg border border-amber-200/60 bg-amber-50/30 p-4">
      <h4 className="mb-2 text-sm font-medium text-slate-800">{item.question}</h4>

      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
        <span className="text-slate-500">提出者</span>
        {item.raisers.map((r) => (
          <span
            key={`${r.provider}-${r.alias}`}
            className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-slate-600"
          >
            <ProviderAvatar identity={r.provider} size="xs" />
            {r.alias}
          </span>
        ))}
      </div>

      <div className="space-y-1.5">
        {item.options.map((opt) => {
          const checked = !customMode && choice?.kind === "option" && choice.optionId === opt.id
          return (
            <label
              key={opt.id}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                checked
                  ? "bg-blue-50 text-blue-800 ring-1 ring-blue-300"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <input
                type="radio"
                name={`opt-${item.id}`}
                checked={checked}
                onChange={() => setOptionChoice(item.id, opt.id)}
                className="h-3.5 w-3.5 accent-blue-500"
              />
              {opt.label}
            </label>
          )
        })}

        <label
          className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
            customMode
              ? "bg-blue-50 text-blue-800 ring-1 ring-blue-300"
              : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          <input
            type="radio"
            name={`opt-${item.id}`}
            checked={customMode}
            onChange={() => setCustomMode(item.id, true)}
            className="h-3.5 w-3.5 accent-blue-500"
          />
          其他（你来写）
        </label>

        {customMode && (
          <textarea
            autoFocus
            value={choice?.kind === "custom" ? choice.text : ""}
            onChange={(e) => setCustomText(item.id, e.target.value)}
            placeholder="输入你的决定……"
            className="mt-1.5 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
            rows={2}
          />
        )}
      </div>
    </div>
  )
}

/** @deprecated Use InlineDecisionBoard. Kept for backward compat during transition. */
export function DecisionBoardModal() {
  return <InlineDecisionBoard />
}
