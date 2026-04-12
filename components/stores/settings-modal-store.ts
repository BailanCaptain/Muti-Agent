"use client"

import { create } from "zustand"

type SettingsModalStore = {
  isOpen: boolean
  open: () => void
  close: () => void
}

export const useSettingsModalStore = create<SettingsModalStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}))
