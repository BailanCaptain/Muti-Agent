"use client"

import { RUNTIME_LOG_LVL2_ITEMS, useRuntimeLogStore } from "@/components/stores/runtime-log-store"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 二级 5 tabs
 * 真相源：V16.5 §18 line 1948-1954 二级 5 tab 表
 *
 * tabs: 取景器 / 检视 (默认) / 审批 / 警告 / 知识库
 */
export function Lvl2Tabs() {
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)
  const setActiveLvl2 = useRuntimeLogStore((state) => state.setActiveLvl2)

  return (
    <div
      className="flex gap-0 border-b border-slate-200/60 px-2 pt-1.5"
      role="tablist"
      aria-label="RuntimeLog 二级 tabs"
      data-testid="runtime-log-lvl2-tabs"
    >
      {RUNTIME_LOG_LVL2_ITEMS.map((item) => {
        const isActive = item.key === activeLvl2
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => setActiveLvl2(item.key)}
            className={`-mb-px rounded-t border border-transparent px-2 py-1 text-[10px] transition-colors ${
              isActive
                ? "border-slate-200 border-b-white bg-white font-semibold text-slate-800"
                : "text-slate-500 hover:bg-slate-100/60"
            }`}
            data-testid={`runtime-log-lvl2-${item.key}`}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
