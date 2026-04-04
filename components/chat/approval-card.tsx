"use client"

import type { ApprovalRequest, ApprovalScope } from "@multi-agent/shared"
import { ShieldAlert, Check, X, ChevronDown } from "lucide-react"
import { useState } from "react"
import { ProviderAvatar } from "./provider-avatar"

interface ApprovalCardProps {
  request: ApprovalRequest
  onRespond: (requestId: string, granted: boolean, scope: ApprovalScope) => void
}

export function ApprovalCard({ request, onRespond }: ApprovalCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="mx-auto my-3 max-w-[980px] rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50/60 p-4 shadow-[0_4px_16px_rgba(245,158,11,0.10)]">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <ProviderAvatar provider={request.provider} size={32} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-sm text-slate-800">
              {request.agentAlias}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {request.action}
            </span>
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            <span className="text-xs text-slate-400">需要你的确认</span>
          </div>

          <p className="text-sm text-slate-600 leading-relaxed">{request.reason}</p>

          {request.context && (
            <button
              type="button"
              className="mt-1.5 flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors"
              onClick={() => setExpanded(!expanded)}
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
              {expanded ? "收起详情" : "查看详情"}
            </button>
          )}

          {expanded && request.context && (
            <pre className="mt-2 rounded-lg bg-slate-800 p-3 text-xs text-green-300 font-mono overflow-x-auto whitespace-pre-wrap max-h-40">
              {request.context}
            </pre>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-sm font-medium text-red-600 shadow-sm border border-red-200 hover:bg-red-50 transition-colors"
          onClick={() => onRespond(request.requestId, false, "once")}
        >
          <X className="h-3.5 w-3.5" />
          拒绝
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-600 transition-colors"
          onClick={() => onRespond(request.requestId, true, "once")}
        >
          <Check className="h-3.5 w-3.5" />
          允许
        </button>
      </div>
    </div>
  )
}
