"use client"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { ChevronsDown, ChevronsUp } from "lucide-react"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 容器 header
 * 真相源：V16.5 §18 line 1929-1930 RuntimeLogHeader (整体折叠按钮)
 */
export function RuntimeLogHeader() {
  const collapsed = useRuntimeLogStore((state) => state.collapsed)
  const toggleCollapsed = useRuntimeLogStore((state) => state.toggleCollapsed)

  return (
    <div
      className="flex items-center justify-between border-t border-slate-200/60 px-3 py-1.5"
      data-testid="runtime-log-header"
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-500">★ 运行日志</div>
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={collapsed ? "展开运行日志" : "折叠运行日志"}
        aria-expanded={!collapsed}
        className="rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
        data-testid="runtime-log-toggle-collapse"
      >
        {collapsed ? <ChevronsDown className="h-3 w-3" /> : <ChevronsUp className="h-3 w-3" />}
      </button>
    </div>
  )
}
