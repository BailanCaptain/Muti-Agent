"use client"

import { CheckCircle2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { usePromoteJobsStore } from "@/components/stores/promote-jobs-store"
import { ReplaceComparePanel } from "./replace-compare-panel"
import { SameSourcePanel } from "./same-source-panel"
import {
  type PromoteCommitSuccess,
  RETRYABLE_AUDIT_LAYERS,
  type V14AuditLayer,
  type V14RejectReason,
  usePromoteAudit,
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
  prompt_structure: "Prompt 结构",
  tainted_source_direct_quote: "Tainted_source 直引",
  llm_semantic_injection: "LLM 语义注入",
  judge_parse_failed: "判官响应异常（可重试）",
  judge_unavailable: "判官暂不可用（可重试）",
  exemption_sanitize_blocked: "豁免文档 sanitize 红线",
}

/** 德彪 r1 P2：judge 基础设施类拒绝是「稍后重试」（非内容问题），不应提示「改写 body」。 */
function adviceForReject(reject: V14RejectReason): string {
  if (RETRYABLE_AUDIT_LAYERS.has(reject.layer)) {
    return "这不是内容问题（LLM 判官暂不可用/响应异常）。请稍后重新 promote，无需改写 draft。"
  }
  return "请按 hint 改写 draft body，保存后重新 preview/promote。"
}

export interface PromoteModalProps {
  open: boolean
  srcDraftPath: string | null
  /**
   * F027 bucket-routing 补丁 · 后端按 LLM canonical_owner_suggestion 算好的目标路径建议。
   * 打开时预填 Target wiki path（每个 src 只预填一次，用户可改/可清空不回填）。
   */
  suggestedDestPath?: string | null
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
  suggestedDestPath,
  callerAlias,
  sourceMessageIds,
  onClose,
  onPromoteSuccess,
  skipAutoPreview = false,
}: PromoteModalProps) {
  const [destWikiPath, setDestWikiPath] = useState<string>("")
  const [reason, setReason] = useState<string>("")

  const auditHook = usePromoteAudit()
  // F027 promote 后台化（小孙「promote 会把整个网占住」）：提交生命周期在 store 里跑，
  // 弹窗只是视图——关掉弹窗请求照常进行，结果在列表行徽标 + 重开弹窗可见。
  const job = usePromoteJobsStore((s) => (srcDraftPath ? s.jobs[srcDraftPath] : undefined))
  const startPromote = usePromoteJobsStore((s) => s.startPromote)
  const clearJob = usePromoteJobsStore((s) => s.clearJob)
  const resolvePartialSupersede = usePromoteJobsStore((s) => s.resolvePartialSupersede)
  const jobRunning = job?.status === "running"
  // 德彪 r2 P1-1 · partial（promote 成功但 supersede 有失败）与 ok 同走成功面板，
  // 面板内 amber 警示块给「下架旧版」处理入口。
  const jobOk = job?.status === "ok" || job?.status === "partial"

  // F027 bucket-routing 补丁：打开时按后端建议预填 Target path。ref 记录已预填的 src，
  // 同一 src 只填一次——用户手动清空/改写后不回填（deps 故意不含 destWikiPath）。
  // 德彪 r1 P2-2：新 src 首次进入必须无条件 set（建议缺省 set ""），否则 open 态切 src
  // 且新 src 无建议时残留上一篇的 dest，可能把 B promote 到 A 的目标路径。
  const prefilledForSrcRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !srcDraftPath) return
    if (prefilledForSrcRef.current === srcDraftPath) return
    prefilledForSrcRef.current = srcDraftPath
    setDestWikiPath(suggestedDestPath ?? "")
  }, [open, srcDraftPath, suggestedDestPath])

  // Auto preview on modal open + srcDraftPath available
  useEffect(() => {
    if (!open || !srcDraftPath || skipAutoPreview) return
    auditHook.preview({ srcDraftPath })
    // intentionally only re-trigger on src change or open transitions
    // (avoid re-preview on every render)
  }, [open, srcDraftPath, skipAutoPreview, auditHook.preview])

  // 德彪后台化 r1 P2：成功面板用本地快照——job ok 触发 refetch 后 store 会 pruneOkJobs，
  // 若直接读 store 条目，面板会在展示中途被 GC 打回表单视图。
  const [successInfo, setSuccessInfo] = useState<{
    finalPath: string
    replacedArchivePath?: string
    supersededPaths?: string[]
    /** 德彪 r1 P1-3 · supersede 半态（旧版归档失败仍在正式区）——成功面板必须响亮透出。 */
    supersedeFailures?: Array<{ path: string; error: string }>
  } | null>(null)

  // codex end-r3 P1 修（改 store 后语义不变）：同一 src 的 ok 只 notify 一次，防
  // onPromoteSuccess identity 不稳（parent refetch 每次 render 新 identity）触发 refetch loop。
  const notifiedOkSrcRef = useRef<string | null>(null)
  useEffect(() => {
    if (!jobOk || !srcDraftPath || !job?.finalPath) return
    if (notifiedOkSrcRef.current === srcDraftPath) return
    notifiedOkSrcRef.current = srcDraftPath
    setSuccessInfo({
      finalPath: job.finalPath,
      replacedArchivePath: job.replacedArchivePath,
      supersededPaths: job.supersededPaths,
      supersedeFailures: job.supersedeFailures,
    })
    const payload: PromoteCommitSuccess = {
      ok: true,
      finalPath: job.finalPath,
      eventId: job.eventId ?? 0,
    }
    onPromoteSuccess?.(payload)
  }, [jobOk, srcDraftPath, job?.finalPath, job?.eventId, onPromoteSuccess])

  const destPathValid = useMemo(() => {
    if (destWikiPath.length === 0) return false
    if (destWikiPath.endsWith(".md") === false) return false
    return ALLOWED_DEST_PREFIXES.some((p) => destWikiPath.startsWith(p))
  }, [destWikiPath])

  const reasonValid = reason.trim().length > 0
  const auditPassed = auditHook.data?.passed === true
  const canPromote =
    !jobRunning && !!srcDraftPath && destPathValid && reasonValid && auditPassed === true

  // 关弹窗不取消任务（后台化本意）；只清视图态。job 留在 store 供行徽标/重开查看。
  const handleClose = () => {
    auditHook.reset()
    setDestWikiPath("")
    setReason("")
    setSuccessInfo(null)
    prefilledForSrcRef.current = null
    notifiedOkSrcRef.current = null
    onClose()
  }

  // 成功面板点「完成」：ok 项已被列表 refetch 消化，清掉 store 条目防堆积。
  // 德彪 r2 P1-1 · partial 不清——job 是关窗后 PartialSupersedeBanner 的数据源，
  // 清了告警就永久失踪（用户处理完/显式忽略才由 store action / 横幅清）。
  const handleSuccessClose = () => {
    if (srcDraftPath && job?.status !== "partial") clearJob(srcDraftPath)
    handleClose()
  }

  const handlePromote = () => {
    if (!srcDraftPath || !canPromote) return
    void startPromote({
      srcDraftPath,
      destWikiPath,
      callerAlias,
      reason,
      sourceMessageIds,
    })
  }

  // dest_exists 替换（小孙「失败了都不知道该不该丢弃」）：dest 用失败 job 记录的冲突路径
  // （非表单当前值——用户可能已改输入框），reason 用当前表单（必填校验同普通 promote）。
  // DEST_CONFLICT（CAS 拒绝）同样进对比面板——key 换掉强制 remount 重拉最新内容+新哈希。
  const isDestExistsFailure =
    job?.status === "failed" &&
    (job.errorCode === "DEST_EXISTS" || job.errorCode === "DEST_CONFLICT")
  const handleReplace = (expectedDestHash: string) => {
    if (!srcDraftPath || !job || !reasonValid) return
    void startPromote({
      srcDraftPath,
      destWikiPath: job.destWikiPath,
      callerAlias,
      reason,
      sourceMessageIds,
      allowReplace: true,
      expectedDestHash,
    })
  }

  // F042 AC3 · 同源撞车（双胞胎）：取代 = 带全部冲突路径重发（服务端要求全覆盖无半态）；
  // 去合并 = 中止（机器不合并内容，用户手动把增量并入已有条目）。
  const isSameSourceFailure =
    job?.status === "failed" &&
    job.errorCode === "SAME_SOURCE_EXISTS" &&
    (job.sameSourceConflicts?.length ?? 0) > 0
  const handleSupersede = () => {
    if (!srcDraftPath || !job || !reasonValid || !job.sameSourceConflicts) return
    void startPromote({
      srcDraftPath,
      destWikiPath: job.destWikiPath,
      callerAlias,
      reason,
      sourceMessageIds,
      supersedePaths: job.sameSourceConflicts.map((c) => c.path),
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
          {successInfo ? "Promote 成功" : "Promote draft → wiki"}
        </h2>

        {/* 补丁#3（小孙「好了没好看不懂」）：成功 → 显式成功面板，不再静默关弹窗 */}
        {successInfo ? (
          <PromoteSuccessView
            finalPath={successInfo.finalPath}
            replacedArchivePath={successInfo.replacedArchivePath}
            supersededPaths={successInfo.supersededPaths}
            // 德彪 r2 P1-1 · 失败清单读 store 实时值（处理后即时消行），快照只作面板开关
            supersedeFailures={job?.supersedeFailures ?? successInfo.supersedeFailures}
            onDemoteOld={
              srcDraftPath
                ? (oldPath) => void resolvePartialSupersede(srcDraftPath, oldPath, callerAlias)
                : undefined
            }
            onClose={handleSuccessClose}
          />
        ) : (
          <>
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
            {job?.status === "failed" && job.rejectReason ? (
              <RejectPanel
                title="Promote 被拒（commit 阶段二次审计 fail）"
                reject={job.rejectReason}
                advice={adviceForReject(job.rejectReason)}
              />
            ) : null}

            {/* dest_exists → 对比 + 一键替换（其余错误保持通用红框） */}
            {isDestExistsFailure && srcDraftPath ? (
              <ReplaceComparePanel
                key={`${job.errorCode}:${job.error ?? ""}`}
                srcDraftPath={srcDraftPath}
                destWikiPath={job.destWikiPath}
                onReplace={handleReplace}
                replaceDisabled={!reasonValid || jobRunning}
                conflictNotice={job.errorCode === "DEST_CONFLICT"}
              />
            ) : isSameSourceFailure && srcDraftPath && job.sameSourceConflicts ? (
              /* F042 AC3 · 同源撞车 → 对比 + 取代/去合并二选一 */
              <SameSourcePanel
                key={`${job.errorCode}:${job.sameSourceConflicts.map((c) => c.path).join(",")}`}
                srcDraftPath={srcDraftPath}
                conflicts={job.sameSourceConflicts}
                onSupersede={handleSupersede}
                supersedeDisabled={!reasonValid || jobRunning}
                onMerge={handleClose}
              />
            ) : job?.status === "failed" && job.error ? (
              <div className="mb-4 p-3 border border-red-300 rounded bg-red-50 text-sm text-red-700">
                <div className="font-medium">Promote error</div>
                <div className="text-xs mt-1 font-mono">{job.error}</div>
              </div>
            ) : null}

            {/* §6 后台化：进行中 → 非阻塞提示 + 可关闭（判官最长 ~60s，不再困住整页） */}
            {jobRunning ? (
              <>
                <div
                  className="mt-6 flex items-center gap-2 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700"
                  data-testid="promote-progress"
                  role="status"
                  aria-live="polite"
                >
                  <Spinner />
                  已提交，审核在后台进行——可以关闭本窗口，结果会显示在审批列表行。
                </div>
                <div className="flex justify-end mt-4">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
                  >
                    关闭（后台继续）
                  </button>
                </div>
              </>
            ) : (
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
                  className="px-4 py-2 text-sm bg-accent-500 text-white rounded hover:bg-accent-600 active:scale-[0.97] disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  Promote
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── 补丁#3：进度 spinner + 成功面板（小孙「好了没好看不懂」）─────────────────

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-300 border-t-blue-600"
      aria-hidden="true"
    />
  )
}

function PromoteSuccessView({
  finalPath,
  replacedArchivePath,
  supersededPaths,
  supersedeFailures,
  onDemoteOld,
  onClose,
}: {
  finalPath: string
  replacedArchivePath?: string
  supersededPaths?: string[]
  supersedeFailures?: Array<{ path: string; error: string }>
  /** 德彪 r2 P1-1 · 下架旧版（demote）——半态唯一由后端真实支持的补救路径。 */
  onDemoteOld?: (oldPath: string) => void
  onClose: () => void
}) {
  const hasPartial = (supersedeFailures?.length ?? 0) > 0
  return (
    <div data-testid="promote-success">
      <div className="mb-4 rounded border border-green-300 bg-green-50 p-4">
        <div className="flex items-center gap-1 font-medium text-green-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />已 promote 到正式 wiki
        </div>
        <div className="mt-2 text-xs text-green-700">
          落地路径：
          <span className="font-mono break-all">{finalPath}</span>
        </div>
        {replacedArchivePath ? (
          <div className="mt-1 text-xs text-green-700">
            旧页已归档（可恢复）：
            <span className="font-mono break-all">{replacedArchivePath}</span>
          </div>
        ) : null}
        {supersededPaths?.length ? (
          <div className="mt-1 text-xs text-green-700">
            旧版已取代归档：
            <span className="font-mono break-all">{supersededPaths.join("、")}</span>
          </div>
        ) : null}
        <div className="mt-1 text-xs text-green-600">该 draft 已从审批列表移除。</div>
      </div>
      {/* 德彪 r1 P1-3 · supersede 半态响亮警示：promote 本体成功但旧版归档失败——
          旧版仍在正式区和召回面，静默当完全成功会让用户以为取代已完成。 */}
      {hasPartial ? (
        <div
          data-testid="promote-supersede-partial"
          className="mb-4 rounded border border-amber-400 bg-amber-50 p-4"
        >
          <div className="font-medium text-amber-800">⚠ 旧版取代未完成（部分成功）</div>
          <div className="mt-2 text-xs text-amber-800">
            新页已落地，但以下旧版归档失败——<b>旧版仍在正式区且仍可被搜索到</b>：
          </div>
          <ul className="mt-1 space-y-1 text-xs text-amber-800">
            {supersedeFailures?.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-2">
                <span className="font-mono break-all">
                  {f.path}
                  <span className="ml-1 font-sans text-amber-600">（{f.error}）</span>
                </span>
                {onDemoteOld ? (
                  <button
                    type="button"
                    onClick={() => onDemoteOld(f.path)}
                    className="shrink-0 rounded bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
                    data-testid={`success-demote-old-${f.path}`}
                  >
                    下架旧版
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-xs text-amber-700">
            「下架旧版」= demote 归档（达成取代终效）。暂不处理也可关窗——KB/审批 tab
            顶部会持续显示此警示直到处理或显式忽略；处理前新旧双版并存。
          </div>
        </div>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700"
        >
          完成
        </button>
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
        结构检查通过 — 转正时做最终语义审计（LLM 判官）
      </div>
    )
  }
  return (
    <RejectPanel
      title="结构检查 FAIL"
      reject={audit.rejectReason!}
      advice={adviceForReject(audit.rejectReason!)}
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
