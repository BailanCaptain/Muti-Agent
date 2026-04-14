"use client"

import { socketClient } from "@/components/ws/client"
import type { ContentBlock } from "@multi-agent/shared"
import { create } from "zustand"
import { useThreadStore } from "./thread-store"

type ChatStore = {
  status: string
  drafts: Record<string, string>
  pendingImages: Record<string, { url: string; file: File }[]>
  setStatus: (status: string) => void
  getDraft: (groupId: string | null) => string
  setDraft: (groupId: string | null, draft: string | ((current: string) => string)) => void
  addPendingImage: (groupId: string | null, image: { url: string; file: File }) => void
  clearPendingImages: (groupId: string | null) => void
  sendMessage: (input: string) => Promise<void>
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

async function uploadFile(file: File): Promise<string> {
  const form = new FormData()
  form.append("file", file)
  const res = await fetch(`${API_BASE}/api/uploads`, {
    method: "POST",
    body: form,
  })
  const data = await res.json()
  return `${API_BASE}${data.url}`
}

export const useChatStore = create<ChatStore>((set, get) => ({
  status: "Connecting to realtime...",
  drafts: {},
  pendingImages: {},
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
  addPendingImage: (groupId, image) => {
    const key = groupId ?? ""
    set((state) => ({
      pendingImages: {
        ...state.pendingImages,
        [key]: [...(state.pendingImages[key] ?? []), image],
      },
    }))
  },
  clearPendingImages: (groupId) => {
    const key = groupId ?? ""
    set((state) => {
      const pending = state.pendingImages[key] ?? []
      for (const img of pending) URL.revokeObjectURL(img.url)
      return { pendingImages: { ...state.pendingImages, [key]: [] } }
    })
  },
  sendMessage: async (input) => {
    const threadState = useThreadStore.getState()
    const state = get()
    const groupKey = threadState.activeGroupId ?? ""
    const pending = state.pendingImages[groupKey] ?? []

    const preValidation = threadState.buildSendPayload(input, undefined)
    if (!preValidation) {
      set({ status: "请用 @ 指定智能体：@黄仁勋 / @范德彪 / @桂芬 / @所有人" })
      return
    }

    const contentBlocks: ContentBlock[] = []
    for (const img of pending) {
      try {
        const url = await uploadFile(img.file)
        contentBlocks.push({ type: "image", url, alt: img.file.name })
      } catch {
        set({ status: `图片上传失败: ${img.file.name}` })
        return
      }
    }

    const payload = threadState.buildSendPayload(input, contentBlocks.length ? contentBlocks : undefined)
    if (!payload) return

    socketClient.send({
      type: "send_message",
      payload,
    })

    const groupId = threadState.activeGroupId
    if (groupId) {
      set((state) => ({ drafts: { ...state.drafts, [groupId]: "" } }))
    }
    get().clearPendingImages(groupId)
    set({ status: `Sent to ${payload.alias}` })
  },
}))
