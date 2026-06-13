"use client"

import { useCallback, useState } from "react"

import type { V14RejectReason } from "../promote-modal/use-promote-api"

/**
 * F027 Phase 4 Week 3 Day 12 (AC-P4-4) · BatchPromoteModal 数据 fetch hook
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-4 (line 215-218)
 *   - packages/api/src/routes/phase4/batch-promote.ts (endpoint already wired)
 *
 * 行为:
 *   - useBatchPromote.submit(req) → POST /api/wiki/drafts/batch-promote
 *   - resp 200 (含部分失败): summary { total, success[], failed[] }
 *   - resp 400 validation: 整体 error (校验失败前端应已拦)
 *   - resp 500: 同 error
 *
 * 部分失败语义:
 *   - HTTP 200 即使 failed.length > 0 — caller 看 failed 数组判断 partial failure
 *   - 报告 modal 渲染 success: N / failed: M (含 auditReject)
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"

// ── contract types (mirror routes/phase4/batch-promote.ts) ────────────────────

export type PromoteStatus =
  | "ok"
  | "audit_rejected"
  | "denied_acl"
  | "lease_expired"
  | "src_not_found"
  | "dest_exists"
  | "path_invalid"
  | "internal"

export interface BatchPromoteItem {
  srcDraftPath: string
  destWikiPath: string
}

export interface BatchPromoteRequest {
  items: readonly BatchPromoteItem[]
  callerAlias: string
  reason: string
  taintedSourceFields?: readonly string[]
  sourceMessageIds?: string[]
}

export interface BatchPromoteSuccessEntry {
  srcDraftPath: string
  destWikiPath: string
  finalPath: string
  eventId: number
}

export interface BatchPromoteFailureEntry {
  srcDraftPath: string
  destWikiPath: string
  status: PromoteStatus | "lease_held"
  error: string
  auditReject?: V14RejectReason
}

export interface BatchPromoteSummary {
  ok: true
  total: number
  success: BatchPromoteSuccessEntry[]
  failed: BatchPromoteFailureEntry[]
}

export interface BatchPromoteGenericError {
  ok: false
  code: string
  error?: string
}

export type BatchPromoteResponse = BatchPromoteSummary | BatchPromoteGenericError

// ── useBatchPromote ──────────────────────────────────────────────────────────

/** 补丁#3（小孙进度条）：分批提交进度 — done = 已提交 items 数，total = 总 items 数。 */
export interface BatchPromoteProgress {
  done: number
  total: number
}

export interface UseBatchPromoteReturn {
  data: BatchPromoteSummary | null
  isLoading: boolean
  error: string | null
  /** 分批进行中的进度（提交开始置 {0,total}，每片完成累加；reset/未提交为 null）。 */
  progress: BatchPromoteProgress | null
  submit: (req: BatchPromoteRequest) => Promise<void>
  reset: () => void
}

/** 后端单次上限（mirror routes/phase4/batch-promote MAX_BATCH_ITEMS=50；>50 → 400）。 */
const MAX_BATCH_ITEMS = 50

export function useBatchPromote(): UseBatchPromoteReturn {
  const [data, setData] = useState<BatchPromoteSummary | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<BatchPromoteProgress | null>(null)

  const submit = useCallback(async (req: BatchPromoteRequest) => {
    setIsLoading(true)
    setError(null)
    setData(null)
    // 补丁#3（小孙进度条）：起始 {done:0, total}，每片完成后累加该片 items 数。
    const total = req.items.length
    setProgress({ done: 0, total })
    // F027 全选三件套：>50 items 按 50 切片顺序提交（全选 57+ 篇单次必 400）。
    // 整体失败（4xx/5xx/网络）中断后续分片，但已完成分片的结果保留进 data——
    // promote 是已发生事实，必须如实展示，error 同时置位提示剩余未提交。
    const merged: BatchPromoteSummary = { ok: true, total: 0, success: [], failed: [] }
    let firstError: string | null = null
    let done = 0
    try {
      for (let i = 0; i < req.items.length; i += MAX_BATCH_ITEMS) {
        const chunk = req.items.slice(i, i + MAX_BATCH_ITEMS)
        const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/batch-promote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...req, items: chunk }),
        })
        const raw = (await resp.json()) as BatchPromoteResponse
        if (!raw.ok) {
          firstError = `${raw.code}: ${raw.error ?? "batch promote failed"}`
          break
        }
        merged.total += raw.total
        merged.success.push(...raw.success)
        merged.failed.push(...raw.failed)
        done += chunk.length
        setProgress({ done, total })
      }
    } catch (err) {
      firstError = (err as Error).message ?? "network error"
    } finally {
      if (merged.total > 0) setData(merged)
      if (firstError) setError(firstError)
      setIsLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setProgress(null)
    setIsLoading(false)
  }, [])

  return { data, isLoading, error, progress, submit, reset }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * 由 src draft 路径推测 dest wiki 路径默认值。
 *
 * 规则:
 *   - `wiki/concepts/draft/_auto/rag.md` → `wiki/concepts/rag.md`
 *   - `wiki/methods/draft/x.md`          → `wiki/methods/x.md`
 *   - `wiki/concepts/_drafts/x.md`       → `wiki/concepts/x.md`
 *
 * 抽出 path 中 `/draft/` 或 `/_drafts/` 段及其后续 bucket 子目录到文件层级，
 * 直接拼接根类目 + 文件名。Caller 可手动编辑。
 */
export function suggestDestWikiPath(srcDraftPath: string): string {
  const normalized = srcDraftPath.replace(/\\/g, "/")
  // 找 `/draft/` 或 `/_drafts/` 段位置
  const draftIdx = normalized.indexOf("/draft/")
  const _draftsIdx = normalized.indexOf("/_drafts/")
  const idx = draftIdx >= 0 ? draftIdx : _draftsIdx
  if (idx < 0) return srcDraftPath // 不像 draft path，原样返
  const prefix = normalized.slice(0, idx) // 'wiki/concepts'
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1)
  return `${prefix}/${fileName}`
}
