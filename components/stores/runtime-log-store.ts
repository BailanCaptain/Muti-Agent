"use client"

import { create } from "zustand"

/**
 * F027 Phase 3 P20 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 容器 tab state
 *
 * V16.5 §18 line 1927-1954 真相源：
 *   - lvl1 tabs: system-prompt (enabled) + logs (disabled, futureTag)
 *   - lvl2 tabs: viewfinder / prompt-inspector / draft-approval / warnings / knowledge-base
 *   - 默认 lvl2 = "prompt-inspector"（feature.md line 178 AC-P3-2 拍板）
 *
 * 不 persist：tab 切换是 transient 操作，reload 后恢复默认。
 * Phase 3 Week 3-4 内容接入时各 tab 自己管 fetch state（不在本 store）。
 *
 * AC-P3-2 状态保持：切换 tab 各自 fetch 状态保留不重新 loading，scroll 位置
 * reload 误差 ≤ 10px — 真实接入 Week 4，骨架阶段保留 activeLvl1/Lvl2 即可。
 */

export type RuntimeLogLvl1Key = "system-prompt" | "logs"

export type RuntimeLogLvl2Key =
  | "viewfinder"
  | "prompt-inspector"
  | "draft-approval"
  | "warnings"
  | "knowledge-base"

export interface RuntimeLogLvl1Item {
  key: RuntimeLogLvl1Key
  label: string
  enabled: boolean
  /** "未来"标记 — V16.5 §18 line 1940 LVL1_ITEMS futureTag */
  futureTag?: boolean
}

export interface RuntimeLogLvl2Item {
  key: RuntimeLogLvl2Key
  label: string
}

/**
 * V16.5 §18 line 1938-1941 LVL1_ITEMS 真相源
 * 未来扩展：LVL1_ITEMS.push({ key: 'new', label: '新页面', enabled: true })
 *
 * label 改名 (2026-05-23 小孙浏览器实测拍 · v3.5 patch):
 *   - lvl1 "system prompt" → "记忆系统" (1 级容器 = 整个 LLM 接到的 context = 记忆系统总称)
 *   - key 保留 "system-prompt" (avoid schema break, 仅 UI label 改)
 */
export const RUNTIME_LOG_LVL1_ITEMS: ReadonlyArray<RuntimeLogLvl1Item> = [
  { key: "system-prompt", label: "记忆系统", enabled: true },
  { key: "logs", label: "日志", enabled: false, futureTag: true },
] as const

/**
 * V16.5 §18 line 1948-1954 二级 5 tab 真相源（label/component/API 见 plan）
 * 实施分批：Day 12-13 骨架 placeholder / Day 14-15 prompt-inspector + viewfinder /
 * Week 4 draft-approval + knowledge-base + warnings 真实数据接入
 *
 * label 改名 (2026-05-23 小孙浏览器实测拍 · v3.5 patch):
 *   - "检视" → "system prompt" (prompt-inspector 显示 LLM 实际接的 system prompt 内容,
 *     比抽象的 "检视" 更直观)
 *   - key 保留 "prompt-inspector" (avoid schema break, 仅 UI label 改)
 */
export const RUNTIME_LOG_LVL2_ITEMS: ReadonlyArray<RuntimeLogLvl2Item> = [
  { key: "viewfinder", label: "取景器" },
  { key: "prompt-inspector", label: "system prompt" }, // 默认 — v3.5 改 "检视" → "system prompt"
  { key: "draft-approval", label: "审批" },
  { key: "warnings", label: "警告" },
  { key: "knowledge-base", label: "知识库" },
] as const

type RuntimeLogStore = {
  activeLvl1: RuntimeLogLvl1Key
  activeLvl2: RuntimeLogLvl2Key
  collapsed: boolean
  setActiveLvl1: (key: RuntimeLogLvl1Key) => void
  setActiveLvl2: (key: RuntimeLogLvl2Key) => void
  toggleCollapsed: () => void
}

export const useRuntimeLogStore = create<RuntimeLogStore>((set) => ({
  activeLvl1: "system-prompt",
  activeLvl2: "prompt-inspector", // 默认 — AC-P3-2 拍板
  collapsed: false,
  setActiveLvl1: (key) => {
    const item = RUNTIME_LOG_LVL1_ITEMS.find((i) => i.key === key)
    if (!item || !item.enabled) return // disabled tab 切换无效（防 "日志(未来)" 误激活）
    set({ activeLvl1: key })
  },
  setActiveLvl2: (key) => set({ activeLvl2: key }),
  toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
}))
