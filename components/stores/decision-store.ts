"use client"

import { socketClient } from "@/components/ws/client"
import type { DecisionRequest, DecisionVerdict } from "@multi-agent/shared"
import { create } from "zustand"

type DecisionStore = {
  pending: DecisionRequest[]
  addRequest: (request: DecisionRequest) => void
  removeRequest: (requestId: string) => void
  respond: (
    requestId: string,
    decisions: DecisionVerdict[],
    userInput?: string,
  ) => void
  fetchPending: (sessionGroupId: string) => Promise<void>
}

export const useDecisionStore = create<DecisionStore>((set) => ({
  pending: [],
  addRequest: (request) =>
    set((state) => ({
      pending: state.pending.some((r) => r.requestId === request.requestId)
        ? state.pending
        : [...state.pending, request],
    })),
  removeRequest: (requestId) =>
    set((state) => ({
      pending: state.pending.filter((r) => r.requestId !== requestId),
    })),
  respond: (requestId, decisions, userInput) => {
    socketClient.send({
      type: "decision.respond",
      payload: {
        requestId,
        decisions,
        ...(userInput ? { userInput } : {}),
      },
    })
    set((state) => ({
      pending: state.pending.filter((r) => r.requestId !== requestId),
    }))
  },
  fetchPending: async (sessionGroupId) => {
    const baseUrl = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
    try {
      const res = await fetch(
        `${baseUrl}/api/decisions/pending?sessionGroupId=${encodeURIComponent(sessionGroupId)}`,
      )
      if (!res.ok) return
      const data = (await res.json()) as { pending: DecisionRequest[] }
      set({ pending: data.pending })
    } catch (err) {
      console.error("[decision-store] fetch error", err)
    }
  },
}))
