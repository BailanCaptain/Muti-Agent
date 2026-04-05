"use client"

import { socketClient } from "@/components/ws/client"
import { create } from "zustand"
import { useThreadStore } from "./thread-store"

type ChatStore = {
  status: string
  draft: string
  setStatus: (status: string) => void
  setDraft: (draft: string | ((current: string) => string)) => void
  sendMessage: (input: string) => Promise<void>
}

export const useChatStore = create<ChatStore>((set) => ({
  status: "Connecting to realtime...",
  draft: "",
  setStatus: (status) => set({ status }),
  setDraft: (draft) =>
    set((state) => ({
      draft: typeof draft === "function" ? draft(state.draft) : draft,
    })),
  sendMessage: async (input) => {
    const payload = useThreadStore.getState().buildSendPayload(input)
    if (!payload) {
      set({ status: "请用 @ 指定智能体：@黄仁勋 / @范德彪 / @桂芬 / @所有人" })
      return
    }

    socketClient.send({
      type: "send_message",
      payload,
    })

    set({ draft: "" })
    set({ status: `Sent to ${payload.alias}` })
  },
}))
