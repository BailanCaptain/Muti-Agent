"use client"

import { useEffect, useState } from "react"

/**
 * 前端 contract types（mirror packages/api/src/routes/phase3/contracts.ts
 * GetPromptInspectorResponse 子段）— 后端 contracts 不暴露 npm package，
 * 前端 inline 镜像保持同 shape。Day 14-15 起手 inline，Phase 4 评估抽
 * shared/runtime-contracts npm 包。
 */
export interface InjectedPart {
  name: string
  bytes: number
  tokensEstimated: number
  source: string
}

export type RecallGate = "high" | "mid" | "low"

export interface RecallQueryItem {
  query: string
  hits: number
  gate: RecallGate
  topScore: number
}

export interface AdaptiveRecallState {
  recallRequired: boolean
  recallPath: 1 | 2 | 3 | 4 | 5 | null
  recallSatisfied: boolean
  escalateReason: string | null
  budgetConsumed: number
  budgetMax: number
}

export interface GetPromptInspectorResponse {
  injectedParts: InjectedPart[]
  recallQueries: RecallQueryItem[]
  recallState: AdaptiveRecallState
  wakeUpTrigger: {
    kind: "a2a_call" | "user_message" | "scheduler_tick" | null
    ref: string | null
  }
}

/**
 * F027 Phase 3 Week 4 Day 14-15 (AC-P3-3) · prompt-inspector 数据 fetch hook
 *
 * 真相源：
 *   - GET /api/rooms/:id/prompt-inspector (Week 1 Day 4 done, packages/api/src/routes/phase3/prompt-inspector.ts)
 *   - contract: packages/api/src/routes/phase3/contracts.ts GetPromptInspectorResponse
 *   - PromptInspectorTab UI 7 块按 V16.5 chap 18 line 2030-2079 渲染
 *
 * 行为:
 *   - 组件首次 mount 时不 fetch（懒触发：用 enabled flag 让 caller 控制）
 *   - roomId 变化时重新 fetch
 *   - 失败 fail-soft 返 emptyResponse（同 service 的 emptyInspectorResponse 结构）
 *   - Phase 3 Week 4 Day 14-15 范围：实时 refresh 留 Phase 4 (本 hook 提供 refetch() trigger)
 */

const DEFAULT_RECALL_BUDGET_MAX = 4000

function emptyResponse(): GetPromptInspectorResponse {
  return {
    injectedParts: [],
    recallQueries: [],
    recallState: {
      recallRequired: false,
      recallPath: null,
      recallSatisfied: false,
      escalateReason: null,
      budgetConsumed: 0,
      budgetMax: DEFAULT_RECALL_BUDGET_MAX,
    },
    wakeUpTrigger: { kind: null, ref: null },
  }
}

export interface UsePromptInspectorDataReturn {
  data: GetPromptInspectorResponse
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export function usePromptInspectorData(
  roomId: string | null,
  options: { enabled?: boolean } = {},
): UsePromptInspectorDataReturn {
  const enabled = options.enabled !== false
  const [data, setData] = useState<GetPromptInspectorResponse>(emptyResponse())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  useEffect(() => {
    if (!enabled || !roomId) {
      setData(emptyResponse())
      setIsLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetch(`/api/rooms/${encodeURIComponent(roomId)}/prompt-inspector`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`)
        }
        return res.json() as Promise<GetPromptInspectorResponse>
      })
      .then((json) => {
        if (cancelled) return
        setData(json)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
        setIsLoading(false)
        // 失败 fail-soft：保留 emptyResponse 让 UI 显示 "暂无数据" 而非崩
        setData(emptyResponse())
      })
    return () => {
      cancelled = true
    }
  }, [roomId, enabled, refetchTrigger])

  return {
    data,
    isLoading,
    error,
    refetch: () => setRefetchTrigger((n) => n + 1),
  }
}
