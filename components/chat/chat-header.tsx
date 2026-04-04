"use client"

import { Menu, PawPrint } from "lucide-react"

export function ChatHeader() {
  return (
    <header className="flex items-center justify-between border-b border-slate-200/70 bg-white/70 px-6 py-4 backdrop-blur-xl">
      <div className="flex items-center gap-4">
        <button className="rounded-full p-2 transition hover:bg-slate-100" type="button">
          <Menu className="h-5 w-5 text-slate-500" />
        </button>

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-600 shadow-[0_10px_24px_rgba(245,158,11,0.18)]">
            <PawPrint className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-[0.01em] text-slate-900">Multi-Agent</h1>
            <p className="text-xs text-slate-400">多智能体协同工作空间</p>
          </div>
        </div>
      </div>
    </header>
  )
}
