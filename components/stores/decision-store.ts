"use client"

import { socketClient } from "@/components/ws/client"
import { getApiHttpBaseUrl } from "@/lib/api-endpoints"
import type { DecisionRecord, DecisionRequest, DecisionVerdict } from "@multi-agent/shared"
import { create } from "zustand"

// F033: pending（活句柄，可点）与 records（已决/超时/孤儿，disabled 渲染）双轨。
// respond 走 optimistic：先本地移轨，服务端 decision.resolved 广播与 fetchRecords 兜底纠偏。
type DecisionStore = {
  pending: DecisionRequest[]
  records: DecisionRecord[]
  addRequest: (request: DecisionRequest) => void
  removeRequest: (requestId: string) => void
  respond: (
    requestId: string,
    decisions: DecisionVerdict[],
    userInput?: string,
  ) => void
  resolveFromWs: (requestId: string, decisions: DecisionVerdict[], userInput?: string) => void
  fetchPending: (sessionGroupId: string) => Promise<void>
  fetchRecords: (sessionGroupId: string) => Promise<void>
}

function toResolvedRecord(
  request: DecisionRequest,
  decisions: DecisionVerdict[],
  userInput?: string,
): DecisionRecord {
  return {
    requestId: request.requestId,
    sessionGroupId: request.sessionGroupId,
    kind: request.kind,
    title: request.title,
    description: request.description,
    options: request.options,
    multiSelect: request.multiSelect,
    anchorMessageId: request.anchorMessageId,
    sourceProvider: request.sourceProvider,
    sourceAlias: request.sourceAlias,
    status: "resolved",
    verdicts: decisions,
    userInput,
    createdAt: request.createdAt,
    resolvedAt: new Date().toISOString(),
  }
}

export const useDecisionStore = create<DecisionStore>((set) => ({
  pending: [],
  records: [],
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
    set((state) => {
      const request = state.pending.find((r) => r.requestId === requestId)
      return {
        pending: state.pending.filter((r) => r.requestId !== requestId),
        records: request
          ? [...state.records, toResolvedRecord(request, decisions, userInput)]
          : state.records,
      }
    })
  },
  resolveFromWs: (requestId, decisions, userInput) =>
    set((state) => {
      // 本端已 optimistic 移轨 → 广播回声去重
      if (state.records.some((r) => r.requestId === requestId)) {
        return { pending: state.pending.filter((r) => r.requestId !== requestId) }
      }
      const request = state.pending.find((r) => r.requestId === requestId)
      if (!request) return state
      return {
        pending: state.pending.filter((r) => r.requestId !== requestId),
        records: [...state.records, toResolvedRecord(request, decisions, userInput)],
      }
    }),
  fetchPending: async (sessionGroupId) => {
    const baseUrl = getApiHttpBaseUrl()
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
  fetchRecords: async (sessionGroupId) => {
    const baseUrl = getApiHttpBaseUrl()
    try {
      const res = await fetch(
        `${baseUrl}/api/decisions/records?sessionGroupId=${encodeURIComponent(sessionGroupId)}`,
      )
      if (!res.ok) return
      const data = (await res.json()) as { records: DecisionRecord[] }
      set((state) => {
        // 服务端真相优先；本地 optimistic（服务端尚未返回的）保留。
        // 德彪 r1 P3: 只保留本房间的 local-only，防跨房间切换无界累积
        //（其他房间的已决记录服务端有账，切回时 fetchRecords 找回）。
        const serverIds = new Set(data.records.map((r) => r.requestId))
        const localOnly = state.records.filter(
          (r) => !serverIds.has(r.requestId) && r.sessionGroupId === sessionGroupId,
        )
        return { records: [...data.records, ...localOnly] }
      })
    } catch (err) {
      console.error("[decision-store] fetchRecords error", err)
    }
  },
}))
