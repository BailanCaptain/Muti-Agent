"use client"

import { useEffect, useRef, useState } from "react"

import { type DemoteSuccess, useDemoteApi } from "./use-demote-api"

/**
 * F027 Phase 4 AC-P4-3 (a)(d) (codex Week 5 j2 FAIL Red→Green) · DemoteModal
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-3 (d):
 *     "DemoteModal: 选 reason → POST /api/wiki/<path>/demote → mv 回 _drafts/ + 写
 *      wiki_events action='demote'"
 *   - 复用 PromoteModal pattern (compose / submitting / report)
 *
 * UI:
 *   1. Source wiki path (只读, 来自 props.srcWikiPath)
 *   2. Reason textarea (必填)
 *   3. [取消] [Demote 拒绝] 按钮
 *   4. submitting → loading
 *   5. report → success (显示 rejectedPath) / error (显示 code + error)
 */

export interface DemoteModalProps {
  open: boolean
  srcWikiPath: string | null
  callerAlias: string
  sourceMessageIds?: string[]
  onClose: () => void
  onDemoteSuccess?: (response: DemoteSuccess) => void
}

export function DemoteModal({
  open,
  srcWikiPath,
  callerAlias,
  sourceMessageIds,
  onClose,
  onDemoteSuccess,
}: DemoteModalProps) {
  const [reason, setReason] = useState<string>("")
  const demoteHook = useDemoteApi()

  // notify onDemoteSuccess once per success object (notifiedRef pattern, 跟 PromoteModal 一致)
  const notifiedRef = useRef<DemoteSuccess | null>(null)
  useEffect(() => {
    if (!demoteHook.data) {
      notifiedRef.current = null
      return
    }
    if (notifiedRef.current === demoteHook.data) return
    notifiedRef.current = demoteHook.data
    onDemoteSuccess?.(demoteHook.data)
  }, [demoteHook.data, onDemoteSuccess])

  // reset state on close
  const isFirstOpenRef = useRef(true)
  useEffect(() => {
    if (!open) {
      isFirstOpenRef.current = true
      return
    }
    if (!isFirstOpenRef.current) return
    isFirstOpenRef.current = false
    setReason("")
    demoteHook.reset()
  }, [open, demoteHook.reset])

  const reasonValid = reason.trim().length > 0
  const canDemote = !demoteHook.isLoading && !!srcWikiPath && reasonValid && !demoteHook.data

  const handleClose = () => {
    demoteHook.reset()
    setReason("")
    onClose()
  }

  const handleDemote = async () => {
    if (!srcWikiPath || !canDemote) return
    await demoteHook.demote({
      srcWikiPath,
      callerAlias,
      reason,
      sourceMessageIds,
    })
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="demote-modal-title"
    >
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-h-[80vh] overflow-y-auto p-6">
        <h2 id="demote-modal-title" className="text-lg font-semibold mb-4">
          Demote wiki entity → _rejected/
        </h2>

        {/* §1 Source wiki path */}
        <div className="mb-4 text-sm text-gray-600">
          <div className="font-medium text-gray-800">Source wiki path:</div>
          <div className="font-mono text-xs break-all">{srcWikiPath ?? "(none)"}</div>
        </div>

        {/* §2 Reason */}
        <div className="mb-4">
          <label htmlFor="demote-reason" className="block text-sm font-medium mb-1">
            Reason
          </label>
          <textarea
            id="demote-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="为什么 demote 这个 entity? (会写入 wiki_events.reason, 内容会 mv 到 wiki/_rejected/)"
            rows={2}
            className="w-full px-3 py-2 border rounded text-sm"
            disabled={!!demoteHook.data}
          />
        </div>

        {/* §3 Success report */}
        {demoteHook.data ? (
          <div className="mb-4 p-3 border border-green-300 rounded bg-green-50 text-sm text-green-700">
            <div className="font-medium">Demote 成功</div>
            <div className="text-xs mt-1 font-mono break-all">
              已 mv 到: {demoteHook.data.rejectedPath}
            </div>
            <div className="text-xs mt-1">wiki_events.id = {demoteHook.data.eventId}</div>
          </div>
        ) : null}

        {/* §4 Error */}
        {demoteHook.error ? (
          <div className="mb-4 p-3 border border-red-300 rounded bg-red-50 text-sm text-red-700">
            <div className="font-medium">Demote 失败</div>
            <div className="text-xs mt-1 font-mono break-all">{demoteHook.error}</div>
          </div>
        ) : null}

        {/* §5 Buttons */}
        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
          >
            {demoteHook.data ? "关闭" : "取消"}
          </button>
          {!demoteHook.data && (
            <button
              type="button"
              onClick={handleDemote}
              disabled={!canDemote}
              className="px-4 py-2 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {demoteHook.isLoading ? "Demoting..." : "Demote 拒绝"}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
