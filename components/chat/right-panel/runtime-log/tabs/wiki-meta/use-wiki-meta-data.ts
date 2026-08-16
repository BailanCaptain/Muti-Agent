"use client"

import { getApiHttpBaseUrl } from "@/lib/api-endpoints"
import { useCallback, useEffect, useState } from "react"

/**
 * F027 Phase 4 Week 4 Day 17 (AC-P4-9 a/b) · wiki-meta data fetch hooks
 *
 * 真相源:
 *   - GET /api/wiki/warnings (Day 17 done, packages/api/src/routes/phase4/wiki-meta.ts)
 *   - GET /api/wiki/index    (Day 17 done, 同上)
 *   - contracts: WarningSummary / IndexViewSummary 在 backend wiki-meta.ts inline 定义
 *
 * 行为:
 *   - useWarningsData(): fetch GET /api/wiki/warnings, enabled gate
 *   - useIndexData(): fetch GET /api/wiki/index, enabled gate
 *   - empty/loading/error 三态 + refetch()
 */

const API_BASE_URL = getApiHttpBaseUrl()

// ── contract types (mirror packages/api/src/routes/phase4/wiki-meta.ts) ───────

export type WarningSeverity = "critical" | "high" | "warn" | "info"

export interface WarningSummary {
  path: string
  type: string
  subtype: string
  severity: WarningSeverity | null
  source: string | null
  detectedAt: string | null
  raisedBy: string | null
  summary: string
  mtime: string
  /**
   * 该警告是否有真 `.md` 文件可读全文（file-scanned=true / wiki_events 合成=false）。
   * 前端只对 true 渲染「展开看全文」，避免 event-only 警告点开 404。详见 backend wiki-meta.ts。
   */
  hasContent: boolean
}

export interface ListWarningsResponse {
  warnings: WarningSummary[]
  total: number
}

export interface IndexViewSummary {
  path: string
  bucket: string
  generatedAt: string | null
  compilerVersion: string | null
  summary: string
  mtime: string
}

export interface ListIndexResponse {
  views: IndexViewSummary[]
  total: number
}

// ── useWarningsData ──────────────────────────────────────────────────────────

export interface UseWarningsDataReturn {
  data: ListWarningsResponse
  isLoading: boolean
  error: string | null
  refetch: () => void
}

function emptyWarnings(): ListWarningsResponse {
  return { warnings: [], total: 0 }
}

export function useWarningsData(
  options: { enabled?: boolean } = {},
): UseWarningsDataReturn {
  const enabled = options.enabled !== false
  const [data, setData] = useState<ListWarningsResponse>(emptyWarnings())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchTrigger 手动 invalidate
  useEffect(() => {
    if (!enabled) {
      setData(emptyWarnings())
      setIsLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetch(`${API_BASE_URL}/api/wiki/warnings`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        const json = (await res.json()) as ListWarningsResponse
        if (cancelled) return
        setData(json)
        setIsLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setData(emptyWarnings())
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, refetchTrigger])

  const refetch = useCallback(() => {
    setRefetchTrigger((n) => n + 1)
  }, [])

  return { data, isLoading, error, refetch }
}

// ── useIndexData ─────────────────────────────────────────────────────────────

export interface UseIndexDataReturn {
  data: ListIndexResponse
  isLoading: boolean
  error: string | null
  refetch: () => void
}

function emptyIndex(): ListIndexResponse {
  return { views: [], total: 0 }
}

export function useIndexData(options: { enabled?: boolean } = {}): UseIndexDataReturn {
  const enabled = options.enabled !== false
  const [data, setData] = useState<ListIndexResponse>(emptyIndex())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetchTrigger 手动 invalidate
  useEffect(() => {
    if (!enabled) {
      setData(emptyIndex())
      setIsLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetch(`${API_BASE_URL}/api/wiki/index`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        const json = (await res.json()) as ListIndexResponse
        if (cancelled) return
        setData(json)
        setIsLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setData(emptyIndex())
        setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, refetchTrigger])

  const refetch = useCallback(() => {
    setRefetchTrigger((n) => n + 1)
  }, [])

  return { data, isLoading, error, refetch }
}
