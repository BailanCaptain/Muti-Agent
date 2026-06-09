"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * F027 Phase 3 P20 Week 3 Day 11 (AC-P3-1 · feature.md line 177):
 * StatusPanel 拖宽 360-1200px 范围 + localStorage persist + reload 误差 ≤ 1px
 *
 * 默认 360 而非 F021 旧值 340 — AC 下限对齐（拖窄到 < 360 会被 clamp 弹回）。
 * 升级后旧用户打开应用看到面板从 340 → 360（多 20px），合理可接受。
 *
 * MAX 从 720 → 1200 (plan v3.4 patch, 小孙 2026-05-23 浏览器实测拍): 大屏 720 不够,
 * Inspector 内容 (注入 part 表 / 召回 query 列表) 需要更宽视野; 1200 留余地.
 */
const STATUS_PANEL_MIN_WIDTH = 360
const STATUS_PANEL_MAX_WIDTH = 1200
const STATUS_PANEL_DEFAULT_WIDTH = 360

export function clampStatusPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return STATUS_PANEL_DEFAULT_WIDTH
  return Math.min(STATUS_PANEL_MAX_WIDTH, Math.max(STATUS_PANEL_MIN_WIDTH, Math.round(width)))
}

/**
 * F027 P3-1 扩展（小孙 2026-06-02 浏览器实测拍）：RuntimeLog（运行日志）竖直拖高。
 * 原 RuntimeLog 用 flex:1 吃剩余空间，被上方 5 段挤到很矮、字小看不清且无调节手段。
 * 加 top-edge 拖动 handle（往上拖加高）+ persist，与横向 statusPanelWidth 同套路。
 *
 * MAX 用静态上限（885）兜底；实际渲染时 status-panel 上方区 flex-1 min-h-0 可滚动，
 * 不会把 runtime-log 顶出屏幕（aside h-screen overflow-hidden）。
 */
const RUNTIME_LOG_MIN_HEIGHT = 140
const RUNTIME_LOG_MAX_HEIGHT = 885
const RUNTIME_LOG_DEFAULT_HEIGHT = 320

export function clampRuntimeLogHeight(height: number): number {
  if (!Number.isFinite(height)) return RUNTIME_LOG_DEFAULT_HEIGHT
  return Math.min(RUNTIME_LOG_MAX_HEIGHT, Math.max(RUNTIME_LOG_MIN_HEIGHT, Math.round(height)))
}

type LayoutStore = {
  sidebarCollapsed: boolean
  statusPanelCollapsed: boolean
  statusPanelWidth: number
  /** F027 P3-1 扩展：RuntimeLog 竖直拖高的当前高度（px），persist + reload 还原。 */
  runtimeLogHeight: number
  toggleSidebar: () => void
  toggleStatusPanel: () => void
  /**
   * 持久化 width setter — 调用立刻同步写 localStorage (zustand persist middleware)。
   *
   * r2 范-r1 P2-2 修：原 r1 mousemove 直接调此 setter，每帧同步 JSON.stringify +
   * localStorage.setItem，违反 ≥ 50fps AC。r2 ResizeHandle 改成 mousemove 期间
   * 用 React local state hold 拖动中 width（DOM 直接更新 style），mouseup 才调
   * 此 setter 一次性持久化。
   *
   * Keyboard 拖动 (ArrowLeft/Right/Home/End) 离散事件低频，直接调此 setter 安全。
   */
  setStatusPanelWidth: (width: number) => void
  /**
   * 持久化 RuntimeLog 高度 setter。与 width 同策略：拖动期间 ResizeHandleVertical
   * 直操 DOM style.height（避开高频 rerender + persist 写），mouseup 才调此 setter
   * 一次性 commit + persist。Keyboard 离散步进直接调此 setter 安全。
   */
  setRuntimeLogHeight: (height: number) => void
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      statusPanelCollapsed: false,
      statusPanelWidth: STATUS_PANEL_DEFAULT_WIDTH,
      runtimeLogHeight: RUNTIME_LOG_DEFAULT_HEIGHT,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleStatusPanel: () =>
        set((state) => ({ statusPanelCollapsed: !state.statusPanelCollapsed })),
      setStatusPanelWidth: (width) => set({ statusPanelWidth: clampStatusPanelWidth(width) }),
      setRuntimeLogHeight: (height) => set({ runtimeLogHeight: clampRuntimeLogHeight(height) }),
    }),
    {
      name: "multi-agent-layout-store",
      // 只 persist 真有用的（collapsed 状态 + width），其他 action 不 persist
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        statusPanelCollapsed: state.statusPanelCollapsed,
        statusPanelWidth: state.statusPanelWidth,
        runtimeLogHeight: state.runtimeLogHeight,
      }),
      // rehydrate 时 clamp 防 corrupt localStorage 值（如手动篡改成 99999）
      merge: (persistedState, currentState) => {
        const merged = { ...currentState, ...(persistedState as Partial<LayoutStore>) }
        return {
          ...merged,
          statusPanelWidth: clampStatusPanelWidth(merged.statusPanelWidth),
          runtimeLogHeight: clampRuntimeLogHeight(merged.runtimeLogHeight),
        }
      },
    },
  ),
)

export { STATUS_PANEL_MIN_WIDTH, STATUS_PANEL_MAX_WIDTH, STATUS_PANEL_DEFAULT_WIDTH }
export { RUNTIME_LOG_MIN_HEIGHT, RUNTIME_LOG_MAX_HEIGHT, RUNTIME_LOG_DEFAULT_HEIGHT }
