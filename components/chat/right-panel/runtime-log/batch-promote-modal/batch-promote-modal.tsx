"use client"

import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { usePromoteJobsStore } from "@/components/stores/promote-jobs-store"
import type { V14AuditLayer, V14RejectReason } from "../promote-modal/use-promote-api"
import {
  type BatchPromoteFailureEntry,
  type BatchPromoteSuccessEntry,
  type BatchPromoteSummary,
  suggestDestWikiPath,
} from "./use-batch-promote-api"

/**
 * F027 Phase 4 Week 3 Day 12 (AC-P4-4) · BatchPromoteModal — 批量审批 UI
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-4 (line 215-218)
 *   - docs/plans/F027-phase4-implementation-plan.md 风险 line 295
 *     ("报告 modal 不易读" — 单测 + 范-r1 重点 review UI 文案)
 *   - PromoteModal pattern (../promote-modal/promote-modal.tsx)
 *
 * UI 流程:
 *   phase = 'compose' (用户填 dest + reason)
 *     → [批量审批 N 份] click → submit
 *     → phase = 'submitting' (loading)
 *     → 收到 response → phase = 'report'
 *
 * compose phase:
 *   §1 Items 列表: 每行 src → dest input (默认 suggest) + [✕] 删行
 *   §2 共用 Reason input
 *   §3 [取消] [批量审批 N 份]
 *
 * report phase:
 *   §4 ✅ Success: N (列出 src → finalPath)
 *   §5 ❌ Failed: M (列出 src → destPath + status badge + hint)
 *   §6 [关闭] (触发 onBatchComplete → parent refresh draft list)
 *
 * 不做 (Day 12 范围外):
 *   - failed items 一键 "retry失败的" (失败 draft 留原位等手动)
 *   - dest path autocomplete
 *   - per-row preview audit
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
  prompt_structure: "Prompt 结构",
  tainted_source_direct_quote: "Tainted_source 直引",
  llm_semantic_injection: "LLM 语义注入",
  judge_parse_failed: "判官响应异常（可重试）",
  judge_unavailable: "判官暂不可用（可重试）",
  exemption_sanitize_blocked: "豁免文档 sanitize 红线",
}

const STATUS_LABEL_CN: Record<string, string> = {
  audit_rejected: "审计驳回",
  denied_acl: "ACL 拒绝",
  lease_expired: "Lease 过期",
  lease_held: "Lease 被占",
  src_not_found: "Src 不存在",
  dest_exists: "Dest 已存在",
  path_invalid: "路径无效",
  internal: "内部错误",
}

export interface BatchPromoteRow {
  srcDraftPath: string
  /** 显示名 (从 draft-approval list 传，UI 友好)。 */
  displayTitle?: string
  /** F027 bucket-routing 补丁 · 后端 LLM 建议目标路径；有则作 dest 初值（可编辑），缺则退回路径推导。 */
  suggestedDestPath?: string
}

export interface BatchPromoteModalProps {
  open: boolean
  /** 多选选中的 draft list (call-site 已 dedup)。 */
  rows: readonly BatchPromoteRow[]
  callerAlias: string
  onClose: () => void
  /** 批量完成 (无论 success/failed)，parent refetch draft list 用。 */
  onBatchComplete?: (summary: BatchPromoteSummary) => void
}

interface EditableRow {
  srcDraftPath: string
  displayTitle?: string
  destWikiPath: string
}

export function BatchPromoteModal({
  open,
  rows,
  callerAlias,
  onClose,
  onBatchComplete,
}: BatchPromoteModalProps) {
  const [editableRows, setEditableRows] = useState<EditableRow[]>([])
  const [reason, setReason] = useState<string>("")
  const [phase, setPhase] = useState<"compose" | "submitting" | "report">("compose")

  // F027 promote 后台化：批量提交生命周期在 store 里跑，弹窗关掉分片照常提交，
  // 进度/结果同时供 tab 横幅使用。本组件的 phase 只是视图态。
  const batch = usePromoteJobsStore((s) => s.batch)
  const startBatch = usePromoteJobsStore((s) => s.startBatch)
  const dismissBatch = usePromoteJobsStore((s) => s.dismissBatch)
  const batchData = batch?.status === "done" ? batch.summary : null
  const batchError = batch?.status === "done" ? batch.error : null

  // codex mid-r1 P1 修: 只在 open 从 false→true 边沿初始化一次，
  // 不在 rows 变时重置 phase (否则 submit 成功后 parent 清 selectedPaths/refetch
  // 导致 rows 变 [] → 立刻重置回 compose → 用户看不到 success/failed 报告)
  const isFirstOpenRef = useRef(true)
  useEffect(() => {
    if (!open) {
      isFirstOpenRef.current = true
      return
    }
    if (!isFirstOpenRef.current) return // 已初始化过，不重置
    isFirstOpenRef.current = false
    setEditableRows(
      rows.map((r) => ({
        srcDraftPath: r.srcDraftPath,
        displayTitle: r.displayTitle,
        // F027 bucket-routing 补丁：优先后端 LLM 建议桶（wiki/methods/ 等），缺则退回纯路径推导（恒 concepts）
        destWikiPath: r.suggestedDestPath ?? suggestDestWikiPath(r.srcDraftPath),
      })),
    )
    setReason("")
    // 后台化：关掉重开时如果上一批还在跑，直接进 submitting 视图接着看进度
    setPhase(usePromoteJobsStore.getState().batch?.status === "running" ? "submitting" : "compose")
    // 仅当 modal 打开边沿时初始化；rows 是 first-open 快照
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows])

  // submit 完成 (store batch 落定) → 切 report phase + notify parent
  // codex Day 8 P1 pattern: useRef 防多次 trigger (parent re-render identity 不稳)
  const notifiedRef = useRef<BatchPromoteSummary | null>(null)
  useEffect(() => {
    if (!batchData) {
      notifiedRef.current = null
      return
    }
    if (notifiedRef.current === batchData) return
    notifiedRef.current = batchData
    setPhase("report")
    onBatchComplete?.(batchData)
  }, [batchData, onBatchComplete])

  // submit error → 切回 compose phase 显示 error (用户改后重试)。
  // F027 全选三件套：分批提交下 data 与 error 可能并存（前 N 片成功 + 后续片失败）——
  // 此时 report 优先（promote 已发生，结果必须展示），error 在 report 内横幅提示；
  // 仅「零分片完成」(summary 为空) 才回 compose。
  useEffect(() => {
    if (batchError && phase === "submitting" && !batchData) {
      setPhase("compose")
    }
  }, [batchError, phase, batchData])

  const allDestValid = useMemo(() => {
    if (editableRows.length === 0) return false
    for (const r of editableRows) {
      if (!isValidDestPath(r.destWikiPath)) return false
    }
    return true
  }, [editableRows])

  const reasonValid = reason.trim().length > 0
  const canSubmit = phase === "compose" && allDestValid && reasonValid && editableRows.length > 0

  // 关弹窗不取消批次（后台化本意）；report 已看完才顺手清横幅态。
  const handleClose = () => {
    if (phase === "report") dismissBatch()
    setEditableRows([])
    setReason("")
    setPhase("compose")
    onClose()
  }

  const handleDestEdit = (idx: number, value: string) => {
    setEditableRows((prev) => prev.map((r, i) => (i === idx ? { ...r, destWikiPath: value } : r)))
  }

  const handleRemoveRow = (idx: number) => {
    setEditableRows((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleSubmit = () => {
    if (!canSubmit) return
    setPhase("submitting")
    void startBatch({
      items: editableRows.map((r) => ({
        srcDraftPath: r.srcDraftPath,
        destWikiPath: r.destWikiPath,
      })),
      callerAlias,
      reason,
    })
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-promote-modal-title"
    >
      <div className="bg-white rounded-lg shadow-xl w-[720px] max-h-[85vh] overflow-y-auto p-6">
        <h2 id="batch-promote-modal-title" className="text-lg font-semibold mb-4">
          {phase === "report"
            ? `批量审批结果 · ${batchData?.success.length ?? 0} 成功 / ${
                batchData?.failed.length ?? 0
              } 失败`
            : `批量审批 ${editableRows.length} 份 draft → wiki`}
        </h2>

        {phase === "compose" && (
          <ComposeView
            rows={editableRows}
            reason={reason}
            setReason={setReason}
            onDestEdit={handleDestEdit}
            onRemoveRow={handleRemoveRow}
            error={batchError}
          />
        )}

        {phase === "submitting" && (
          <div
            className="mb-4 p-6 border rounded bg-gray-50 text-sm text-gray-600"
            data-testid="batch-promote-submitting"
          >
            <div className="mb-3 text-center">
              正在批量审批（每 50 篇一批）——可以关闭本窗口，进度会显示在审批页顶部横幅。
            </div>
            {/* 补丁#3（小孙进度条）：分批进度 已提交 X/Y + 进度条 */}
            {batch?.progress && (
              <div data-testid="batch-promote-progress" role="status" aria-live="polite">
                <div className="mb-1 flex justify-between text-xs text-gray-700">
                  <span>已提交</span>
                  <span className="font-mono">
                    {batch.progress.done}/{batch.progress.total}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-gray-200">
                  <div
                    className="h-2 rounded bg-purple-600 transition-all duration-300"
                    style={{
                      width: `${
                        batch.progress.total > 0
                          ? (batch.progress.done / batch.progress.total) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
                data-testid="batch-promote-close-bg"
              >
                关闭（后台继续）
              </button>
            </div>
          </div>
        )}

        {phase === "report" && batchData && (
          <>
            {batchError && (
              <div
                className="mb-3 flex items-start gap-1 p-2 border border-amber-300 rounded bg-amber-50 text-xs text-amber-800"
                data-testid="batch-promote-partial-error"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  后续批次未提交：{batchError}
                  （以下为已完成部分的结果；剩余 draft 留在列表中，可重新全选发起）
                </span>
              </div>
            )}
            <ReportView summary={batchData} />
          </>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-2 mt-6">
          {phase === "compose" && (
            <>
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
                data-testid="batch-promote-cancel"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-4 py-2 text-sm bg-accent-500 text-white rounded hover:bg-accent-600 active:scale-[0.97] disabled:bg-gray-300 disabled:cursor-not-allowed"
                data-testid="batch-promote-submit"
              >
                批量审批 {editableRows.length} 份
              </button>
            </>
          )}
          {phase === "report" && (
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-2 text-sm bg-accent-500 text-white rounded hover:bg-accent-600 active:scale-[0.97]"
              data-testid="batch-promote-close"
            >
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Compose view ────────────────────────────────────────────────────────────

function ComposeView(props: {
  rows: EditableRow[]
  reason: string
  setReason: (v: string) => void
  onDestEdit: (idx: number, value: string) => void
  onRemoveRow: (idx: number) => void
  error: string | null
}) {
  const { rows, reason, setReason, onDestEdit, onRemoveRow, error } = props

  return (
    <>
      {/* §1 Items 列表 */}
      <div className="mb-4">
        <div className="text-sm font-medium mb-2 text-gray-800">Draft 列表 ({rows.length} 份)</div>
        {rows.length === 0 ? (
          <div
            className="p-3 border rounded bg-yellow-50 text-xs text-yellow-700"
            data-testid="batch-promote-empty-rows"
          >
            没有选中的 draft（请回 draft 列表选）
          </div>
        ) : (
          <ul className="space-y-2 max-h-[280px] overflow-y-auto" data-testid="batch-promote-rows">
            {rows.map((r, idx) => {
              const destValid = isValidDestPath(r.destWikiPath)
              return (
                <li
                  key={r.srcDraftPath}
                  className="p-2 border rounded bg-slate-50"
                  data-testid={`batch-promote-row-${r.srcDraftPath}`}
                >
                  <div className="text-xs font-mono text-gray-600 break-all mb-1">
                    {r.displayTitle ?? r.srcDraftPath}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 shrink-0">→</span>
                    <input
                      type="text"
                      value={r.destWikiPath}
                      onChange={(e) => onDestEdit(idx, e.target.value)}
                      className="flex-1 px-2 py-1 border rounded text-xs font-mono"
                      aria-label={`dest path for ${r.srcDraftPath}`}
                      data-testid={`batch-promote-dest-input-${r.srcDraftPath}`}
                    />
                    <button
                      type="button"
                      onClick={() => onRemoveRow(idx)}
                      className="px-2 py-1 text-xs text-red-500 hover:bg-red-50 rounded"
                      title="从批次移除此份"
                      aria-label={`remove ${r.srcDraftPath}`}
                      data-testid={`batch-promote-remove-${r.srcDraftPath}`}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  {!destValid && (
                    <div className="mt-1 text-micro text-red-600">
                      路径需以 {ALLOWED_DEST_PREFIXES.join(" / ")} 之一开头且以 .md 结尾
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* §2 共用 Reason */}
      <div className="mb-4">
        <label htmlFor="batch-promote-reason" className="block text-sm font-medium mb-1">
          Reason (所有 draft 共用)
        </label>
        <textarea
          id="batch-promote-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="为什么批量 promote? (会写入每条 wiki_events.reason)"
          rows={2}
          className="w-full px-3 py-2 border rounded text-sm"
          data-testid="batch-promote-reason-input"
        />
      </div>

      {/* Generic error (non-422) */}
      {error && (
        <div
          className="mb-4 p-3 border border-red-300 rounded bg-red-50 text-sm text-red-700"
          data-testid="batch-promote-error"
        >
          <div className="font-medium">批量审批失败</div>
          <div className="text-xs mt-1 font-mono">{error}</div>
        </div>
      )}
    </>
  )
}

// ─── Report view ─────────────────────────────────────────────────────────────

function ReportView({ summary }: { summary: BatchPromoteSummary }) {
  return (
    <div data-testid="batch-promote-report">
      {/* §4 Success */}
      <div className="mb-4">
        <div className="flex items-center gap-1 text-sm font-medium text-green-800 mb-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Success: {summary.success.length} 份
        </div>
        {summary.success.length === 0 ? (
          <div className="text-xs text-gray-500 italic">（无成功）</div>
        ) : (
          <ul className="space-y-1" data-testid="batch-promote-success-list">
            {summary.success.map((s) => (
              <SuccessRow key={s.srcDraftPath} entry={s} />
            ))}
          </ul>
        )}
      </div>

      {/* §5 Failed */}
      <div className="mb-4">
        <div className="flex items-center gap-1 text-sm font-medium text-red-800 mb-2">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          Failed: {summary.failed.length} 份
        </div>
        {summary.failed.length === 0 ? (
          <div className="text-xs text-gray-500 italic">（无失败）</div>
        ) : (
          <ul className="space-y-2" data-testid="batch-promote-failed-list">
            {summary.failed.map((f) => (
              <FailedRow key={f.srcDraftPath} entry={f} />
            ))}
          </ul>
        )}
      </div>

      {/* 失败 draft 留原位提示 */}
      {summary.failed.length > 0 && (
        <div className="mb-4 p-2 border border-amber-300 bg-amber-50 rounded text-xs text-amber-800">
          失败的 {summary.failed.length} 份 draft 留在原位，可在 draft 列表内单独修复重试。
        </div>
      )}
    </div>
  )
}

function SuccessRow({ entry }: { entry: BatchPromoteSuccessEntry }) {
  return (
    <li
      className="p-2 border border-green-200 rounded bg-green-50 text-xs"
      data-testid={`batch-promote-success-${entry.srcDraftPath}`}
    >
      <div className="font-mono text-green-700 break-all">{entry.srcDraftPath}</div>
      <div className="font-mono text-green-600 break-all">→ {entry.destWikiPath}</div>
      <div className="text-micro text-gray-500 mt-1">eventId: {entry.eventId}</div>
    </li>
  )
}

function FailedRow({ entry }: { entry: BatchPromoteFailureEntry }) {
  const statusLabel = STATUS_LABEL_CN[entry.status] ?? entry.status
  return (
    <li
      className="p-2 border border-red-200 rounded bg-red-50 text-xs"
      data-testid={`batch-promote-failed-${entry.srcDraftPath}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="font-mono text-red-700 break-all flex-1">{entry.srcDraftPath}</div>
        <span
          className="shrink-0 inline-flex items-center rounded border border-red-300 px-1.5 py-0.5 text-micro font-medium text-red-700 bg-red-100"
          data-testid={`batch-promote-failed-status-${entry.srcDraftPath}`}
        >
          {statusLabel}
        </span>
      </div>
      <div className="font-mono text-gray-600 break-all">→ {entry.destWikiPath}</div>
      {entry.auditReject ? (
        <AuditRejectDetail reject={entry.auditReject} />
      ) : (
        <div className="text-micro text-red-600 mt-1 font-mono">{entry.error}</div>
      )}
    </li>
  )
}

function AuditRejectDetail({ reject }: { reject: V14RejectReason }) {
  return (
    <div className="mt-1 text-micro text-red-700 space-y-0.5">
      <div>
        <span className="font-medium">Layer:</span> {LAYER_LABEL_CN[reject.layer]} (
        <span className="font-mono">{reject.layer}</span>)
      </div>
      <div>
        <span className="font-medium">Matched:</span>{" "}
        <span className="font-mono">{reject.matchedPatterns.join(" / ")}</span>
      </div>
      <div>
        <span className="font-medium">Hint:</span> {reject.hint}
      </div>
    </div>
  )
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isValidDestPath(p: string): boolean {
  if (p.length === 0) return false
  if (!p.endsWith(".md")) return false
  return ALLOWED_DEST_PREFIXES.some((prefix) => p.startsWith(prefix))
}
