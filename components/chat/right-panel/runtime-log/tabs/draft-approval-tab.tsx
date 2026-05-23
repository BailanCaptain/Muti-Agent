"use client"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import {
  type DraftOrigin,
  type DraftSummary,
  type DraftType,
  useDraftsData,
} from "./draft-approval/use-drafts-data"

/**
 * F027 Phase 3 Week 4 Day 18-19 (AC-P3-2 子需求) · DraftApprovalTab 真实数据
 *
 * 真相源：
 *   - V16.5 chap 18 line 1952 (DraftApprovalTab → GET /api/wiki/drafts)
 *   - feature.md plan §3 line 48 (Phase 3 只读列表 + Phase 4 加 promote)
 *   - GET /api/wiki/drafts (Phase 3 Week 1 Day 3 done)
 *
 * 实施:
 *   - 读取 drafts 列表（sorted by mtime DESC）
 *   - 每行渲染：title / type badge / origin badge / mtime relative / summary 100 字截断
 *   - empty / loading / error 三态
 *   - enabled wire = activeLvl2 === "draft-approval" (防 always-render 启动并发 fetch)
 *
 * 不做（Phase 4 范围）：
 *   - promote / demote / 批量审批按钮（feature.md AC-P4-1/3/4）
 */
export function DraftApprovalTab() {
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)
  const { data, isLoading, error } = useDraftsData({
    enabled: activeLvl2 === "draft-approval",
  })

  return (
    <div className="flex flex-col gap-2 p-3 text-xs" data-testid="draft-approval-tab">
      <Header total={data.total} isLoading={isLoading} error={error} />
      <DraftList drafts={data.drafts} />
    </div>
  )
}

function Header({
  total,
  isLoading,
  error,
}: {
  total: number
  isLoading: boolean
  error: string | null
}) {
  return (
    <div
      className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2 py-1.5"
      data-testid="draft-approval-header"
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        审批待办 · {total} draft（Phase 3 只读 · Phase 4 加 promote）
      </div>
      {isLoading && (
        <span className="text-[10px] text-slate-400" data-testid="draft-approval-loading">
          ⏳
        </span>
      )}
      {error && (
        <span className="text-[10px] text-red-500" data-testid="draft-approval-error" title={error}>
          ⚠ 加载失败
        </span>
      )}
    </div>
  )
}

function DraftList({ drafts }: { drafts: DraftSummary[] }) {
  if (drafts.length === 0) {
    return (
      <div
        className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-[10px] text-slate-400"
        data-testid="draft-approval-empty"
      >
        无 draft（wiki/concepts/draft/ 空 或 endpoint fail）
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5" data-testid="draft-approval-list">
      {drafts.map((d) => (
        <li key={d.path}>
          <DraftRow draft={d} />
        </li>
      ))}
    </ul>
  )
}

function DraftRow({ draft }: { draft: DraftSummary }) {
  return (
    <div
      className="rounded border border-slate-200 bg-white px-2 py-1.5 hover:border-slate-300"
      data-testid={`draft-approval-row-${draft.path}`}
      data-path={draft.path}
      data-type={draft.type}
      data-origin={draft.origin}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-[11px] text-slate-700" title={draft.path}>
          {draft.title}
        </span>
        <span className="shrink-0 text-[9px] text-slate-400" title={draft.mtime}>
          {formatRelative(draft.mtime)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-1">
        <Badge label={draft.type} kind="type" value={draft.type} />
        <Badge label={originLabel(draft.origin)} kind="origin" value={draft.origin} />
      </div>
      {draft.summary && (
        <div className="mt-1 text-[10px] text-slate-500" title={draft.summary}>
          {truncate(draft.summary, 100)}
        </div>
      )}
    </div>
  )
}

function Badge({
  label,
  kind,
  value,
}: {
  label: string
  kind: "type" | "origin"
  value: string
}) {
  const colorClass =
    kind === "type" ? typeColorClass(value as DraftType) : originColorClass(value as DraftOrigin)
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] ${colorClass}`}
      data-testid={`draft-approval-badge-${kind}-${value}`}
    >
      {label}
    </span>
  )
}

function typeColorClass(type: DraftType): string {
  switch (type) {
    case "feature":
      return "border-blue-300 bg-blue-50 text-blue-700"
    case "bug":
      return "border-red-300 bg-red-50 text-red-600"
    case "lesson":
      return "border-amber-300 bg-amber-50 text-amber-700"
    case "concept":
      return "border-green-300 bg-green-50 text-green-700"
    case "wiki-memory":
      return "border-purple-300 bg-purple-50 text-purple-700"
    case "session-archive":
      return "border-slate-300 bg-slate-50 text-slate-600"
    default:
      return "border-slate-300 bg-slate-50 text-slate-600"
  }
}

function originColorClass(origin: DraftOrigin): string {
  switch (origin) {
    case "user-drop":
      return "border-sky-300 bg-sky-50 text-sky-700"
    case "auto":
      return "border-slate-300 bg-slate-50 text-slate-600"
    case "backfill":
      return "border-violet-300 bg-violet-50 text-violet-700"
    case "expired":
      return "border-orange-300 bg-orange-50 text-orange-700"
    default:
      return "border-slate-300 bg-slate-50 text-slate-600"
  }
}

function originLabel(origin: DraftOrigin): string {
  switch (origin) {
    case "user-drop":
      return "user-drop"
    case "auto":
      return "auto (DocsWatcher)"
    case "backfill":
      return "backfill"
    case "expired":
      return "expired"
    default:
      return origin
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  // 范-r1 P3 fix: clamp delta ≥ 0 防 backend mtime 略超 browser clock 时
  // UI 显示 `-5s 前` (clock skew 边界 glitch)
  const deltaSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (deltaSec < 60) return `${deltaSec}s 前`
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m 前`
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h 前`
  return `${Math.floor(deltaSec / 86400)}d 前`
}
