"use client"

import { AlertTriangle } from "lucide-react"
import { useEffect } from "react"

type ConfirmDialogProps = {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel()
      if (e.key === "Enter") void onConfirm()
    }
    document.addEventListener("keydown", handleKey)
    return () => document.removeEventListener("keydown", handleKey)
  }, [open, onConfirm, onCancel])

  if (!open) return null

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-stone-900/25 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
    >
      <div
        className="mx-4 w-full max-w-sm rounded-xl border border-amber-200/40 bg-[#fcf9f4] p-5 shadow-xl ring-1 ring-black/5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
              danger ? "bg-rose-100 text-rose-600" : "bg-amber-100 text-amber-600"
            }`}
          >
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
            {description && (
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{description}</p>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            onClick={onCancel}
            type="button"
          >
            {cancelLabel}
          </button>
          <button
            className={`rounded-md px-3 py-1.5 text-xs font-medium text-white transition ${
              danger
                ? "bg-rose-500 hover:bg-rose-600"
                : "bg-amber-500 hover:bg-amber-600"
            }`}
            onClick={() => void onConfirm()}
            type="button"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
