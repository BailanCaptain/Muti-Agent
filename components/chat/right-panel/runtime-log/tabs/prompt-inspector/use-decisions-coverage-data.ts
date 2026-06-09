"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * F027 Phase 4 Week 3 Day 13 (AC-P4-9 c) · DecisionsCoverage hook
 *
 * 真相源:
 *   - GET /api/rooms/:id/decisions/coverage (Phase 3 Day 6 done)
 *   - contract: packages/api/src/routes/phase3/contracts.ts GetCoverageResponse
 *   - V16.5 chap 11 line 1238-1247 Decision Coverage Check
 *   - plan AC-P4-9 c: prompt-inspector 加第 8 块 Coverage section
 *
 * 行为:
 *   - 同 usePromptInspectorData pattern: enabled gate + roomId 变化 refetch
 *   - 失败 fail-soft 返 emptyCoverage 不阻塞 inspector tab 渲染
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

// ── contract types (mirror packages/api/src/routes/phase3/contracts.ts) ──

export type DecisionState = "active" | "completed" | "superseded" | "tombstone"
export type CoverageStatus = "pass" | "warn" | "fail"

export interface DecisionRef {
  decisionId: string
  summary: string
  state: DecisionState
  decisionType: string
  decidedBy: string
  decidedAt: string
}

export interface GetCoverageResponse {
  broad: DecisionRef[]
  resolved: DecisionRef[]
  unresolved: DecisionRef[]
  coverage: number | null
  status: CoverageStatus
  generatedAt: string
}

function emptyCoverage(): GetCoverageResponse {
  return {
    broad: [],
    resolved: [],
    unresolved: [],
    coverage: null,
    status: "fail",
    generatedAt: new Date(0).toISOString(),
  }
}

export interface UseDecisionsCoverageDataReturn {
  data: GetCoverageResponse
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export function useDecisionsCoverageData(
  roomId: string | null,
  options: { enabled?: boolean } = {},
): UseDecisionsCoverageDataReturn {
  const enabled = options.enabled !== false
  const [data, setData] = useState<GetCoverageResponse>(emptyCoverage())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchTrigger 是手动 invalidate 触发器
  useEffect(() => {
    if (!enabled || !roomId) {
      setData(emptyCoverage())
      setIsLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetch(`${API_BASE_URL}/api/rooms/${encodeURIComponent(roomId)}/decisions/coverage`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`)
        }
        const json = (await res.json()) as GetCoverageResponse
        if (cancelled) return
        setData(json)
        setIsLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setData(emptyCoverage())
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, roomId, refetchTrigger])

  const refetch = useCallback(() => {
    setRefetchTrigger((n) => n + 1)
  }, [])

  return { data, isLoading, error, refetch }
}
