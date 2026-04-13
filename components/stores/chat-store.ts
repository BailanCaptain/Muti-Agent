"use client"

import { socketClient } from "@/components/ws/client"
import { create } from "zustand"
import { useThreadStore } from "./thread-store"

type ChatStore = {
  status: string
  drafts: Record<string, string>
  setStatus: (status: string) => void
  getDraft: (groupId: string | null) => string
  setDraft: (groupId: string | null, draft: string | ((current: string) => string)) => void
  sendMessage: (input: string) => Promise<void>
}

export const useChatStore = create<ChatStore>((set, get) => ({
  status: "Connecting to realtime...",
  drafts: {},
  setStatus: (status) => set({ status }),
  getDraft: (groupId) => {
    return get().drafts[groupId ?? ""] ?? ""
  },
  setDraft: (groupId, draft) => {
    const key = groupId ?? ""
    set((state) => {
      const current = state.drafts[key] ?? ""
      const next = typeof draft === "function" ? draft(current) : draft
      return { drafts: { ...state.drafts, [key]: next } }
    })
  },
  sendMessage: async (input) => {
    const threadState = useThreadStore.getState()
    const payload = threadState.buildSendPayload(input)
    if (!payload) {
      set({ status: "请用 @ 指定智能体：@黄仁勋 / @范德彪 / @桂芬 / @所有人" })
      return
    }

    socketClient.send({
      type: "send_message",
      payload,
    })

    const groupId = threadState.activeGroupId
    if (groupId) {
      set((state) => ({ drafts: { ...state.drafts, [groupId]: "" } }))
    }
    set({ status: `Sent to ${payload.alias}` })
  },
}))
