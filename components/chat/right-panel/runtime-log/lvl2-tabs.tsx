"use client"

import {
  RUNTIME_LOG_LVL2_ITEMS,
  type RuntimeLogLvl2Key,
  useRuntimeLogStore,
} from "@/components/stores/runtime-log-store"
import { useCallback, useRef } from "react"

/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 二级 5 tabs
 * 真相源：V16.5 §18 line 1948-1954 + WAI-ARIA Authoring Practices "Tabs Pattern"
 *
 * r2 范-r1 P3-1 修：加 keyboard nav (ArrowLeft/Right/Home/End) + roving tabIndex
 *   - active tab tabIndex=0 (focusable)
 *   - 其他 tab tabIndex=-1 (Tab 键跳过单个 tab，进 tablist 后 ArrowLeft/Right 切)
 *   - ArrowLeft/Right 循环切 + 自动 focus 新 tab
 *   - Home / End 跳首/末 tab
 */
export function Lvl2Tabs() {
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)
  const setActiveLvl2 = useRuntimeLogStore((state) => state.setActiveLvl2)
  const tabRefs = useRef<Map<RuntimeLogLvl2Key, HTMLButtonElement | null>>(new Map())

  /** r2 P3-1: keyboard nav — ArrowLeft/Right 循环 + Home/End 跳极 */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const currentIndex = RUNTIME_LOG_LVL2_ITEMS.findIndex((i) => i.key === activeLvl2)
      let nextIndex = currentIndex
      switch (e.key) {
        case "ArrowLeft":
          nextIndex =
            (currentIndex - 1 + RUNTIME_LOG_LVL2_ITEMS.length) % RUNTIME_LOG_LVL2_ITEMS.length
          break
        case "ArrowRight":
          nextIndex = (currentIndex + 1) % RUNTIME_LOG_LVL2_ITEMS.length
          break
        case "Home":
          nextIndex = 0
          break
        case "End":
          nextIndex = RUNTIME_LOG_LVL2_ITEMS.length - 1
          break
        default:
          return
      }
      e.preventDefault()
      const nextKey = RUNTIME_LOG_LVL2_ITEMS[nextIndex].key
      setActiveLvl2(nextKey)
      // 自动 focus 新 active tab（roving tabIndex pattern）
      requestAnimationFrame(() => {
        tabRefs.current.get(nextKey)?.focus()
      })
    },
    [activeLvl2, setActiveLvl2],
  )

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
            ref={(el) => {
              tabRefs.current.set(item.key, el)
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            // r2 P3-1: roving tabIndex (active=0 / inactive=-1) — keyboard 进 tablist 后
            // 不会逐个 Tab 切 5 个，而是用 Arrow 键导航
            tabIndex={isActive ? 0 : -1}
            onClick={() => setActiveLvl2(item.key)}
            onKeyDown={handleKeyDown}
            className={`-mb-px rounded-t border border-transparent px-2 py-1 text-micro transition-colors focus:outline-none focus:ring-1 focus:ring-accent-400 ${
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
