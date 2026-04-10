"use client"

import {
  type BoardChoice,
  useDecisionBoardStore,
} from "@/components/stores/decision-board-store"
import type { DecisionBoardItem } from "@multi-agent/shared"
import { Scale, X } from "lucide-react"
import { useCallback, useState } from "react"
import { ProviderAvatar } from "./provider-avatar"

/**
 * F002: "Product Decision Moment" modal. Rendered when a
 * `decision.board_flush` event arrives after the A2A discussion has
 * settled. Deliberately solemn (deep navy + gold accent) so the user
 * perceives this as a ritual decision rather than a casual popup.
 *
 * UX rules:
 * - Backdrop click is a no-op (this is not dismissible noise; user must
 *   choose or explicitly opt to skip).
 * - ✕ and "暂不回答" both submit a `skipped` payload, which writes a
 *   "产品暂未就以下问题作出决定" message to the chain-starter thread and
 *   still triggers one dispatch so agents can proceed.
 * - "提交决策" defaults unchosen items to the first option (the plan
 *   explicitly chose this over a "must choose all" gate so the user never
 *   feels bullied — AC9/AC10).
 */
export function DecisionBoardModal() {
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

  const submit = useCallback(
    async (skipped: boolean) => {
      if (!sessionGroupId || submitting) return
      setSubmitting(true)
      setSubmitError(null)

      const decisions = skipped
        ? []
        : items.map((item) => {
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
    [choices, close, items, sessionGroupId, submitting],
  )

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="relative mx-4 w-full max-w-[760px] overflow-hidden rounded-lg border border-amber-500/40 bg-[#0E1A2E] text-[#F5F5F0] shadow-[0_0_32px_rgba(201,168,118,0.25),0_24px_64px_rgba(0,0,0,0.55)]"
        style={{ animation: "decisionBoardSlideUp 220ms cubic-bezier(0.2, 0.8, 0.2, 1)" }}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-6 border-b border-amber-500/20 px-10 py-7">
          <div>
            <h2 className="flex items-center gap-3 text-2xl font-semibold tracking-wide text-amber-300/90">
              <Scale className="h-6 w-6" />
              产品决策时刻
            </h2>
            <p className="mt-2 text-sm text-slate-300/70">
              团队讨论已收敛，以下 {items.length} 个问题需要你拍板
            </p>
          </div>
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={submitting}
            aria-label="暂不回答"
            className="rounded-md border border-slate-500/30 p-2 text-slate-400 transition hover:border-amber-400/60 hover:text-amber-200 disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Cards */}
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-10 py-6">
          {items.map((item, idx) => (
            <DecisionCard key={item.id} index={idx + 1} item={item} />
          ))}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-end gap-3 border-t border-amber-500/20 px-10 py-5">
          {submitError && (
            <p className="mr-auto text-sm text-rose-300/90">提交失败：{submitError}</p>
          )}
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={submitting}
            className="rounded border border-slate-500/40 px-5 py-2.5 text-sm text-slate-300 transition hover:border-slate-400 hover:text-slate-100 disabled:opacity-40"
          >
            暂不回答
          </button>
          <button
            type="button"
            onClick={() => submit(false)}
            disabled={submitting || items.length === 0}
            className="rounded bg-amber-400/90 px-7 py-2.5 text-sm font-semibold text-[#0E1A2E] shadow-[0_0_16px_rgba(201,168,118,0.35)] transition hover:bg-amber-300 disabled:opacity-40"
          >
            {submitting ? "提交中…" : "提交决策 →"}
          </button>
        </footer>
      </div>

      <style jsx global>{`
        @keyframes decisionBoardSlideUp {
          from { opacity: 0; transform: translateY(24px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

function DecisionCard({ index, item }: { index: number; item: DecisionBoardItem }) {
  const { choices, customModes, setOptionChoice, setCustomMode, setCustomText } =
    useDecisionBoardStore()
  const choice = choices[item.id]
  const customMode = customModes[item.id] ?? false

  return (
    <div className="rounded-md border border-amber-500/25 bg-white/[0.02] p-6">
      <div className="mb-1 font-serif text-3xl font-semibold text-amber-300/90">
        {String(index).padStart(2, "0")}
      </div>
      <h3 className="mb-4 whitespace-pre-line text-lg leading-snug text-[#F5F5F0]">
        {item.question}
      </h3>

      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span className="text-slate-500">提出者</span>
        {item.raisers.map((r) => (
          <span
            key={`${r.provider}-${r.alias}`}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-slate-200"
          >
            <ProviderAvatar identity={r.provider} size="xs" />
            {r.alias}
          </span>
        ))}
      </div>

      <div className="space-y-2">
        {item.options.map((opt) => {
          const checked = !customMode && choice?.kind === "option" && choice.optionId === opt.id
          return (
            <label
              key={opt.id}
              className={`flex cursor-pointer items-center gap-3 rounded px-4 py-2.5 text-sm transition ${
                checked
                  ? "bg-amber-500/10 text-white ring-1 ring-amber-400/50"
                  : "text-slate-300 hover:bg-white/[0.04] hover:text-white"
              }`}
            >
              <input
                type="radio"
                name={`opt-${item.id}`}
                checked={checked}
                onChange={() => setOptionChoice(item.id, opt.id)}
                className="h-4 w-4 accent-amber-400"
              />
              {opt.label}
            </label>
          )
        })}

        <label
          className={`flex cursor-pointer items-center gap-3 rounded px-4 py-2.5 text-sm transition ${
            customMode
              ? "bg-amber-500/10 text-white ring-1 ring-amber-400/50"
              : "text-slate-300 hover:bg-white/[0.04] hover:text-white"
          }`}
        >
          <input
            type="radio"
            name={`opt-${item.id}`}
            checked={customMode}
            onChange={() => setCustomMode(item.id, true)}
            className="h-4 w-4 accent-amber-400"
          />
          其他（你来写）
        </label>

        {customMode && (
          <textarea
            autoFocus
            value={choice?.kind === "custom" ? choice.text : ""}
            onChange={(e) => setCustomText(item.id, e.target.value)}
            placeholder="输入你的决定……"
            className="mt-2 w-full resize-y rounded border border-amber-500/30 bg-[#1A2B42] px-3 py-2 text-sm text-[#F5F5F0] outline-none placeholder:text-slate-500 focus:border-amber-400/70"
            rows={3}
          />
        )}
      </div>
    </div>
  )
}
