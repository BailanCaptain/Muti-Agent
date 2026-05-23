"use client"

import { useCallback, useRef, useState } from "react"

/**
 * F027 Phase 3 Week 4 Day 19a (AC-P3-6 + AC-P3-10) · IngestModal 数据 fetch hook
 *
 * 真相源：
 *   - V16.5 chap 25 line 2547-2619 (IngestModal 完整设计 + API)
 *   - feature.md AC-P3-6 (3 入口 + sanitize 预扫) + AC-P3-10 (commit 落盘)
 *   - GET POST /api/wiki/ingest/preview (Phase 3 Week 1 Day 5 done)
 *   - POST /api/wiki/ingest/commit (Phase 3 Week 2 Day 10 done)
 *   - contracts: PreviewIngestBody / PreviewIngestResponse / PostIngestCommitBody /
 *     PostIngestCommitResponse / PreviewWarning
 *
 * 行为:
 *   - usePreview: 命令式 preview(body) 触发 POST /api/wiki/ingest/preview
 *   - useCommit: 命令式 commit(body) 触发 POST /api/wiki/ingest/commit
 *   - Phase 3 Day 19 范围：分两个独立 hook（preview/commit 调用时机不同）
 *     - Modal mount → 拿到 file content 后 preview → 拿 previewId
 *     - 点 [/ingest 编译] 才 commit (拿 previewId + callerAlias)
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

// ── inline contract types (mirror packages/api/src/routes/phase3/contracts.ts) ───

export type IngestMime = "text/markdown" | "text/plain" | "application/json"
export type DraftType = "feature" | "bug" | "lesson" | "concept" | "wiki-memory" | "session-archive"

export interface PreviewWarning {
  kind: "sensitive_token" | "size_truncated" | "encoding" | "binary_skipped"
  subkind?: string
  message: string
}

export interface PreviewIngestBody {
  sourcePath: string
  content: string
  mimeType: IngestMime
  targetType?: DraftType
  /**
   * F027 P4 Day 10 AC-P4-3 e · Series 标记（防 chained 误检）
   * V16.5 chap 25 line 2563-2564 "🔗 系列 (防 chained 误检)"
   *
   * 限制: 1-64 chars + [a-zA-Z0-9_-]+ pattern (空字符串视为 undefined)。
   * commit 时 backend inject 到落盘 markdown frontmatter `series_id: <id>`。
   */
  seriesId?: string
}

export interface PreviewIngestResponse {
  previewId: string
  sanitizedContent: string
  llmCompiledPreview: string
  warnings: PreviewWarning[]
  expiresAt: string
}

export interface PostIngestCommitBody {
  previewId: string
  callerAlias: string
  leaseToken?: string
}

export interface PostIngestCommitResponse {
  ingestEventId: string
  finalPath: string
  committedAt: string
  fencingToken: string
}

interface ApiErrorBody {
  error: string
  message: string
  detail?: Record<string, unknown>
}

// ── usePreview ──

export interface UsePreviewReturn {
  data: PreviewIngestResponse | null
  isLoading: boolean
  error: string | null
  preview: (body: PreviewIngestBody) => Promise<void>
  reset: () => void
}

export function useIngestPreview(): UsePreviewReturn {
  const [data, setData] = useState<PreviewIngestResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 范-r1 P1-2 fix: monotonic request id 守 stale response
  // (preview A 慢 + preview B 后启动 → A 响应到时 reqId 已过期 → 不更 state)
  const reqIdRef = useRef(0)

  const preview = useCallback(async (body: PreviewIngestBody) => {
    const myReqId = ++reqIdRef.current
    setIsLoading(true)
    setError(null)
    // 范-r1 P1-2 fix: 清旧 data 防 stale data 仍 commit-enabled
    // (UI 切换 file/type 后旧 preview 不应残留)
    setData(null)
    try {
      const res = await fetch(`${API_BASE_URL}/api/wiki/ingest/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody>
        throw new Error(errBody.message ?? `HTTP ${res.status} ${res.statusText}`)
      }
      const json = (await res.json()) as PreviewIngestResponse
      // 范-r1 P1-2 fix: stale response (新 preview 已发出) → discard
      if (myReqId !== reqIdRef.current) return
      setData(json)
      setIsLoading(false)
    } catch (err) {
      // stale error 也 discard (避免覆盖新请求的 loading 状态)
      if (myReqId !== reqIdRef.current) return
      setError(err instanceof Error ? err.message : String(err))
      setIsLoading(false)
      setData(null)
    }
  }, [])

  const reset = useCallback(() => {
    // 范-r1 P1-2 fix: reset 也 bump reqId 让 in-flight 响应作废
    reqIdRef.current++
    setData(null)
    setError(null)
    setIsLoading(false)
  }, [])

  return { data, isLoading, error, preview, reset }
}

// ── useCommit ──

export interface UseCommitReturn {
  data: PostIngestCommitResponse | null
  isLoading: boolean
  error: string | null
  commit: (body: PostIngestCommitBody) => Promise<void>
  reset: () => void
}

export function useIngestCommit(): UseCommitReturn {
  const [data, setData] = useState<PostIngestCommitResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commit = useCallback(async (body: PostIngestCommitBody) => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_URL}/api/wiki/ingest/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody>
        throw new Error(errBody.message ?? `HTTP ${res.status} ${res.statusText}`)
      }
      const json = (await res.json()) as PostIngestCommitResponse
      setData(json)
      setIsLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setIsLoading(false)
      setData(null)
    }
  }, [])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setIsLoading(false)
  }, [])

  return { data, isLoading, error, commit, reset }
}

// ── mime detection helper ──

/**
 * 按 file 名后缀推 mime。fallback "text/plain"。
 * Day 19 范围：3 mime 白名单（contracts.SUPPORTED_INGEST_MIME）
 */
export function detectIngestMime(fileName: string): IngestMime {
  const lower = fileName.toLowerCase()
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown"
  if (lower.endsWith(".json")) return "application/json"
  return "text/plain"
}
