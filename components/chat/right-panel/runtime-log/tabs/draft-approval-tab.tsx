"use client"

import { AlertTriangle, Hourglass, Settings } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { BatchPromoteModal } from "../batch-promote-modal/batch-promote-modal"
import { DemoteModal } from "../demote-modal/demote-modal"
import { PromoteModal } from "../promote-modal/promote-modal"
import { IngestSettingsCard } from "./draft-approval/ingest-settings-card"
import {
  BatchPromoteBanner,
  PromoteJobBadge,
  PromoteRowButton,
  usePromoteJobsAutoRefetch,
  usePromoteOkJobsGc,
} from "./draft-approval/promote-jobs-ui"
import {
  type DraftOrigin,
  type DraftSummary,
  type DraftType,
  useDraftsData,
} from "./draft-approval/use-drafts-data"
import { ExpandableContent } from "./expandable-content"

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
 *
 * Phase 4 Week 5 (codex j2 FAIL Red→Green, AC-P4-3 a/d):
 *   - 每 row 加 [Demote] 按钮 → DemoteModal (mv 到 wiki/_rejected/ + wiki_events action='demote')
 *
 * 不做 (推 F028-2):
 *   - [Rollback] 按钮 (写型 rollback)
 */

/**
 * callerAlias 来源 (同 knowledge-base-tab.tsx / composer.tsx pattern — Phase 4 未拍 user session)
 */
function getCurrentUserAlias(): string {
  return process.env.NEXT_PUBLIC_USER_ALIAS ?? "小孙"
}

export function DraftApprovalTab() {
  const activeLvl2 = useRuntimeLogStore((state) => state.activeLvl2)
  const { data, isLoading, error, hasLoaded, refetch } = useDraftsData({
    enabled: activeLvl2 === "draft-approval",
  })

  const [promotingDraft, setPromotingDraft] = useState<DraftSummary | null>(null)
  const [demotingDraft, setDemotingDraft] = useState<DraftSummary | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [batchOpen, setBatchOpen] = useState(false)
  // F027 promote 后台化：后台任务出 ok → 自动 refetch（成功行消失，无需人工刷新）
  usePromoteJobsAutoRefetch(refetch)
  // 对账式 ok GC：行真消失才清护栏（unlink-fail 兜底见 promote-jobs-ui）。
  // 德彪 r3 P2：门用 hasLoaded——tab 隐藏时 disabled 分支的空列表是「未加载」，
  // 用 !isLoading && !error 会把它当「加载到空」误清护栏。
  usePromoteOkJobsGc(data.drafts, hasLoaded)
  // F027 收录设置卡（小孙拍：编译引擎/模型设置放记忆页面族，不放 agent 配置区）
  const [settingsOpen, setSettingsOpen] = useState(false)

  const handlePromote = useCallback((draft: DraftSummary) => {
    setPromotingDraft(draft)
  }, [])

  const handleDemote = useCallback((draft: DraftSummary) => {
    setDemotingDraft(draft)
  }, [])

  const handlePromoteModalClose = useCallback(() => {
    setPromotingDraft(null)
  }, [])

  const handleDemoteModalClose = useCallback(() => {
    setDemotingDraft(null)
  }, [])

  const handlePromoteSuccess = useCallback(() => {
    // Promote 成功 → src draft 已 unlink, dest wiki 已写 → refetch drafts list 刷新。
    // 补丁#3（小孙「好了没好看不懂」）：**不再 setPromotingDraft(null) 秒关弹窗**——
    // 让 PromoteModal 停在成功面板（显落地路径），用户点「完成」(onClose) 才关。
    refetch()
  }, [refetch])

  const handleDemoteSuccess = useCallback(() => {
    // Demote 成功 → src 已 mv 到 wiki/_rejected/, draft list 应刷新 (虽然 draft list 通常只列 draft/_drafts/)
    refetch()
    setDemotingDraft(null)
  }, [refetch])

  const handleToggleSelect = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // F027 全选三件套（小孙：一个一个点好费劲）：全选 = 勾上当前已加载全部；再点 = 清空。
  const allSelected = data.drafts.length > 0 && data.drafts.every((d) => selectedPaths.has(d.path))
  const handleToggleSelectAll = useCallback(() => {
    setSelectedPaths((prev) => {
      const all = data.drafts.length > 0 && data.drafts.every((d) => prev.has(d.path))
      if (all) return new Set()
      return new Set(data.drafts.map((d) => d.path))
    })
  }, [data.drafts])

  const handleOpenBatch = useCallback(() => {
    setBatchOpen(true)
  }, [])

  const handleBatchClose = useCallback(() => {
    // codex mid-r1 P1 修: clear selection + refetch 推迟到 modal close
    // (handleBatchComplete 仍 open 时清 selectedPaths 会让 batchRows 变 []
    //  → modal effect 重置回 compose phase → 报告 view 被清，用户看不到结果)
    setBatchOpen(false)
    setSelectedPaths(new Set())
    refetch()
  }, [refetch])

  const handleBatchComplete = useCallback(() => {
    // modal 提交完成 — 不动 selectedPaths / refetch，留给 handleBatchClose
    // (保持 modal 在 report phase 显示，直到用户主动关闭)
  }, [])

  // 多选 rows 给 BatchPromoteModal 用
  const batchRows = useMemo(() => {
    if (selectedPaths.size === 0) return []
    return data.drafts
      .filter((d) => selectedPaths.has(d.path))
      .map((d) => ({
        srcDraftPath: d.path,
        displayTitle: d.title,
        suggestedDestPath: d.suggestedDestPath,
      }))
  }, [data.drafts, selectedPaths])

  return (
    <>
      <div className="flex flex-col gap-2 p-3 text-xs" data-testid="draft-approval-tab">
        <Header
          total={data.total}
          visibleCount={data.drafts.length}
          selectedCount={selectedPaths.size}
          allSelected={allSelected}
          isLoading={isLoading}
          error={error}
          onOpenBatch={handleOpenBatch}
          onToggleSelectAll={handleToggleSelectAll}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen((v) => !v)}
        />
        {settingsOpen && <IngestSettingsCard />}
        <BatchPromoteBanner />
        <DraftList
          drafts={data.drafts}
          selectedPaths={selectedPaths}
          onPromote={handlePromote}
          onDemote={handleDemote}
          onToggleSelect={handleToggleSelect}
        />
      </div>
      <PromoteModal
        open={promotingDraft !== null}
        srcDraftPath={promotingDraft?.path ?? null}
        suggestedDestPath={promotingDraft?.suggestedDestPath ?? null}
        callerAlias={getCurrentUserAlias()}
        onClose={handlePromoteModalClose}
        onPromoteSuccess={handlePromoteSuccess}
      />
      <DemoteModal
        open={demotingDraft !== null}
        srcWikiPath={demotingDraft?.path ?? null}
        callerAlias={getCurrentUserAlias()}
        onClose={handleDemoteModalClose}
        onDemoteSuccess={handleDemoteSuccess}
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
  visibleCount,
  selectedCount,
  allSelected,
  isLoading,
  error,
  onOpenBatch,
  onToggleSelectAll,
  settingsOpen,
  onToggleSettings,
}: {
  total: number
  visibleCount: number
  selectedCount: number
  allSelected: boolean
  isLoading: boolean
  error: string | null
  onOpenBatch: () => void
  onToggleSelectAll: () => void
  settingsOpen: boolean
  onToggleSettings: () => void
}) {
  return (
    <div
      className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2 py-1.5"
      data-testid="draft-approval-header"
    >
      <div className="flex items-center gap-1.5 text-micro uppercase tracking-wider text-slate-500">
        {visibleCount > 0 && (
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              // 部分选中 → indeterminate（原生属性只能 ref 设）
              if (el) el.indeterminate = selectedCount > 0 && !allSelected
            }}
            onChange={onToggleSelectAll}
            className="shrink-0 cursor-pointer"
            aria-label="全选当前列表"
            title={allSelected ? "清空选择" : `全选当前 ${visibleCount} 份`}
            data-testid="draft-approval-select-all"
          />
        )}
        审批待办 · {total} draft
        {selectedCount > 0 ? `（已选 ${selectedCount}）` : "（勾选或点左侧全选后可批量审批）"}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleSettings}
          className={`rounded px-1.5 py-0.5 text-micro transition ${
            settingsOpen
              ? "bg-slate-700 text-white"
              : "text-slate-400 hover:bg-slate-200 hover:text-slate-600"
          }`}
          title="收录设置（编译引擎/模型）"
          aria-label="收录设置"
          data-testid="draft-approval-settings-toggle"
        >
          <Settings className="h-3 w-3" aria-hidden="true" />
        </button>
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={onOpenBatch}
            className="rounded bg-purple-600 px-2 py-0.5 text-micro font-medium text-white hover:bg-purple-700"
            data-testid="draft-approval-batch-button"
            title="对已选中的 draft 批量 promote (共用 reason，部分失败留原位)"
          >
            批量审批 {selectedCount} 份
          </button>
        )}
        {isLoading && (
          <span
            className="text-micro text-slate-400"
            data-testid="draft-approval-loading"
            aria-label="加载中"
          >
            <Hourglass className="h-3 w-3" aria-hidden="true" />
          </span>
        )}
        {error && (
          <span
            className="inline-flex items-center gap-1 text-micro text-red-500"
            data-testid="draft-approval-error"
            title={error}
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            加载失败
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
  onDemote,
  onToggleSelect,
}: {
  drafts: DraftSummary[]
  selectedPaths: Set<string>
  onPromote: (draft: DraftSummary) => void
  onDemote: (draft: DraftSummary) => void
  onToggleSelect: (path: string) => void
}) {
  if (drafts.length === 0) {
    return (
      <div
        className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-micro text-slate-400"
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
            onDemote={onDemote}
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
  onDemote,
  onToggleSelect,
}: {
  draft: DraftSummary
  selected: boolean
  onPromote: (draft: DraftSummary) => void
  onDemote: (draft: DraftSummary) => void
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
          <span className="truncate font-medium text-caption text-slate-700" title={draft.path}>
            {draft.title}
          </span>
        </label>
        <span className="shrink-0 text-micro text-slate-400" title={draft.mtime}>
          {formatRelative(draft.mtime)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        <Badge label={draft.type} kind="type" value={draft.type} />
        <Badge label={originLabel(draft.origin)} kind="origin" value={draft.origin} />
        <PromoteJobBadge path={draft.path} />
        <div className="ml-auto flex items-center gap-1">
          <PromoteRowButton draft={draft} onPromote={onPromote} testIdPrefix="draft-approval" />
          <button
            type="button"
            onClick={() => onDemote(draft)}
            className="rounded bg-orange-600 px-2 py-0.5 text-micro font-medium text-white hover:bg-orange-700"
            data-testid={`draft-approval-demote-${draft.path}`}
            title="拒绝此 draft (mv 到 wiki/_rejected/ + 写 wiki_events action='demote')"
          >
            Demote
          </button>
        </div>
      </div>
      {draft.summary && (
        <div className="mt-1 text-micro text-slate-500" title={draft.summary}>
          {truncate(draft.summary, 100)}
        </div>
      )}
      <ExpandableContent contentPath={draft.path} kind="draft" />
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
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-micro ${colorClass}`}
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
