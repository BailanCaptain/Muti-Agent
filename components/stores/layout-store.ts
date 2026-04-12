"use client"

import { create } from "zustand"

type LayoutStore = {
  sidebarCollapsed: boolean
  statusPanelCollapsed: boolean
  toggleSidebar: () => void
  toggleStatusPanel: () => void
}

export const useLayoutStore = create<LayoutStore>((set) => ({
  sidebarCollapsed: false,
  statusPanelCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleStatusPanel: () => set((state) => ({ statusPanelCollapsed: !state.statusPanelCollapsed })),
}))
