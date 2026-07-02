"use client"

import type { DecisionRecord, DecisionRequest } from "@multi-agent/shared"
import { Ban, Check, CircleAlert, Clock, ListChecks, Users } from "lucide-react"
import { useState } from "react"
import { ProviderAvatar } from "./provider-avatar"

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
    <div className="mx-auto my-3 max-w-[980px] rounded-2xl border border-accent-200 bg-accent-50 p-4 shadow-sm">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2.5">
        {request.sourceProvider && (
          <ProviderAvatar identity={request.sourceProvider} size="sm" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-accent-600" />
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
                  ? "border border-accent-300 bg-accent-100 shadow-sm"
                  : "border border-slate-200 bg-surface-canvas hover:border-slate-300 hover:bg-surface-elevated"
              }`}
              onClick={() => toggle(option.id)}
            >
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all ${
                  isSelected
                    ? "border-accent-500 bg-accent-500"
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
            className="w-full resize-y rounded-xl border border-accent-200 bg-surface-canvas px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-200"
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
              ? "bg-accent-500 text-white hover:bg-accent-600"
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

/* ─── Options card (multi_choice · select/multi_select) ─── */
// F033: 单选也走显式提交（clowder F096 B1 教训——点 radio 不直接回传）。
function OptionsCard({ request, onRespond }: DecisionCardProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [text, setText] = useState("")
  const hasOptions = request.options.length > 0
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

  const trimmedText = text.trim()
  const canSubmit = selected.size > 0 || trimmedText.length > 0

  return (
    <div className="mx-auto my-3 max-w-[980px] rounded-2xl border border-accent-200 bg-accent-50 p-4 shadow-sm">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2.5">
        {request.sourceProvider && (
          <ProviderAvatar identity={request.sourceProvider} size="sm" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-accent-600" />
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

      {/* Selectable options */}
      {hasOptions && (
        <div className="space-y-1.5">
          {request.options.map((option) => {
            const isSelected = selected.has(option.id)
            return (
              <button
                key={option.id}
                type="button"
                className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-all ${
                  isSelected
                    ? "border border-accent-300 bg-accent-100 shadow-sm"
                    : "border border-slate-200 bg-surface-canvas hover:border-slate-300 hover:bg-surface-elevated"
                }`}
                onClick={() => toggle(option.id)}
              >
                <div
                  className={`flex h-5 w-5 shrink-0 items-center justify-center border transition-all ${
                    isSelected
                      ? "border-accent-500 bg-accent-500"
                      : "border-slate-300 bg-white"
                  } ${isMulti ? "rounded-md" : "rounded-full"}`}
                >
                  {isSelected && <Check className="h-3 w-3 text-white" />}
                </div>
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
      )}

      {/* Free-text input (always visible) */}
      <div className={hasOptions ? "mt-3" : ""}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={request.textInputPlaceholder ?? "以上都不选？说说你的想法…"}
          rows={2}
          className="w-full resize-y rounded-xl border border-accent-200 bg-surface-canvas px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-200"
        />
      </div>

      {/* Submit */}
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!canSubmit}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium shadow-sm transition-colors ${
            canSubmit
              ? "bg-accent-500 text-white hover:bg-accent-600"
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
          提交
        </button>
      </div>
    </div>
  )
}

/* ─── Confirm card (inline_confirmation · F033 confirm kind) ─── */
// 点任一选项直接回传：所点 approved、其余 rejected（无二次提交——确认卡本身就是提交动作）。
// 超时语义在服务端 fail-closed（全 rejected），见 decision-manager.ts。
function ConfirmCard({ request, onRespond }: DecisionCardProps) {
  function decide(pickedId: string) {
    const decisions = request.options.map((o) => ({
      optionId: o.id,
      verdict: o.id === pickedId ? ("approved" as const) : ("rejected" as const),
    }))
    onRespond(request.requestId, decisions, undefined)
  }

  return (
    <div className="mx-auto my-3 max-w-[980px] rounded-2xl border border-accent-200 bg-accent-50 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2.5">
        {request.sourceProvider && (
          <ProviderAvatar identity={request.sourceProvider} size="sm" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CircleAlert className="h-4 w-4 text-accent-600" />
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

      <div className="flex justify-end gap-2">
        {request.options.map((option, idx) => {
          const isPrimary = idx === 0
          return (
            <button
              key={option.id}
              type="button"
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium shadow-sm transition-colors ${
                isPrimary
                  ? "bg-accent-500 text-white hover:bg-accent-600"
                  : "border border-slate-200 bg-surface-canvas text-slate-600 hover:border-slate-300 hover:bg-surface-elevated"
              }`}
              onClick={() => decide(option.id)}
            >
              {isPrimary && <Check className="h-3.5 w-3.5" />}
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ─── Record card (F033 · resolved/timeout/orphaned · disabled 留痕渲染) ─── */
const RECORD_STATUS_FOOT: Record<
  DecisionRecord["status"],
  { icon: typeof Check; text: string; tone: string }
> = {
  pending: { icon: Clock, text: "等待响应", tone: "text-slate-400" },
  resolved: { icon: Check, text: "已确认", tone: "text-accent-600" },
  timeout: { icon: Clock, text: "超时自动处理", tone: "text-amber-600" },
  orphaned: { icon: Ban, text: "已过期（服务器重启，未收到响应）", tone: "text-slate-400" },
}

export function DecisionRecordCard({ record }: { record: DecisionRecord }) {
  const verdictById = new Map(record.verdicts?.map((v) => [v.optionId, v.verdict]) ?? [])
  const foot = RECORD_STATUS_FOOT[record.status]
  const FootIcon = foot.icon

  return (
    <div className="mx-auto my-3 max-w-[980px] rounded-2xl border border-slate-200 bg-surface-canvas p-4 opacity-90">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2.5">
        {record.sourceProvider && (
          <ProviderAvatar identity={record.sourceProvider} size="sm" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-slate-400" />
            <span className="text-sm font-semibold text-slate-600">{record.title}</span>
          </div>
          {record.description && (
            <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-slate-400">
              {record.description}
            </p>
          )}
        </div>
      </div>

      {/* Options (read-only, approved highlighted) */}
      <div className="space-y-1.5">
        {record.options.map((option) => {
          const verdict = verdictById.get(option.id)
          const approved = verdict === "approved"
          return (
            <div
              key={option.id}
              data-testid={`record-option-${option.id}`}
              data-verdict={verdict ?? "none"}
              className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 ${
                approved
                  ? "border-accent-300 bg-accent-50"
                  : "border-slate-100 bg-surface-canvas opacity-60"
              }`}
            >
              <div
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  approved ? "border-accent-500 bg-accent-500" : "border-slate-200 bg-white"
                }`}
              >
                {approved && <Check className="h-3 w-3 text-white" />}
              </div>
              <div className="min-w-0 flex-1">
                <span
                  className={`text-sm font-medium ${approved ? "text-slate-700" : "text-slate-400"}`}
                >
                  {option.label}
                </span>
                {option.description && (
                  <p className="mt-0.5 text-xs text-slate-300">{option.description}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 补充说明 */}
      {record.userInput && (
        <p className="mt-3 rounded-xl border border-slate-100 bg-surface-elevated px-3 py-2 text-xs leading-relaxed text-slate-500">
          补充说明：{record.userInput}
        </p>
      )}

      {/* Status footer */}
      <div className={`mt-3 flex items-center justify-end gap-1.5 text-xs ${foot.tone}`}>
        <FootIcon className="h-3.5 w-3.5" />
        <span>{foot.text}</span>
        {record.resolvedAt && record.status !== "orphaned" && (
          <span className="text-slate-300">
            · {new Date(record.resolvedAt).toLocaleString("zh-CN", { hour12: false })}
          </span>
        )}
      </div>
    </div>
  )
}

/* ─── Public DecisionCard — routes by kind ─── */
export function DecisionCard({ request, onRespond }: DecisionCardProps) {
  if (request.kind === "fan_in_selector") {
    return <FanInCard request={request} onRespond={onRespond} />
  }
  if (request.kind === "inline_confirmation") {
    return <ConfirmCard request={request} onRespond={onRespond} />
  }
  return <OptionsCard request={request} onRespond={onRespond} />
}
