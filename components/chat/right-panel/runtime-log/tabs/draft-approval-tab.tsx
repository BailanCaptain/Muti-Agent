"use client"

import { useCallback, useMemo, useState } from "react"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { BatchPromoteModal } from "../batch-promote-modal/batch-promote-modal"
import { PromoteModal } from "../promote-modal/promote-modal"
import {
  type DraftOrigin,
  type DraftSummary,
  type DraftType,
  useDraftsData,
} from "./draft-approval/use-drafts-data"

/**
 * F027 Phase 3-4 (AC-P3-2 + AC-P4-1 + AC-P4-3 + AC-P4-4) · DraftApprovalTab
 *
 * 真相源：
 *   - V16.5 chap 18 line 1952 (DraftApprovalTab → GET /api/wiki/drafts)
 *   - feature.md plan §3 line 48 (Phase 3 只读列表 + Phase 4 加 promote)
 *   - GET /api/wiki/drafts (Phase 3 Week 1 Day 3 done)
 *   - PromoteModal (Phase 4 Day 8 done) + POST /api/wiki/drafts/promote (Day 7 done)
 *   - BatchPromoteModal (Phase 4 Week 3 Day 12 done) + POST /api/wiki/drafts/batch-promote (Day 11)
 *
 * Phase 4 Day 12 (AC-P4-4 批量审批):
 *   - 每 row 加 multi-select checkbox + tab 级 selected: Set<path>
 *   - Header 显示 selected.size + [批量审批 N 份] 按钮 (enabled when ≥1 selected)
 *   - 点 [批量审批] → BatchPromoteModal (传 selected rows)
 *   - 决策: KB tab list 在 AC-P4-9 b Week 4 才接入，先在 draft-approval 落地
 *
 * 不做（Day 12 范围外）:
 *   - [Demote] 按钮 (wiki → draft 反向，KB list 接入后做)
 *   - [Rollback] 按钮 (history preview)
 */

/**
 * callerAlias 来源 (同 knowledge-base-tab.tsx / composer.tsx pattern — Phase 4 未拍 user session)
 */
function getCurrentUserAlias(): string {
  return process.env.NEXT_PUBLIC_USER_ALIAS ?? "小孙"
}

export function DraftApprovalTab() {
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)
  const { data, isLoading, error, refetch } = useDraftsData({
    enabled: activeLvl2 === "draft-approval",
  })

  const [promotingDraft, setPromotingDraft] = useState<DraftSummary | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState(false)

  const handlePromote = useCallback((draft: DraftSummary) => {
    setPromotingDraft(draft)
  }, [])

  const handleModalClose = useCallback(() => {
    setPromotingDraft(null)
  }, [])

  const handlePromoteSuccess = useCallback(() => {
    // Promote 成功 → src draft 已 unlink, dest wiki 已写 → refetch drafts list 刷新
    refetch()
    setPromotingDraft(null)
  }, [refetch])

  const handleToggleSelect = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleOpenBatch = useCallback(() => {
    setBatchOpen(true)
  }, [])

  const handleBatchClose = useCallback(() => {
    setBatchOpen(false)
  }, [])

  const handleBatchComplete = useCallback(() => {
    refetch()
    setSelectedPaths(new Set())
  }, [refetch])

  // 多选 rows 给 BatchPromoteModal 用
  const batchRows = useMemo(() => {
    if (selectedPaths.size === 0) return []
    return data.drafts
      .filter((d) => selectedPaths.has(d.path))
      .map((d) => ({ srcDraftPath: d.path, displayTitle: d.title }))
  }, [data.drafts, selectedPaths])

  return (
    <>
      <div className="flex flex-col gap-2 p-3 text-xs" data-testid="draft-approval-tab">
        <Header
          total={data.total}
          selectedCount={selectedPaths.size}
          isLoading={isLoading}
          error={error}
          onOpenBatch={handleOpenBatch}
        />
        <DraftList
          drafts={data.drafts}
          selectedPaths={selectedPaths}
          onPromote={handlePromote}
          onToggleSelect={handleToggleSelect}
        />
      </div>
      <PromoteModal
        open={promotingDraft !== null}
        srcDraftPath={promotingDraft?.path ?? null}
        callerAlias={getCurrentUserAlias()}
        onClose={handleModalClose}
        onPromoteSuccess={handlePromoteSuccess}
      />
      <BatchPromoteModal
        open={batchOpen}
        rows={batchRows}
        callerAlias={getCurrentUserAlias()}
        onClose={handleBatchClose}
        onBatchComplete={handleBatchComplete}
      />
    </>
  )
}

function Header({
  total,
  selectedCount,
  isLoading,
  error,
  onOpenBatch,
}: {
  total: number
  selectedCount: number
  isLoading: boolean
  error: string | null
  onOpenBatch: () => void
}) {
  return (
    <div
      className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2 py-1.5"
      data-testid="draft-approval-header"
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        审批待办 · {total} draft
        {selectedCount > 0 ? `（已选 ${selectedCount}）` : "（勾选多份后可批量审批）"}
      </div>
      <div className="flex items-center gap-2">
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={onOpenBatch}
            className="rounded bg-purple-600 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-purple-700"
            data-testid="draft-approval-batch-button"
            title="对已选中的 draft 批量 promote (共用 reason，部分失败留原位)"
          >
            批量审批 {selectedCount} 份
          </button>
        )}
        {isLoading && (
          <span className="text-[10px] text-slate-400" data-testid="draft-approval-loading">
            ⏳
          </span>
        )}
        {error && (
          <span
            className="text-[10px] text-red-500"
            data-testid="draft-approval-error"
            title={error}
          >
            ⚠ 加载失败
          </span>
        )}
      </div>
    </div>
  )
}

function DraftList({
  drafts,
  selectedPaths,
  onPromote,
  onToggleSelect,
}: {
  drafts: DraftSummary[]
  selectedPaths: Set<string>
  onPromote: (draft: DraftSummary) => void
  onToggleSelect: (path: string) => void
}) {
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
          <DraftRow
            draft={d}
            selected={selectedPaths.has(d.path)}
            onPromote={onPromote}
            onToggleSelect={onToggleSelect}
          />
        </li>
      ))}
    </ul>
  )
}

function DraftRow({
  draft,
  selected,
  onPromote,
  onToggleSelect,
}: {
  draft: DraftSummary
  selected: boolean
  onPromote: (draft: DraftSummary) => void
  onToggleSelect: (path: string) => void
}) {
  return (
    <div
      className="rounded border border-slate-200 bg-white px-2 py-1.5 hover:border-slate-300"
      data-testid={`draft-approval-row-${draft.path}`}
      data-path={draft.path}
      data-type={draft.type}
      data-origin={draft.origin}
      data-selected={selected ? "true" : "false"}
    >
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 truncate flex-1 cursor-pointer">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(draft.path)}
            className="shrink-0"
            aria-label={`select ${draft.path}`}
            data-testid={`draft-approval-checkbox-${draft.path}`}
          />
          <span
            className="truncate font-medium text-[11px] text-slate-700"
            title={draft.path}
          >
            {draft.title}
          </span>
        </label>
        <span className="shrink-0 text-[9px] text-slate-400" title={draft.mtime}>
          {formatRelative(draft.mtime)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        <Badge label={draft.type} kind="type" value={draft.type} />
        <Badge label={originLabel(draft.origin)} kind="origin" value={draft.origin} />
        <button
          type="button"
          onClick={() => onPromote(draft)}
          className="ml-auto rounded bg-blue-600 px-2 py-0.5 text-[9px] font-medium text-white hover:bg-blue-700"
          data-testid={`draft-approval-promote-${draft.path}`}
          title="提升此 draft 到正式 wiki path (走 V14 二次审计)"
        >
          Promote
        </button>
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
