"use client"

import { useCallback, useState } from "react"

/**
 * F027 Phase 4 Week 2 Day 8 (AC-P4-1 + AC-P4-2) · PromoteModal 数据 fetch hooks
 *
 * 真相源:
 *   - docs/plans/V16.5-final.md line 838-846 (Tainted_source promote 二次审计)
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-1 / AC-P4-2
 *   - packages/api/src/routes/phase4/promote.ts (endpoints already wired)
 *
 * 两个 hook (跟 IngestModal use-ingest-api pattern 一致):
 *   - usePromoteAudit: Modal mount → preview(srcDraftPath) → V14 verdict (passed + reject reason)
 *     用于禁用 [Promote] 按钮 / 渲染 reject reason 给 user 看
 *   - usePromoteCommit: 用户点 [Promote] → commit(...) → full V14 + mv + wiki_events
 *     resp: ok=true (finalPath/eventId) / 422 audit_rejected (Same reject shape)
 *
 * Endpoint:
 *   POST /api/wiki/drafts/promote/preview  body: { srcDraftPath, taintedSourceFields? }
 *   POST /api/wiki/drafts/promote          body: { srcDraftPath, destWikiPath, callerAlias,
 *                                                  reason, taintedSourceFields?, sourceMessageIds? }
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

// ── contract types (mirror routes/phase4/promote.ts + V14PromoteAuditResult) ──

export type V14AuditLayer =
  | "imperative_statement"
  | "prompt_structure"
  | "tainted_source_direct_quote"

export interface V14RejectReason {
  layer: V14AuditLayer
  matchedPatterns: readonly string[]
  hint: string
}

export interface V14PromoteAuditResult {
  passed: boolean
  rejectReason?: V14RejectReason
}

export interface PromotePreviewBody {
  srcDraftPath: string
  taintedSourceFields?: readonly string[]
}

export interface PromotePreviewResponse {
  ok: true
  audit: V14PromoteAuditResult
}

export interface PromoteCommitBody {
  srcDraftPath: string
  destWikiPath: string
  callerAlias: string
  reason: string
  taintedSourceFields?: readonly string[]
  sourceMessageIds?: string[]
}

export interface PromoteCommitSuccess {
  ok: true
  finalPath: string
  eventId: number
}

export interface PromoteCommitAuditRejected {
  ok: false
  code: "AUDIT_REJECTED"
  audit: V14RejectReason
}

export interface PromoteCommitGenericError {
  ok: false
  code: string
  error?: string
}

export type PromoteCommitResponse =
  | PromoteCommitSuccess
  | PromoteCommitAuditRejected
  | PromoteCommitGenericError

// ── usePromoteAudit (preview) ────────────────────────────────────────────────

export interface UsePromoteAuditReturn {
  data: V14PromoteAuditResult | null
  isLoading: boolean
  error: string | null
  preview: (body: PromotePreviewBody) => Promise<void>
  reset: () => void
}

export function usePromoteAudit(): UsePromoteAuditReturn {
  const [data, setData] = useState<V14PromoteAuditResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const preview = useCallback(async (body: PromotePreviewBody) => {
    setIsLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/promote/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const raw = (await resp.json()) as { ok: boolean; audit?: V14PromoteAuditResult; error?: string; code?: string }
      if (!resp.ok || !raw.ok || !raw.audit) {
        setError(`${raw.code ?? "HTTP_" + resp.status}: ${raw.error ?? "preview failed"}`)
        setData(null)
        return
      }
      setData(raw.audit)
    } catch (err) {
      setError((err as Error).message ?? "network error")
      setData(null)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setIsLoading(false)
  }, [])

  return { data, isLoading, error, preview, reset }
}

// ── usePromoteCommit ─────────────────────────────────────────────────────────

export interface UsePromoteCommitReturn {
  data: PromoteCommitSuccess | null
  /** AC-P4-2: 422 reject 时填充，UI 显示给用户改 body 再重试 */
  rejectReason: V14RejectReason | null
  isLoading: boolean
  /** Non-422 generic error (network / 400 / 403 / 409 / 500 etc.) */
  error: string | null
  commit: (body: PromoteCommitBody) => Promise<void>
  reset: () => void
}

export function usePromoteCommit(): UsePromoteCommitReturn {
  const [data, setData] = useState<PromoteCommitSuccess | null>(null)
  const [rejectReason, setRejectReason] = useState<V14RejectReason | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commit = useCallback(async (body: PromoteCommitBody) => {
    setIsLoading(true)
    setError(null)
    setRejectReason(null)
    try {
      const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const raw = (await resp.json()) as PromoteCommitResponse
      if (raw.ok) {
        setData(raw)
        return
      }
      // AC-P4-2 audit reject path
      if (resp.status === 422 && raw.code === "AUDIT_REJECTED" && "audit" in raw) {
        setRejectReason(raw.audit)
        return
      }
      // Generic error (400/403/409/500)
      setError(`${raw.code}: ${(raw as PromoteCommitGenericError).error ?? "promote failed"}`)
    } catch (err) {
      setError((err as Error).message ?? "network error")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setData(null)
    setRejectReason(null)
    setError(null)
    setIsLoading(false)
  }, [])

  return { data, rejectReason, isLoading, error, commit, reset }
}
