"use client"

import { useEffect, useState } from "react"

/** API base · 同 Day 14-15 r2 P1 fix pattern */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

/**
 * F027 Phase 3 Week 4 Day 18-19 (AC-P3-2 子需求) · drafts 数据 fetch hook
 * 真相源: GET /api/wiki/drafts (Phase 3 Week 1 Day 3 done) +
 *   ListDraftsResponse contract (mirror packages/api/src/routes/phase3/contracts.ts)
 * 行为同 use-prompt-inspector-data / use-viewfinder-data: fetch + fail-soft + enabled flag
 */

export type DraftType = "feature" | "bug" | "lesson" | "concept" | "wiki-memory" | "session-archive"

export type DraftOrigin = "user-drop" | "auto" | "backfill" | "expired"

export interface DraftSummary {
  path: string
  type: DraftType
  title: string
  mtime: string
  summary: string
  origin: DraftOrigin
}

export interface ListDraftsResponse {
  drafts: DraftSummary[]
  total: number
  limit: number
  offset: number
}

function emptyResponse(): ListDraftsResponse {
  return { drafts: [], total: 0, limit: 50, offset: 0 }
}

export interface UseDraftsDataReturn {
  data: ListDraftsResponse
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export function useDraftsData(options: { enabled?: boolean } = {}): UseDraftsDataReturn {
  const enabled = options.enabled !== false
  const [data, setData] = useState<ListDraftsResponse>(emptyResponse())
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
    // F027 全选三件套：显式 limit=200（后端上限）一次拉满。默认 50 会让 57+ 篇时
    // 列表只显示最新 50、「全选」名不副实（header total 与可见数对不上）。
    // >200 篇时仍截断——header 显示 total，差额可见；真到那规模再上分页。
    fetch(`${API_BASE_URL}/api/wiki/drafts?limit=200`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        return res.json() as Promise<ListDraftsResponse>
      })
      .then((json) => {
        if (cancelled) return
        setData(json)
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

  return { data, isLoading, error, refetch: () => setRefetchTrigger((n) => n + 1) }
}
