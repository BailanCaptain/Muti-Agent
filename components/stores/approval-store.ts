"use client"

import { socketClient } from "@/components/ws/client"
import type { ApprovalRequest, ApprovalScope } from "@multi-agent/shared"
import { create } from "zustand"

type ApprovalStore = {
  pending: ApprovalRequest[]
  addRequest: (request: ApprovalRequest) => void
  removeRequest: (requestId: string) => void
  respond: (requestId: string, granted: boolean, scope: ApprovalScope) => void
  fetchPending: (sessionGroupId: string) => Promise<void>
}

export const useApprovalStore = create<ApprovalStore>((set) => ({
  pending: [],
  addRequest: (request) =>
    set((state) => ({
      pending: [...state.pending, request],
    })),
  removeRequest: (requestId) =>
    set((state) => ({
      pending: state.pending.filter((r) => r.requestId !== requestId),
    })),
  respond: (requestId, granted, scope) => {
    socketClient.send({
      type: "approval.respond",
      payload: { requestId, granted, scope },
    })
    set((state) => ({
      pending: state.pending.filter((r) => r.requestId !== requestId),
    }))
  },
  fetchPending: async (sessionGroupId) => {
    const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
    try {
      const res = await fetch(
        `${baseUrl}/api/authorization/pending?sessionGroupId=${encodeURIComponent(sessionGroupId)}`,
      )
      if (!res.ok) return
      const data = (await res.json()) as { pending: ApprovalRequest[] }
      set({ pending: data.pending })
    } catch (err) {
      console.error("[approval-store] fetch error", err)
    }
  },
}))
