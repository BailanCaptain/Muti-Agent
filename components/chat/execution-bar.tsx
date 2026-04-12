"use client"

import { PROVIDERS, PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import { ShieldAlert } from "lucide-react"
import { ProviderAvatar } from "./provider-avatar"
import { useApprovalStore } from "../stores/approval-store"
import { useThreadStore } from "../stores/thread-store"

export function ExecutionBar() {
  const providers = useThreadStore((s) => s.providers)
  const pendingCount = useApprovalStore((s) => s.pending.length)

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-t border-slate-200/60 bg-slate-50/50">
      {PROVIDERS.map((provider: Provider) => {
        const card = providers[provider]
        const isRunning = card?.running ?? false
        const isWaiting = useApprovalStore.getState().pending.some(
          (r) => r.provider === provider,
        )

        return (
          <div key={provider} className="flex items-center gap-1.5 text-xs text-slate-500">
            <ProviderAvatar identity={provider} size="xs" />
            <span
              className={`h-2 w-2 rounded-full ${
                isWaiting
                  ? "bg-amber-400 animate-pulse"
                  : isRunning
                    ? "bg-emerald-500 animate-pulse"
                    : "bg-slate-300"
              }`}
            />
            <span className={isWaiting ? "text-amber-600 font-medium" : ""}>
              {PROVIDER_ALIASES[provider]}
            </span>
          </div>
        )
      })}

      {pendingCount > 0 && (
        <div className="ml-auto flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700">
          <ShieldAlert className="h-3.5 w-3.5" />
          {pendingCount} 待审批
        </div>
      )}
    </div>
  )
}
