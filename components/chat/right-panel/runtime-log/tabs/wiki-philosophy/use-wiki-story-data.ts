"use client"

import { useEffect, useState } from "react"

/**
 * F027 v3 G6 · Wiki 哲学 panel 数据 fetch hook
 *
 * 真相源:
 *   - GET /api/wiki/story (packages/api/src/routes/phase3/wiki-story.ts)
 *   - contract: GetWikiStoryResponse
 *
 * 行为:
 *   - enabled=false 时不 fetch (KB tab 不 active 时省网络)
 *   - 失败 fail-soft 返 emptyResponse (UI 显 "暂无数据")
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

// mirror packages/api/src/routes/phase3/wiki-story.ts shape
export interface WikiEntitySummary {
  id: number
  name: string
  canonicalOwnerPath: string
  state: string
  supersedes: string[]
  updatedAt: string
}

export interface WikiBucketStat {
  type: string
  totalCount: number
  canonicalCount: number
  draftCount: number
  topEntities: WikiEntitySummary[]
}

export interface WikiGrowthPoint {
  day: string
  entityNew: number
  decisionNew: number
}

export interface GetWikiStoryResponse {
  buckets: WikiBucketStat[]
  totalEntities: number
  totalDecisions: number
  recent7d: WikiGrowthPoint[]
}

function emptyResponse(): GetWikiStoryResponse {
  return { buckets: [], totalEntities: 0, totalDecisions: 0, recent7d: [] }
}

export interface UseWikiStoryDataReturn {
  data: GetWikiStoryResponse
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export function useWikiStoryData(
  options: { enabled?: boolean } = {},
): UseWikiStoryDataReturn {
  const enabled = options.enabled !== false
  const [data, setData] = useState<GetWikiStoryResponse>(emptyResponse())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setData(emptyResponse())
      setIsLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetch(`${API_BASE_URL}/api/wiki/story`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        return res.json() as Promise<GetWikiStoryResponse>
      })
      .then((json) => {
        if (cancelled) return
        // 防御性 normalize: 后端漏字段 / 老 API → fallback emptyResponse fields
        // (KB tab 单测用统一 mockOkFetch 跨多 endpoint 返同 shape, 不一定满 GetWikiStoryResponse)
        const safe: GetWikiStoryResponse = {
          buckets: Array.isArray(json?.buckets) ? json.buckets : [],
          totalEntities: typeof json?.totalEntities === "number" ? json.totalEntities : 0,
          totalDecisions: typeof json?.totalDecisions === "number" ? json.totalDecisions : 0,
          recent7d: Array.isArray(json?.recent7d) ? json.recent7d : [],
        }
        setData(safe)
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
        setData(emptyResponse())
      })
    return () => {
      cancelled = true
    }
  }, [enabled, refetchTrigger])

  return {
    data,
    isLoading,
    error,
    refetch: () => setRefetchTrigger((n) => n + 1),
  }
}
