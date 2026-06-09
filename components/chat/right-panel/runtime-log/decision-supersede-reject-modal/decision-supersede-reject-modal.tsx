"use client"

import { useEffect, useRef, useState } from "react"

import {
  type SupersedeRejectAction,
  type SupersedeRejectSuccess,
  useDecisionSupersedeRejectApi,
} from "./use-decision-supersede-reject-api"

/**
 * F027 final-vision P1-1 · UnresolvedDecisionModal
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-9 c 场景 3 step 3.5-3.6:
 *     "小孙点 Coverage section 的 unresolved item → modal 弹出 → 选 [supersede 旧 spec]
 *      还是 [reject 新 decision] → 写新 ledger 行 supersede_id=旧 spec id"
 *   - 此前 prompt-inspector-tab.tsx UnresolvedRow 是 window.alert 占位
 *     (final-vision codex review NOT_DONE P1-1)
 *
 * UI:
 *   1. Target decision 信息 (decisionId / decisionType / summary, 只读)
 *   2. Action 二选一 radio: [supersede 旧 spec] / [reject 新 decision]
 *   3. Reason textarea (必填)
 *   4. submitting → loading
 *   5. report → success (显示 newDecisionId + serverAction) / error (code + message)
 *   6. [取消] [确认] 按钮; action 未选 or reason 空 → [确认] disabled
 *
 * 不做 (本次范围外):
 *   - V14 二次审计 (manual supersede/reject 不走 PromoteModal V14 chain — promote 是 draft→wiki
 *     升级写型，此处是 decision ledger 上的状态机覆盖，contracts §5 已锁定语义)
 *   - 多条 message evidence 输入 (默认 evidence = [target decision self]，足以满足 contracts
 *     evidence ≥1 要求；如需扩展走未来 feature)
 *   - DecisionRef.srcDraftPath 不存在 — 跟 PromoteModal 不可复用 (原 F028 顾虑解除)
 */

export interface UnresolvedDecisionTarget {
  decisionId: string
  decisionType: string
  summary: string
  decidedBy: string
  decidedAt: string
}

export interface DecisionSupersedeRejectModalProps {
  open: boolean
  roomId: string | null
  target: UnresolvedDecisionTarget | null
  callerAlias: string
  /** 额外 evidence message ids（可选）。 */
  sourceMessageIds?: readonly string[]
  onClose: () => void
  onSubmitSuccess?: (response: SupersedeRejectSuccess) => void
}

export function DecisionSupersedeRejectModal({
  open,
  roomId,
  target,
  callerAlias,
  sourceMessageIds,
  onClose,
  onSubmitSuccess,
}: DecisionSupersedeRejectModalProps) {
  const [action, setAction] = useState<SupersedeRejectAction | null>(null)
  const [reason, setReason] = useState<string>("")
  const api = useDecisionSupersedeRejectApi()

  // notify onSubmitSuccess 一次 per success object (跟 PromoteModal notifiedRef 一致)
  const notifiedRef = useRef<SupersedeRejectSuccess | null>(null)
  useEffect(() => {
    if (!api.data) {
      notifiedRef.current = null
      return
    }
    if (notifiedRef.current === api.data) return
    notifiedRef.current = api.data
    onSubmitSuccess?.(api.data)
  }, [api.data, onSubmitSuccess])

  // open 翻转 → reset state（只在 false→true 那次跑一次，防 reason input 中途被清）
  const isFirstOpenRef = useRef(true)
  useEffect(() => {
    if (!open) {
      isFirstOpenRef.current = true
      return
    }
    if (!isFirstOpenRef.current) return
    isFirstOpenRef.current = false
    setAction(null)
    setReason("")
    api.reset()
  }, [open, api.reset])

  const reasonValid = reason.trim().length > 0
  const canSubmit =
    !api.isLoading && !!roomId && !!target && action !== null && reasonValid && !api.data

  const handleClose = () => {
    api.reset()
    setAction(null)
    setReason("")
    onClose()
  }

  const handleSubmit = async () => {
    if (!canSubmit || !roomId || !target || !action) return
    await api.submit({
      roomId,
      targetDecisionId: target.decisionId,
      action,
      reason,
      callerAlias,
      sourceMessageIds,
    })
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="decision-supersede-reject-modal-title"
      data-testid="decision-supersede-reject-modal"
    >
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-h-[80vh] overflow-y-auto p-6">
        <h2
          id="decision-supersede-reject-modal-title"
          className="text-lg font-semibold mb-4"
        >
          Unresolved Decision · 手动确认
        </h2>

        {/* §1 target info */}
        <div className="mb-4 text-sm text-gray-700">
          <div className="font-medium text-gray-800">Target decision:</div>
          {target ? (
            <div className="mt-1 rounded border border-amber-200 bg-amber-50 p-2 text-xs">
              <div>
                <span className="font-medium">id:</span>{" "}
                <span className="font-mono">{target.decisionId}</span>{" "}
                <span className="ml-2 inline-flex rounded border border-amber-300 bg-amber-100 px-1 font-mono text-[10px] text-amber-700">
                  {target.decisionType}
                </span>
              </div>
              <div className="mt-1">
                <span className="font-medium">summary:</span> {target.summary}
              </div>
              <div className="mt-1 text-[10px] text-gray-500">
                by <span className="font-mono">{target.decidedBy}</span> @{" "}
                <span className="font-mono">{target.decidedAt}</span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-400">(none)</div>
          )}
        </div>

        {/* §2 action 二选一 */}
        <fieldset className="mb-4">
          <legend className="text-sm font-medium mb-2">Action</legend>
          <div className="flex flex-col gap-2 text-sm">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="action"
                value="supersede"
                checked={action === "supersede"}
                onChange={() => setAction("supersede")}
                data-testid="action-radio-supersede"
                className="mt-1"
              />
              <span>
                <span className="font-medium">Supersede</span>{" "}
                <span className="text-xs text-gray-500">
                  (旧 spec 被新 commit 覆盖；ledger 写新 commit 行 + 旧行 superseded_by=新 id)
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="action"
                value="reject"
                checked={action === "reject"}
                onChange={() => setAction("reject")}
                data-testid="action-radio-reject"
                className="mt-1"
              />
              <span>
                <span className="font-medium">Reject</span>{" "}
                <span className="text-xs text-gray-500">
                  (新 decision 被拒；ledger 写 reject 行 + 旧行 superseded_by=reject id)
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        {/* §3 reason */}
        <div className="mb-4">
          <label
            htmlFor="decision-supersede-reject-reason"
            className="block text-sm font-medium mb-1"
          >
            Reason
          </label>
          <textarea
            id="decision-supersede-reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="为什么 supersede / reject 这条 decision？(写入新 ledger 行 content + reason 字段)"
            rows={3}
            className="w-full px-3 py-2 border rounded text-sm"
            data-testid="decision-supersede-reject-reason"
          />
        </div>

        {/* §4 result panel */}
        {api.data ? (
          <div
            className="mb-4 p-3 border border-green-300 rounded bg-green-50 text-sm text-green-800"
            data-testid="decision-supersede-reject-success"
          >
            <div className="font-medium">确认成功</div>
            <div className="text-xs mt-1">
              <div>
                新 decision_id ={" "}
                <span className="font-mono">{api.data.newDecisionId}</span> (action ={" "}
                <span className="font-mono">{api.data.serverAction}</span>)
              </div>
              <div>
                ledger cursor =<span className="font-mono"> {api.data.ledgerCursor}</span> · @{" "}
                <span className="font-mono">{api.data.appendedAt}</span>
              </div>
            </div>
          </div>
        ) : null}

        {api.error ? (
          <div
            className="mb-4 p-3 border border-red-300 rounded bg-red-50 text-sm text-red-700"
            data-testid="decision-supersede-reject-error"
          >
            <div className="font-medium">确认失败</div>
            <div className="text-xs mt-1 font-mono">{api.error}</div>
          </div>
        ) : null}

        {/* §5 buttons */}
        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
            data-testid="decision-supersede-reject-cancel"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="decision-supersede-reject-submit"
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {api.isLoading ? "提交中..." : "确认"}
          </button>
        </div>
      </div>
    </div>
  )
}
