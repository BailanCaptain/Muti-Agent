"use client"

import type { ApprovalRequest, ApprovalScope } from "@multi-agent/shared"
import { ShieldAlert, Check, X, ChevronDown, Shield, Globe, MessageSquare } from "lucide-react"
import { useState } from "react"
import { ProviderAvatar } from "./provider-avatar"

interface ApprovalCardProps {
  request: ApprovalRequest
  onRespond: (requestId: string, granted: boolean, scope: ApprovalScope) => void
}

const riskColors: Record<string, { border: string; bg: string; badge: string }> = {
  low: { border: "border-blue-200", bg: "from-blue-50 to-sky-50/60", badge: "bg-blue-100 text-blue-700" },
  medium: { border: "border-amber-200", bg: "from-amber-50 to-orange-50/60", badge: "bg-amber-100 text-amber-700" },
  high: { border: "border-red-200", bg: "from-red-50 to-rose-50/60", badge: "bg-red-100 text-red-700" },
}

export function ApprovalCard({ request, onRespond }: ApprovalCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [showContext, setShowContext] = useState(false)

  const risk = request.fingerprint?.risk ?? "medium"
  const colors = riskColors[risk] ?? riskColors.medium

  return (
    <div className={`approval-pulse mx-auto my-3 max-w-[980px] rounded-2xl border ${colors.border} bg-gradient-to-br ${colors.bg} p-4 shadow-[0_4px_16px_rgba(245,158,11,0.10)]`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <ProviderAvatar identity={request.provider} size="sm" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-sm text-slate-800">
              {request.agentAlias}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors.badge}`}>
              {request.action}
            </span>
            {request.fingerprint?.tool && request.fingerprint.tool !== request.action && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                {request.fingerprint.tool}
              </span>
            )}
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            <span className="text-xs text-slate-400">needs your confirmation</span>
          </div>

          <p className="text-sm text-slate-600 leading-relaxed">{request.reason}</p>

          {request.context && (
            <button
              type="button"
              className="mt-1.5 flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors"
              onClick={() => setShowContext(!showContext)}
            >
              <ChevronDown
                className={`h-3 w-3 transition-transform ${showContext ? "rotate-180" : ""}`}
              />
              {showContext ? "收起详情" : "查看详情"}
            </button>
          )}

          {showContext && request.context && (
            <pre className="mt-2 rounded-lg bg-slate-800 p-3 text-xs text-green-300 font-mono overflow-x-auto whitespace-pre-wrap max-h-40">
              {request.context}
            </pre>
          )}
        </div>
      </div>

      <div className="mt-3 ml-7">
        {!expanded ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-600 transition-colors"
              onClick={() => onRespond(request.requestId, true, "once")}
            >
              <Check className="h-3.5 w-3.5" />
              允许 (仅此次)
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-300 transition-colors"
              onClick={() => setExpanded(true)}
            >
              更多选项...
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-xs font-medium text-red-600 shadow-sm border border-red-200 hover:bg-red-50 transition-colors"
              onClick={() => onRespond(request.requestId, false, "once")}
            >
              <X className="h-3.5 w-3.5" />
              拒绝
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-600 transition-colors"
                onClick={() => onRespond(request.requestId, true, "once")}
              >
                <Shield className="h-3 w-3" />
                允许 (仅此次)
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-400 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-500 transition-colors"
                onClick={() => onRespond(request.requestId, true, "thread")}
              >
                <MessageSquare className="h-3 w-3" />
                允许 (此会话)
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-700 transition-colors"
                onClick={() => onRespond(request.requestId, true, "global")}
              >
                <Globe className="h-3 w-3" />
                允许 (全局)
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 hover:bg-red-50 transition-colors"
                onClick={() => onRespond(request.requestId, false, "once")}
              >
                <X className="h-3 w-3" />
                拒绝 (仅此次)
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-400 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-500 transition-colors"
                onClick={() => onRespond(request.requestId, false, "thread")}
              >
                <MessageSquare className="h-3 w-3" />
                拒绝 (此会话)
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-600 transition-colors"
                onClick={() => onRespond(request.requestId, false, "global")}
              >
                <Globe className="h-3 w-3" />
                拒绝 (全局)
              </button>
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                onClick={() => setExpanded(false)}
              >
                收起
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
