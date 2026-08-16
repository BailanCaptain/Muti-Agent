"use client"

import { SkeletonLines } from "@/components/chat/skeleton"
import { A2ATreeView } from "@/components/debug/a2a-tree-view"
import type { DebugA2ACallRow, DebugA2ASessionTree } from "@/components/debug/a2a-types"
import { useA2ADrawerStore } from "@/components/stores/a2a-drawer-store"
import { getApiHttpBaseUrl } from "@/lib/api-endpoints"
import { AlertTriangle, Link2, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

/**
 * F027 Phase 3 Week 4 Day 20 (AC-P3-5 + AC-P3-4) · a2a in-place drawer
 *
 * 真相源：
 *   - V16.5 chap 18 line 1970-1986 (V16.5.2 viewfinder §4 + prompt-inspector wake-trigger
 *     共用同一 drawer + 同一 fetch GET /debug/a2a?root=callId, 复用 F026 <A2ATreeView>)
 *   - feature.md AC-P3-4/5 (click pill → in-place drawer, 不跳 /debug/a2a page)
 *
 * 行为:
 *   - useA2ADrawerStore.callId 触发 open
 *   - fetch GET /debug/a2a?root=<callId> 拿 tree data
 *   - 渲染 F026 <A2ATreeView> (复用)
 *   - close: ✕ / overlay click / Escape → useA2ADrawerStore.closeDrawer()
 *
 * 接 backend 契约 (packages/api/src/routes/debug-a2a.ts line 42-43):
 *   - GET /debug/a2a?root=<callId> → { kind: "tree", rootCallId, calls: CallRow[] }
 *   - tree shape 匹配 components/debug/a2a-types.ts DebugA2ASessionTree
 */

const API_BASE_URL = getApiHttpBaseUrl()

interface DebugA2ATreeResponse {
  kind: "tree"
  rootCallId: string
  calls: DebugA2ACallRow[]
}

export function A2ACallDrawer() {
  const callId = useA2ADrawerStore((s) => s.callId)
  const source = useA2ADrawerStore((s) => s.source)
  const closeDrawer = useA2ADrawerStore((s) => s.closeDrawer)

  const [tree, setTree] = useState<DebugA2ASessionTree | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // fetch tree on open
  useEffect(() => {
    if (!callId) {
      setTree(null)
      setError(null)
      return
    }
    let cancelled = false
    setIsLoading(true)
    setError(null)
    fetch(`${API_BASE_URL}/debug/a2a?root=${encodeURIComponent(callId)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        return res.json() as Promise<DebugA2ATreeResponse>
      })
      .then((json) => {
        if (cancelled) return
        setTree({ rootCallId: json.rootCallId, calls: json.calls })
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
        setTree(null)
      })
    return () => {
      cancelled = true
    }
  }, [callId])

  // Escape close (a11y)
  useEffect(() => {
    if (!callId) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        closeDrawer()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [callId, closeDrawer])

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) closeDrawer()
    },
    [closeDrawer],
  )

  if (!callId) return null

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-end bg-black/30 p-4"
      data-testid="a2a-drawer-overlay"
      onClick={handleOverlayClick}
    >
      <aside
        className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-xl"
        data-testid="a2a-drawer"
        data-call-id={callId}
        data-source={source ?? ""}
        role="dialog"
        aria-modal="true"
        aria-labelledby="a2a-drawer-title"
      >
        <header className="flex items-center justify-between border-slate-200 border-b px-4 py-2.5">
          <h2
            id="a2a-drawer-title"
            className="flex items-center gap-1 font-semibold text-slate-800 text-sm"
          >
            <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            a2a call tree: <span className="font-mono text-caption">{callId}</span>
          </h2>
          <button
            type="button"
            onClick={closeDrawer}
            data-testid="a2a-drawer-close"
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            aria-label="关闭"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-3 py-2 text-xs">
          {isLoading && (
            // F039 AC5: 树形内容加载给 skeleton 占位
            <div data-testid="a2a-drawer-loading">
              <SkeletonLines lines={5} />
            </div>
          )}
          {error && (
            <div
              className="flex items-start gap-1 rounded border border-red-200 bg-red-50 p-2 text-caption text-red-600"
              data-testid="a2a-drawer-error"
            >
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span>加载失败：{error}</span>
            </div>
          )}
          {!isLoading && !error && tree && tree.calls.length > 0 && (
            <div data-testid="a2a-drawer-tree">
              <A2ATreeView tree={tree} />
            </div>
          )}
          {!isLoading && !error && tree && tree.calls.length === 0 && (
            <div
              className="rounded border border-dashed border-slate-300 p-3 text-micro text-slate-400"
              data-testid="a2a-drawer-empty"
            >
              call tree 为空（callRegistry 内无此 root 或已过期）
            </div>
          )}
        </div>
        <footer className="border-slate-200 border-t bg-slate-50 px-4 py-2 text-micro text-slate-500">
          {source && (
            <span>
              from: <span className="font-mono">{source}</span>
            </span>
          )}
          <span className="ml-3">数据源: GET /debug/a2a?root=… (F026 thin wrapper)</span>
        </footer>
      </aside>
    </div>
  )
}
