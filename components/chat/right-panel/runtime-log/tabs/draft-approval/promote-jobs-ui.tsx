/**
 * F027 promote 后台化 · tab 层共用件（审批 tab + KB tab）：
 *   - PromoteJobBadge：列表行的后台任务徽标（审核中/失败/已转正），数据源 promote-jobs-store
 *   - BatchPromoteBanner：批量进度/结果横幅（弹窗关掉后进度在这看）
 *   - usePromoteJobsAutoRefetch：有 ok 任务未消费 → refetch 列表（成功行消失）
 */
"use client"

import { useEffect } from "react"

import { usePromoteJobsStore } from "@/components/stores/promote-jobs-store"

export function PromoteJobBadge({ path }: { path: string }) {
  const job = usePromoteJobsStore((s) => s.jobs[path])
  if (!job) return null
  if (job.status === "running") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-medium text-blue-700 border border-blue-200"
        data-testid={`promote-job-badge-${path}`}
        title={`后台审核中 → ${job.destWikiPath}`}
      >
        <span className="inline-block h-2 w-2 animate-spin rounded-full border border-blue-300 border-t-blue-600" />
        审核中
      </span>
    )
  }
  if (job.status === "failed") {
    const detail = job.rejectReason
      ? `${job.rejectReason.layer}: ${job.rejectReason.hint}`
      : (job.error ?? "promote failed")
    return (
      <span
        className="inline-flex items-center rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-medium text-red-700 border border-red-200"
        data-testid={`promote-job-badge-${path}`}
        title={detail}
      >
        ❌ 失败（悬停看原因）
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center rounded bg-green-50 px-1.5 py-0.5 text-[9px] font-medium text-green-700 border border-green-200"
      data-testid={`promote-job-badge-${path}`}
      title={job.finalPath}
    >
      ✅ 已转正
    </span>
  )
}

/**
 * 行内 Promote 按钮（两 tab 共用）。德彪 r1 P1 配套：该行已有后台任务在跑时禁用——
 * 防「单篇后台在跑 + 再点一次/塞进批量」造成同 src 双路 promote（store 层同样有过滤兜底）。
 */
export function PromoteRowButton<T extends { path: string }>({
  draft,
  onPromote,
  testIdPrefix,
}: {
  draft: T
  onPromote: (d: T) => void
  testIdPrefix: string
}) {
  // 德彪 r2 P2：ok 也禁用——unlink-fail 时行仍在列表但已转正，放行会同 src 双路 promote
  const status = usePromoteJobsStore((s) => s.jobs[draft.path]?.status)
  const blocked = status === "running" || status === "ok"
  return (
    <button
      type="button"
      onClick={() => onPromote(draft)}
      disabled={blocked}
      className="rounded bg-blue-600 px-2 py-0.5 text-[9px] font-medium text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
      data-testid={`${testIdPrefix}-promote-${draft.path}`}
      title={
        status === "running"
          ? "该 draft 的后台审核进行中"
          : status === "ok"
            ? "该 draft 已转正（等列表刷新消行）"
            : "提升此 draft 到正式 wiki path (走 V14 二次审计)"
      }
    >
      Promote
    </button>
  )
}

export function BatchPromoteBanner() {
  const batch = usePromoteJobsStore((s) => s.batch)
  const dismissBatch = usePromoteJobsStore((s) => s.dismissBatch)
  if (!batch) return null
  if (batch.status === "running") {
    const pct = batch.progress.total > 0 ? (batch.progress.done / batch.progress.total) * 100 : 0
    return (
      <div
        className="rounded border border-purple-200 bg-purple-50 p-2 text-[10px] text-purple-800"
        data-testid="batch-promote-banner"
        role="status"
        aria-live="polite"
      >
        <div className="mb-1 flex justify-between">
          <span>批量审批后台进行中…</span>
          <span className="font-mono">
            {batch.progress.done}/{batch.progress.total}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded bg-purple-100">
          <div
            className="h-1.5 rounded bg-purple-600 transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    )
  }
  return (
    <div
      className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 p-2 text-[10px] text-slate-700"
      data-testid="batch-promote-banner"
    >
      <span>
        批量审批完成：{batch.summary?.success.length ?? 0} 成功 /{" "}
        {batch.summary?.failed.length ?? 0} 失败
        {batch.error ? `（部分未提交：${batch.error}）` : ""}
        {batch.summary?.failed.length ? " — 失败行悬停 ❌ 徽标看原因" : ""}
      </span>
      <button
        type="button"
        onClick={dismissBatch}
        className="shrink-0 rounded border px-2 py-0.5 hover:bg-white"
        data-testid="batch-promote-banner-dismiss"
      >
        知道了
      </button>
    </div>
  )
}

/** 有已成功且未消费的后台 promote → refetch 列表（成功的 draft 已 unlink，行应消失）。 */
export function usePromoteJobsAutoRefetch(refetch: () => void): void {
  const settledUnconsumed = usePromoteJobsStore((s) => s.settledUnconsumed)
  const markSettledConsumed = usePromoteJobsStore((s) => s.markSettledConsumed)
  useEffect(() => {
    if (!settledUnconsumed) return
    markSettledConsumed()
    refetch()
  }, [settledUnconsumed, markSettledConsumed, refetch])
}

/**
 * 德彪 r1 P2 + r2 P2 · 对账式 ok GC：拿「当前 drafts 列表」对账——已消失的 ok 项安全清理
 * （防同 path 未来 draft 顶陈旧「已转正」徽标）；仍在列表的 ok 项保留护栏（后端 unlink-fail
 * 被吞、src 留盘时，挡同 src 再 promote）。仅在列表加载成功时对账（loading/error 不动）。
 */
export function usePromoteOkJobsGc(drafts: readonly { path: string }[], enabled: boolean): void {
  const pruneOkJobsMissingFrom = usePromoteJobsStore((s) => s.pruneOkJobsMissingFrom)
  useEffect(() => {
    if (!enabled) return
    pruneOkJobsMissingFrom(drafts.map((d) => d.path))
  }, [enabled, drafts, pruneOkJobsMissingFrom])
}
