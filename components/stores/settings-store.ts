"use client";

import { create } from "zustand";

type SocketState = "connected" | "disconnected" | "error";

type SettingsStore = {
  socketState: SocketState;
  setSocketState: (socketState: SocketState) => void;
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  socketState: "disconnected",
  setSocketState: (socketState) => set({ socketState })
}));
