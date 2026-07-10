"use client"

import { PawPrint } from "lucide-react"
import type { ReactNode } from "react"

export function ChatHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-surface-elevated px-3 py-3 md:px-6 md:py-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 animate-breathe items-center justify-center rounded-2xl bg-accent-100 text-accent-600">
            <PawPrint className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-[0.01em] text-slate-900">Multi-Agent</h1>
            <p className="text-xs text-slate-400">多智能体协同工作空间</p>
          </div>
        </div>
      </div>
      {children && <div className="flex items-center gap-1">{children}</div>}
    </header>
  )
}
