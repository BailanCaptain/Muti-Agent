"use client"

import { useEffect, useState } from "react"

/** API base URL 同 thread-store / chat-store pattern (Day 14-15 r2 P1 fix) */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

/**
 * F027 Phase 3 Week 4 Day 16-17 (AC-P3-4) · viewfinder 数据 fetch hook
 *
 * 真相源：
 *   - GET /api/rooms/:id/viewfinder (Phase 3 Week 1 Day 3 done)
 *   - contract: packages/api/src/routes/phase3/contracts.ts GetViewfinderResponse
 *
 * 行为同 use-prompt-inspector-data：fetch + fail-soft + refetch
 */

export interface GetViewfinderResponse {
  viewfinder: string | null
  coverage: {
    broad: number
    resolved: number
    unresolved: number
    coverage: number | null
    status: "pass" | "warn" | "fail"
  }
  lastCompiledAt: string | null
  ledger: {
    activeCount: number
    latestDecisionId: string | null
  }
}

function emptyResponse(): GetViewfinderResponse {
  return {
    viewfinder: null,
    coverage: { broad: 0, resolved: 0, unresolved: 0, coverage: null, status: "pass" },
    lastCompiledAt: null,
    ledger: { activeCount: 0, latestDecisionId: null },
  }
}

export interface UseViewfinderDataReturn {
  data: GetViewfinderResponse
  isLoading: boolean
  error: string | null
  refetch: () => void
}

export function useViewfinderData(
  roomId: string | null,
  options: { enabled?: boolean } = {},
): UseViewfinderDataReturn {
  const enabled = options.enabled !== false
  const [data, setData] = useState<GetViewfinderResponse>(emptyResponse())
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
    fetch(`${API_BASE_URL}/api/rooms/${encodeURIComponent(roomId)}/viewfinder`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        return res.json() as Promise<GetViewfinderResponse>
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
  }, [roomId, enabled, refetchTrigger])

  return { data, isLoading, error, refetch: () => setRefetchTrigger((n) => n + 1) }
}

/**
 * AC-P3-4 a2a 引用 parser: 从 viewfinder markdown 抓出 `[a2a_call=call-xxxx, status=...]`
 * 文本，把它们 split 成 segments：text / a2a-ref。
 *
 * 例子：
 *   "等 范德彪 [a2a_call=call-abc12345, status=pending, deadline 17:30]"
 * →
 *   [{kind:'text', text:'等 范德彪 '},
 *    {kind:'a2a', callId:'call-abc12345', status:'pending', deadline:'17:30'}]
 *
 * 用于 viewfinder §4 段 a2a 行用 <AtPill> 渲染（V16.5 chap 11 line 1333-1335 渲染契约）。
 */
export type ViewfinderSegment =
  | { kind: "text"; text: string }
  | {
      kind: "a2a"
      callId: string
      status: string
      deadline?: string
      reason?: string
    }

const A2A_REF_REGEX =
  /\[a2a_call=([^,\]]+)(?:,\s*status=([^,\]]+))?(?:,\s*deadline\s+([^,\]]+))?(?:,\s*reason=("[^"]*"|[^,\]]+))?\]/g

export function parseA2ARefs(text: string): ViewfinderSegment[] {
  const segments: ViewfinderSegment[] = []
  let lastIndex = 0
  // matchAll 用全局 regex，需要 fresh state
  const matches = Array.from(text.matchAll(A2A_REF_REGEX))
  for (const match of matches) {
    const matchStart = match.index ?? 0
    if (matchStart > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, matchStart) })
    }
    const [, callId, status, deadline, reasonRaw] = match
    const reason = reasonRaw ? reasonRaw.replace(/^"|"$/g, "") : undefined
    segments.push({
      kind: "a2a",
      callId: callId.trim(),
      status: (status ?? "unknown").trim(),
      deadline: deadline?.trim(),
      reason,
    })
    lastIndex = matchStart + match[0].length
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) })
  }
  return segments
}
