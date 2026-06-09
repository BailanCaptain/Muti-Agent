"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import {
  type PromoteCommitSuccess,
  type V14AuditLayer,
  type V14RejectReason,
  usePromoteAudit,
  usePromoteCommit,
} from "./use-promote-api"

/**
 * F027 Phase 4 Week 2 Day 8 (AC-P4-1 + AC-P4-2) · PromoteModal
 *
 * 真相源:
 *   - docs/plans/V16.5-final.md line 838-846 (V14 二次审计)
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-1 (PromoteModal 流程)
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-2 (审计失败回退 UI)
 *   - components/chat/right-panel/runtime-log/ingest-modal/ingest-modal.tsx pattern
 *
 * UI 段 (按 prep-notes 设计):
 *   1. Draft 信息 (srcDraftPath)
 *   2. Target wiki path 选择 (输入 + 简单 path validator)
 *   3. Reason input (textarea)
 *   4. V14 audit 实时反馈 (mount 时 preview，显示 layer + matchedPatterns + hint)
 *   5. (Day 8 范围内不做) 落地预览
 *   6. 底部 [取消] [Promote] 按钮 — V14 reject 时禁用 [Promote]
 *
 * 数据流:
 *   - Modal open + props.srcDraftPath 已传 → 自动 usePromoteAudit.preview()
 *   - 用户填 destWikiPath + reason → 输入校验
 *   - 点 [Promote] → usePromoteCommit.commit() → success / 422 reject (AC-P4-2)
 *   - reject path: rejectReason 状态填充 → modal 显示 reject panel + 让用户改 src body 重试
 *
 * 不做 (Day 8 范围外):
 *   - Demote/Rollback modal (Day 9 AC-P4-3)
 *   - 批量审批 (Week 3 AC-P4-4)
 *   - composer slash menu trigger (留 F028, plan v5 §1.1 第 3 点)
 *   - 复杂 path autocomplete (plan v5 §6 风险表 提到但未必 Day 8 做)
 */

const ALLOWED_DEST_PREFIXES = [
  "wiki/concepts/",
  "wiki/rules/",
  "wiki/methods/",
  "wiki/people/",
  "wiki/feedback/",
  "wiki/work/",
] as const

const LAYER_LABEL_CN: Record<V14AuditLayer, string> = {
  imperative_statement: "命令式语句",
  prompt_structure: "Prompt 结构",
  tainted_source_direct_quote: "Tainted_source 直引",
}

export interface PromoteModalProps {
  open: boolean
  srcDraftPath: string | null
  /** 当前用户 alias (commit endpoint callerAlias 必填)。 */
  callerAlias: string
  /** 关联 audit trail 的 message ids (可选)。 */
  sourceMessageIds?: string[]
  onClose: () => void
  onPromoteSuccess?: (response: PromoteCommitSuccess) => void
  /** 测试用 - 跳过默认 preview 自动触发 (default false)。 */
  skipAutoPreview?: boolean
}

export function PromoteModal({
  open,
  srcDraftPath,
  callerAlias,
  sourceMessageIds,
  onClose,
  onPromoteSuccess,
  skipAutoPreview = false,
}: PromoteModalProps) {
  const [destWikiPath, setDestWikiPath] = useState<string>("")
  const [reason, setReason] = useState<string>("")

  const auditHook = usePromoteAudit()
  const commitHook = usePromoteCommit()

  // Auto preview on modal open + srcDraftPath available
  useEffect(() => {
    if (!open || !srcDraftPath || skipAutoPreview) return
    auditHook.preview({ srcDraftPath })
    // intentionally only re-trigger on src change or open transitions
    // (avoid re-preview on every render)
  }, [open, srcDraftPath, skipAutoPreview, auditHook.preview])

  // codex end-r3 P1 修: ref 追踪已 notify 的 success object，防 onPromoteSuccess identity
  // 不稳 (parent useDraftsData refetch 每次 render 新 identity) 导致 effect 重 trigger 多次
  // 调 callback → refetch loop。同一 PromoteCommitSuccess reference 只 notify 一次。
  const notifiedRef = useRef<PromoteCommitSuccess | null>(null)
  useEffect(() => {
    if (!commitHook.data) {
      notifiedRef.current = null
      return
    }
    if (notifiedRef.current === commitHook.data) return
    notifiedRef.current = commitHook.data
    onPromoteSuccess?.(commitHook.data)
  }, [commitHook.data, onPromoteSuccess])

  const destPathValid = useMemo(() => {
    if (destWikiPath.length === 0) return false
    if (destWikiPath.endsWith(".md") === false) return false
    return ALLOWED_DEST_PREFIXES.some((p) => destWikiPath.startsWith(p))
  }, [destWikiPath])

  const reasonValid = reason.trim().length > 0
  const auditPassed = auditHook.data?.passed === true
  const canPromote =
    !commitHook.isLoading &&
    !!srcDraftPath &&
    destPathValid &&
    reasonValid &&
    auditPassed === true

  const handleClose = () => {
    auditHook.reset()
    commitHook.reset()
    setDestWikiPath("")
    setReason("")
    onClose()
  }

  const handlePromote = async () => {
    if (!srcDraftPath || !canPromote) return
    await commitHook.commit({
      srcDraftPath,
      destWikiPath,
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
      aria-labelledby="promote-modal-title"
    >
      <div className="bg-white rounded-lg shadow-xl w-[640px] max-h-[80vh] overflow-y-auto p-6">
        <h2 id="promote-modal-title" className="text-lg font-semibold mb-4">
          Promote draft → wiki
        </h2>

        {/* §1 Draft info */}
        <div className="mb-4 text-sm text-gray-600">
          <div className="font-medium text-gray-800">Source draft:</div>
          <div className="font-mono text-xs break-all">{srcDraftPath ?? "(none)"}</div>
        </div>

        {/* §2 Target path */}
        <div className="mb-4">
          <label htmlFor="promote-dest" className="block text-sm font-medium mb-1">
            Target wiki path
          </label>
          <input
            id="promote-dest"
            type="text"
            value={destWikiPath}
            onChange={(e) => setDestWikiPath(e.target.value)}
            placeholder="wiki/concepts/example.md"
            className="w-full px-3 py-2 border rounded text-sm font-mono"
          />
          {destWikiPath.length > 0 && !destPathValid ? (
            <div className="mt-1 text-xs text-red-600">
              路径需以 {ALLOWED_DEST_PREFIXES.join(" / ")} 之一开头且以 .md 结尾
            </div>
          ) : null}
        </div>

        {/* §3 Reason */}
        <div className="mb-4">
          <label htmlFor="promote-reason" className="block text-sm font-medium mb-1">
            Reason
          </label>
          <textarea
            id="promote-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="为什么 promote 这个 draft? (会写入 wiki_events.reason)"
            rows={2}
            className="w-full px-3 py-2 border rounded text-sm"
          />
        </div>

        {/* §4 V14 audit feedback (auto preview on mount) */}
        <V14AuditPanel
          isLoading={auditHook.isLoading}
          error={auditHook.error}
          audit={auditHook.data}
        />

        {/* AC-P4-2: commit-time 422 reject (用户改 body 后再试) */}
        {commitHook.rejectReason ? (
          <RejectPanel
            title="Promote 被拒（commit 阶段二次审计 fail）"
            reject={commitHook.rejectReason}
            advice="请改写 draft body（按下方 hint），保存后重新 preview/promote。"
          />
        ) : null}

        {commitHook.error ? (
          <div className="mb-4 p-3 border border-red-300 rounded bg-red-50 text-sm text-red-700">
            <div className="font-medium">Promote error</div>
            <div className="text-xs mt-1 font-mono">{commitHook.error}</div>
          </div>
        ) : null}

        {/* §6 Buttons */}
        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handlePromote}
            disabled={!canPromote}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {commitHook.isLoading ? "Promoting..." : "Promote"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── V14 audit feedback panel (preview-time + AC-P4-2 reject path) ───────────

function V14AuditPanel(props: {
  isLoading: boolean
  error: string | null
  audit: { passed: boolean; rejectReason?: V14RejectReason } | null
}) {
  const { isLoading, error, audit } = props
  if (isLoading) {
    return (
      <div className="mb-4 p-3 border rounded bg-gray-50 text-sm text-gray-600">
        V14 二次审计 preview 中...
      </div>
    )
  }
  if (error) {
    return (
      <div className="mb-4 p-3 border border-yellow-300 rounded bg-yellow-50 text-sm">
        <div className="font-medium text-yellow-800">V14 preview error</div>
        <div className="text-xs mt-1 font-mono">{error}</div>
      </div>
    )
  }
  if (!audit) return null
  if (audit.passed) {
    return (
      <div className="mb-4 p-3 border border-green-300 rounded bg-green-50 text-sm text-green-700">
        V14 二次审计 PASS — 可以 promote
      </div>
    )
  }
  return (
    <RejectPanel
      title="V14 二次审计 FAIL"
      reject={audit.rejectReason!}
      advice="请按 hint 改写 draft body，保存后此 modal 会重新 preview。"
    />
  )
}

function RejectPanel(props: { title: string; reject: V14RejectReason; advice?: string }) {
  const { title, reject, advice } = props
  return (
    <div className="mb-4 p-3 border border-red-300 rounded bg-red-50 text-sm">
      <div className="font-medium text-red-800">{title}</div>
      <div className="mt-2 text-xs text-red-700">
        <div>
          <span className="font-medium">Layer:</span> {LAYER_LABEL_CN[reject.layer]} (
          <span className="font-mono">{reject.layer}</span>)
        </div>
        <div className="mt-1">
          <span className="font-medium">Matched:</span>{" "}
          <span className="font-mono">{reject.matchedPatterns.join(" / ")}</span>
        </div>
        <div className="mt-1">
          <span className="font-medium">Hint:</span> {reject.hint}
        </div>
        {advice ? <div className="mt-2 text-gray-700">{advice}</div> : null}
      </div>
    </div>
  )
}
