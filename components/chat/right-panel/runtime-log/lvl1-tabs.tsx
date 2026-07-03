"use client"

import {
  RUNTIME_LOG_LVL1_ITEMS,
  type RuntimeLogLvl1Key,
  useRuntimeLogStore,
} from "@/components/stores/runtime-log-store"
import { useCallback, useRef } from "react"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 一级 tabs
 * 真相源：V16.5 §18 line 1937-1944 LVL1_ITEMS + WAI-ARIA Tabs Pattern
 *
 * 当前 LVL1_ITEMS:
 *   - "system prompt" (enabled)
 *   - "日志" (disabled, futureTag) — V16.5 §18 注释 "未来扩展"
 *
 * r2 范-r1 P3-1 修：roving tabIndex + ArrowLeft/Right 切 enabled tabs（skip
 * disabled）+ Home/End 跳首/末 enabled
 */
export function Lvl1Tabs() {
  const activeLvl1 = useRuntimeLogStore((state) => state.activeLvl1)
  const setActiveLvl1 = useRuntimeLogStore((state) => state.setActiveLvl1)
  const tabRefs = useRef<Map<RuntimeLogLvl1Key, HTMLButtonElement | null>>(new Map())

  /** 只在 enabled tabs 内导航（skip disabled "日志/未来"） */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const enabledItems = RUNTIME_LOG_LVL1_ITEMS.filter((i) => i.enabled)
      if (enabledItems.length === 0) return
      const currentIndex = enabledItems.findIndex((i) => i.key === activeLvl1)
      let nextIndex = currentIndex
      switch (e.key) {
        case "ArrowLeft":
          nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length
          break
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % enabledItems.length
          break
        case "Home":
          nextIndex = 0
          break
        case "End":
          nextIndex = enabledItems.length - 1
          break
        default:
          return
      }
      e.preventDefault()
      const nextKey = enabledItems[nextIndex].key
      setActiveLvl1(nextKey)
      requestAnimationFrame(() => {
        tabRefs.current.get(nextKey)?.focus()
      })
    },
    [activeLvl1, setActiveLvl1],
  )

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
            ref={(el) => {
              tabRefs.current.set(item.key, el)
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={!item.enabled}
            disabled={!item.enabled}
            // r2 P3-1: roving tabIndex - 只 active enabled tab focusable
            tabIndex={isActive && item.enabled ? 0 : -1}
            onClick={() => setActiveLvl1(item.key)}
            onKeyDown={handleKeyDown}
            className={`rounded px-2 py-1 text-caption transition-colors focus:outline-none focus:ring-1 focus:ring-accent-400 ${
              isActive
                ? "bg-slate-800 text-white"
                : item.enabled
                  ? "text-slate-600 hover:bg-slate-100"
                  : "cursor-not-allowed text-slate-300"
            }`}
            data-testid={`runtime-log-lvl1-${item.key}`}
          >
            {item.label}
            {item.futureTag && <span className="ml-1 text-micro text-slate-400">· 未来</span>}
          </button>
        )
      })}
    </div>
  )
}
