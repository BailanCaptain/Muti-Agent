"use client"

import { RUNTIME_LOG_LVL1_ITEMS, useRuntimeLogStore } from "@/components/stores/runtime-log-store"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 一级 tabs
 * 真相源：V16.5 §18 line 1937-1944 LVL1_ITEMS
 *
 * 当前 LVL1_ITEMS:
 *   - "system prompt" (enabled)
 *   - "日志" (disabled, futureTag) — V16.5 §18 注释 "未来扩展"
 */
export function Lvl1Tabs() {
  const activeLvl1 = useRuntimeLogStore((state) => state.activeLvl1)
  const setActiveLvl1 = useRuntimeLogStore((state) => state.setActiveLvl1)

  return (
    <div
      className="flex gap-2 border-b border-slate-200/60 px-2 py-1.5"
      role="tablist"
      aria-label="RuntimeLog 一级 tabs"
      data-testid="runtime-log-lvl1-tabs"
    >
      {RUNTIME_LOG_LVL1_ITEMS.map((item) => {
        const isActive = item.key === activeLvl1
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={!item.enabled}
            disabled={!item.enabled}
            onClick={() => setActiveLvl1(item.key)}
            className={`rounded px-2 py-1 text-[11px] transition-colors ${
              isActive
                ? "bg-slate-800 text-white"
                : item.enabled
                  ? "text-slate-600 hover:bg-slate-100"
                  : "cursor-not-allowed text-slate-300"
            }`}
            data-testid={`runtime-log-lvl1-${item.key}`}
          >
            {item.label}
            {item.futureTag && <span className="ml-1 text-[9px] text-slate-400">· 未来</span>}
          </button>
        )
      })}
    </div>
  )
}
