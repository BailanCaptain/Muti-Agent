"use client"

import { useCallback, useState } from "react"

/**
 * F027 Phase 4 AC-P4-3 (d) (codex Week 5 j2 FAIL Red→Green) ·
 * DemoteModal 数据 fetch hook
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-3 (d):
 *     "DemoteModal: 选 reason → POST /api/wiki/<path>/demote → mv 回 _drafts/ + 写
 *      wiki_events action='demote'"
 *   - packages/api/src/routes/phase4/demote.ts (POST /api/wiki/drafts/demote)
 *
 * 跟 PromoteModal 不同:
 *   - demote 不需要 V14 audit (拒绝操作, 不是写型审计)
 *   - 只一个 endpoint (no preview)
 *   - src 可以是任意 wiki/ 下 (含 draft 和 正式 entity), 不限 draft
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

export interface DemoteRequest {
  srcWikiPath: string
  callerAlias: string
  reason: string
  sourceMessageIds?: string[]
}

export interface DemoteSuccess {
  ok: true
  rejectedPath: string
  eventId: number
}

export interface DemoteErrorResponse {
  ok: false
  code: string
  error?: string
}

export type DemoteResponse = DemoteSuccess | DemoteErrorResponse

export interface UseDemoteApiReturn {
  data: DemoteSuccess | null
  isLoading: boolean
  /** Generic error (network / 400 / 403 / 404 / 409 / 500) — 显示给用户改 reason / 重试 */
  error: string | null
  demote: (body: DemoteRequest) => Promise<void>
  reset: () => void
}

export function useDemoteApi(): UseDemoteApiReturn {
  const [data, setData] = useState<DemoteSuccess | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const demote = useCallback(async (body: DemoteRequest) => {
    setIsLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/demote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const raw = (await resp.json()) as DemoteResponse
      if (raw.ok) {
        setData(raw)
        return
      }
      setError(`${raw.code}: ${(raw as DemoteErrorResponse).error ?? "demote failed"}`)
    } catch (err) {
      setError((err as Error).message ?? "network error")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setIsLoading(false)
  }, [])

  return { data, isLoading, error, demote, reset }
}
