"use client"

import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * F027 Phase 3 P20 Week 3 Day 11 (AC-P3-1 · feature.md line 177):
 * StatusPanel 拖宽 360-720px 范围 + localStorage persist + reload 误差 ≤ 1px
 *
 * 默认 360 而非 F021 旧值 340 — AC 下限对齐（拖窄到 < 360 会被 clamp 弹回）。
 * 升级后旧用户打开应用看到面板从 340 → 360（多 20px），合理可接受。
 */
const STATUS_PANEL_MIN_WIDTH = 360
const STATUS_PANEL_MAX_WIDTH = 720
const STATUS_PANEL_DEFAULT_WIDTH = 360

export function clampStatusPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return STATUS_PANEL_DEFAULT_WIDTH
  return Math.min(STATUS_PANEL_MAX_WIDTH, Math.max(STATUS_PANEL_MIN_WIDTH, Math.round(width)))
}

type LayoutStore = {
  sidebarCollapsed: boolean
  statusPanelCollapsed: boolean
  statusPanelWidth: number
  toggleSidebar: () => void
  toggleStatusPanel: () => void
  setStatusPanelWidth: (width: number) => void
}

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      statusPanelCollapsed: false,
      statusPanelWidth: STATUS_PANEL_DEFAULT_WIDTH,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleStatusPanel: () =>
        set((state) => ({ statusPanelCollapsed: !state.statusPanelCollapsed })),
      setStatusPanelWidth: (width) => set({ statusPanelWidth: clampStatusPanelWidth(width) }),
    }),
    {
      name: "multi-agent-layout-store",
      // 只 persist 真有用的（collapsed 状态 + width），其他 action 不 persist
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        statusPanelCollapsed: state.statusPanelCollapsed,
        statusPanelWidth: state.statusPanelWidth,
      }),
      // rehydrate 时 clamp 防 corrupt localStorage 值（如手动篡改成 99999）
      merge: (persistedState, currentState) => {
        const merged = { ...currentState, ...(persistedState as Partial<LayoutStore>) }
        return {
          ...merged,
          statusPanelWidth: clampStatusPanelWidth(merged.statusPanelWidth),
        }
      },
    },
  ),
)

export { STATUS_PANEL_MIN_WIDTH, STATUS_PANEL_MAX_WIDTH, STATUS_PANEL_DEFAULT_WIDTH }
