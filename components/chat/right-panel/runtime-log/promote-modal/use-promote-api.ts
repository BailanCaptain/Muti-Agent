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

// posture C（德彪 r1 P2）：mirror 后端 V14AuditLayer——删 imperative_statement（regex 层已换 LLM
// 判官）+ 加 llm_semantic_injection / judge_parse_failed / judge_unavailable + 补 exemption_sanitize_blocked。
export type V14AuditLayer =
  | "prompt_structure"
  | "tainted_source_direct_quote"
  | "llm_semantic_injection"
  | "judge_parse_failed"
  | "judge_unavailable"
  | "exemption_sanitize_blocked"

/** judge 基础设施类拒绝（可重试，非内容问题）——UI 文案应提示「稍后重试」而非「改写 body」。 */
export const RETRYABLE_AUDIT_LAYERS: ReadonlySet<V14AuditLayer> = new Set<V14AuditLayer>([
  "judge_parse_failed",
  "judge_unavailable",
])

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
  /** dest_exists 替换补丁：true = dest 已存在时归档旧页（_rejected/ 可恢复）后覆盖。 */
  allowReplace?: boolean
  /** allowReplace 必带：对比面板看到的现有页 contentHash（服务端 CAS 校验，防盲替换）。 */
  expectedDestHash?: string
}

export interface PromoteCommitSuccess {
  ok: true
  finalPath: string
  eventId: number
  /** 替换发生时：旧页归档到的 _rejected/ 相对路径。 */
  replacedArchivePath?: string
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
      const raw = (await resp.json()) as {
        ok: boolean
        audit?: V14PromoteAuditResult
        error?: string
        code?: string
      }
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

// 后台化德彪 r1 P3：usePromoteCommit 已删——commit 生命周期唯一实现在
// components/stores/promote-jobs-store.ts（防同一 API 契约双实现漂移）。类型仍从本文件导出。
