"use client"

import { socketClient } from "@/components/ws/client"
import type { DecisionRequest } from "@multi-agent/shared"
import { create } from "zustand"

type DecisionStore = {
  pending: DecisionRequest[]
  addRequest: (request: DecisionRequest) => void
  removeRequest: (requestId: string) => void
  respond: (requestId: string, selectedIds: string[]) => void
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
  respond: (requestId, selectedIds) => {
    socketClient.send({
      type: "decision.respond",
      payload: { requestId, selectedIds },
    })
    set((state) => ({
      pending: state.pending.filter((r) => r.requestId !== requestId),
    }))
  },
}))
