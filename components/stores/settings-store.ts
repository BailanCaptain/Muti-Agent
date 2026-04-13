"use client";

import { create } from "zustand";

type SocketState = "connected" | "disconnected" | "error";

type SettingsStore = {
  socketState: SocketState;
  setSocketState: (socketState: SocketState) => void;
  showThinking: boolean;
  setShowThinking: (showThinking: boolean) => void;
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  socketState: "disconnected",
  setSocketState: (socketState) => set({ socketState }),
  showThinking: true,
  setShowThinking: (showThinking) => set({ showThinking }),
}));
