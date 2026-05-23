"use client"

import { useCallback, useRef, useState } from "react"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { IngestModal, type IngestModalFile } from "../ingest-modal/ingest-modal"
import {
  type IndexViewSummary,
  useIndexData,
} from "./wiki-meta/use-wiki-meta-data"

/**
 * F027 Phase 3 Week 4 Day 19b-1 (AC-P3-6 入口 B) · KnowledgeBaseTab
 *
 * 真相源：
 *   - V16.5 chap 18 line 1954 (KnowledgeBaseTab → GET /api/wiki/index 引用)
 *   - V16.5 chap 22 line 2172-2199 (wiki/index.md + wiki/index/*.md 派生视图层级)
 *   - V16.5 chap 25 line 2535-2537 入口 B [+ Drop 资料] (KB tab 顶部紫色按钮 → 文件选择对话框 → IngestModal)
 *   - plan v3.2 patch (2026-05-23 小孙拍 B)：本 tab 列表数据推 Phase 4，按钮启用是 Day 19b-1 (AC-P3-6 入口 B)
 *
 * Day 19b-1 范围：
 *   - 启用 [+ Drop 资料] 紫色按钮 (V16.5 chap 25 wireframe 配色)
 *   - 点击 → 隐藏 input[type=file] picker → 读 file content → 打开 IngestModal
 *   - 文件类型限：.md / .markdown / .json / .txt (mime detect 在 IngestModal hook)
 *   - 单文件 only (multi-drop cross-correlation Phase 4 接 chained 防误检 series_id)
 *
 * 不做 (Day 19b-1 范围):
 *   - wiki/index 列表数据接入 (plan v3.2 推 Phase 4)
 *   - 多文件批量 drop (Phase 4 接 series_id)
 */

const ACCEPTED_INGEST_EXTENSIONS = [".md", ".markdown", ".json", ".txt"]
const MAX_INGEST_BYTES = 1_048_576 // 1MB (与 contracts MAX_INGEST_CONTENT_BYTES 一致)

/**
 * F027 Phase 3 Day 19b-1 · callerAlias 来源
 *
 * Phase 3 前端无 user session store（小孙是 dev/preview 真人用户）。
 * 来源策略 (按优先级)：
 *   1. ENV NEXT_PUBLIC_USER_ALIAS (dev/preview 端 .env.local 可设)
 *   2. "小孙" hardcode fallback (与 V16.5 chap 25 wireframe 一致 — 真人 user)
 *
 * Phase 4 接真 user session 时移除此 hack (V16.5 chap 25 未拍 user model)。
 */
function getCurrentUserAlias(): string {
  return process.env.NEXT_PUBLIC_USER_ALIAS ?? "小孙"
}

export function KnowledgeBaseTab() {
  const activeLvl2 = useRuntimeLogStore((s) => s.activeLvl2)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [modalFile, setModalFile] = useState<IngestModalFile | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const indexData = useIndexData({ enabled: activeLvl2 === "knowledge-base" })

  const handleDropClick = useCallback(() => {
    setPickerError(null)
    fileInputRef.current?.click()
  }, [])

  const handleFilePicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // 允许同名文件重选
    if (!file) return

    // 类型检查 (按 file.name 后缀，与 IngestModal detectIngestMime 一致)
    const lower = file.name.toLowerCase()
    if (!ACCEPTED_INGEST_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      setPickerError(`不支持的文件类型：${file.name} (限 .md / .markdown / .json / .txt)`)
      return
    }
    if (file.size > MAX_INGEST_BYTES) {
      setPickerError(`文件过大：${file.name} (${Math.round(file.size / 1024)}KB > 1MB)`)
      return
    }

    try {
      const content = await file.text()
      setModalFile({
        name: file.name,
        content,
        sizeBytes: file.size,
      })
    } catch (err) {
      setPickerError(`读取文件失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const handleModalClose = useCallback(() => {
    setModalFile(null)
  }, [])

  const handleCommitSuccess = useCallback(() => {
    // Day 19b-1 范围：commit 成功不主动 close，让用户看 finalPath。
    // 未来可触发 wiki/drafts 列表 invalidate（plan v3.2 列表推 Phase 4，暂不接）。
  }, [])

  return (
    <>
      <div
        className="flex flex-col gap-2 p-3 text-xs text-slate-500"
        data-testid="knowledge-base-tab"
      >
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-slate-400">
            知识库 · Day 19b-1 [+ Drop] 启用 · 列表 Phase 4 接入
          </div>
          <button
            type="button"
            onClick={handleDropClick}
            className="rounded bg-violet-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-violet-700"
            title="选择文件 (.md / .markdown / .json / .txt, ≤ 1MB) 打开 IngestModal"
            data-testid="kb-drop-button"
          >
            + Drop 资料
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.json,.txt,text/markdown,text/plain,application/json"
            className="hidden"
            onChange={handleFilePicked}
            data-testid="kb-file-input"
          />
        </div>
        {pickerError && (
          <div
            className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-600"
            data-testid="kb-picker-error"
          >
            ⚠ {pickerError}
          </div>
        )}
        <IndexList
          data={indexData.data}
          isLoading={indexData.isLoading}
          error={indexData.error}
        />
      </div>
      <IngestModal
        open={modalFile !== null}
        file={modalFile}
        callerAlias={getCurrentUserAlias()}
        onClose={handleModalClose}
        onCommitSuccess={handleCommitSuccess}
      />
    </>
  )
}

function IndexList({
  data,
  isLoading,
  error,
}: {
  data: { views: IndexViewSummary[]; total: number }
  isLoading: boolean
  error: string | null
}) {
  if (isLoading) {
    return (
      <div
        className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-[10px] text-slate-400"
        data-testid="kb-loading"
      >
        ⏳ 加载派生视图…
      </div>
    )
  }
  if (error) {
    return (
      <div
        className="rounded border border-red-300 bg-red-50 p-3 text-[10px] text-red-700"
        data-testid="kb-error"
      >
        ⚠ 加载失败：{error}
      </div>
    )
  }
  if (data.total === 0) {
    return (
      <div
        className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-[10px] text-slate-400"
        data-testid="kb-empty"
      >
        暂无派生视图 (wiki/index/ 空; worktree-preview fixture 应自动 seed)
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5" data-testid="kb-index-list">
      {data.views.map((v) => (
        <li key={v.path}>
          <IndexRow view={v} />
        </li>
      ))}
    </ul>
  )
}

function IndexRow({ view }: { view: IndexViewSummary }) {
  return (
    <div
      className="rounded border border-slate-200 bg-white px-2 py-1.5 hover:border-slate-300"
      data-testid={`kb-index-row-${view.bucket}`}
      data-bucket={view.bucket}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center rounded border border-violet-300 bg-violet-50 px-1.5 py-0.5 font-mono text-[9px] font-medium text-violet-700">
          {view.bucket}
        </span>
        <span className="shrink-0 text-[9px] text-slate-400" title={view.generatedAt ?? ""}>
          {view.generatedAt ? formatRelative(view.generatedAt) : "—"}
        </span>
      </div>
      {view.summary && (
        <div className="mt-1 text-[10px] text-slate-500" title={view.summary}>
          {view.summary.length > 100 ? `${view.summary.slice(0, 100)}…` : view.summary}
        </div>
      )}
    </div>
  )
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return iso
  const deltaSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (deltaSec < 60) return `${deltaSec}s 前`
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m 前`
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h 前`
  return `${Math.floor(deltaSec / 86400)}d 前`
}
