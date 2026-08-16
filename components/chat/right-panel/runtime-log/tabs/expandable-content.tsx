"use client"

import { getApiHttpBaseUrl } from "@/lib/api-endpoints"
import { AlertTriangle, ChevronDown, ChevronRight, Hourglass } from "lucide-react"
import { useEffect, useRef, useState } from "react"

/**
 * F027 · KB tab「展开看全文」共享组件 —— 审批 / 警告列表只给截断摘要（100 / 120 字），
 * 判编译质量看不全。本组件按需 lazy fetch 单篇全文并渲染为可滚动 <pre>：
 *   - draft   → GET /api/wiki/drafts/content?path=<draftPath>
 *   - warning → GET /api/wiki/warnings/content?path=<warningPath>
 * 用 <pre>（whitespace-pre-wrap）保真 frontmatter + 结构（不走 markdown 渲染——判编译质量要看原文）。
 * 首次展开才请求（省流），收起保留缓存（再展开不重复 fetch），三态 loading/error/content fail-soft。
 * 后端路径围栏：draft = safeWikiPath + draft 子树；warning = basename 白名单（见 drafts.ts / wiki-meta.ts）。
 */

const API_BASE_URL = getApiHttpBaseUrl()

const ENDPOINT_BY_KIND = {
  draft: "/api/wiki/drafts/content",
  warning: "/api/wiki/warnings/content",
} as const

export type ExpandableContentKind = keyof typeof ENDPOINT_BY_KIND

export function ExpandableContent({
  contentPath,
  kind,
}: {
  contentPath: string
  kind: ExpandableContentKind
}) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 卸载守卫（对齐本仓库 use-drafts-data / use-wiki-meta-data 的 cancelled 模式）：
  // fetch 在点击回调里发起、无 effect cleanup，组件卸载后 promise resolve 仍 setState 会告警/泄漏。
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const toggle = () => {
    const next = !open
    setOpen(next)
    // 仅在「首次展开 + 尚无缓存 + 未在加载」时请求
    if (!next || content !== null || isLoading) return
    setIsLoading(true)
    setError(null)
    const url = `${API_BASE_URL}${ENDPOINT_BY_KIND[kind]}?path=${encodeURIComponent(contentPath)}`
    fetch(url, { method: "GET", headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        return (await res.json()) as { content?: string }
      })
      .then((json) => {
        if (!mountedRef.current) return
        setContent(json.content ?? "")
        setIsLoading(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setError(err instanceof Error ? err.message : String(err))
        setIsLoading(false)
      })
  }

  return (
    <div className="mt-1" data-testid={`expandable-${contentPath}`}>
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1 text-micro text-blue-600 hover:text-blue-800 hover:underline"
        data-testid={`expand-toggle-${contentPath}`}
        aria-expanded={open}
      >
        {open ? (
          <>
            <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            收起全文
          </>
        ) : (
          <>
            <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
            展开看全文
          </>
        )}
      </button>
      {open && (
        <div className="mt-1" data-testid={`expand-panel-${contentPath}`}>
          {isLoading && (
            <span
              className="inline-flex items-center gap-1 text-micro text-slate-400"
              data-testid={`expand-loading-${contentPath}`}
            >
              <Hourglass className="h-3 w-3 shrink-0" aria-hidden="true" />
              加载全文…
            </span>
          )}
          {error && (
            <span
              className="inline-flex items-start gap-1 text-micro text-red-500"
              data-testid={`expand-error-${contentPath}`}
              title={error}
            >
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span>加载失败：{error}</span>
            </span>
          )}
          {content !== null && !isLoading && !error && (
            <pre
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-2 text-micro leading-relaxed text-slate-700"
              data-testid={`expand-content-${contentPath}`}
            >
              {content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
