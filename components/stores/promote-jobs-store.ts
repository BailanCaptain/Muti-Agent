/**
 * F027 · promote 后台化（小孙「promote 会把整个网占住」，2026-06-15 拍方案 1）
 *
 * 单篇/批量 promote 的提交生命周期从弹窗组件搬进本 store：
 *   - fetch 在 store action 里跑，弹窗关掉请求照常进行（posture C 判官单篇最长 ~60s，
 *     阻塞式弹窗在判官时代不可用）
 *   - 弹窗/列表行/批量横幅都从这里读状态：jobs 按 srcDraftPath 记单篇（批量的每项
 *     也落 jobs，行徽标单/批同源），batch 记批量整体进度
 *   - 完成（有 ok 项）置 settledUnconsumed → tab 端 refetch 列表后调 markSettledConsumed
 *
 * 不做：持久化（刷新页面丢 in-flight 展示，但 promote 本身是服务端事实，列表 refetch 即真相）。
 */
"use client"

import type {
  BatchPromoteRequest,
  BatchPromoteResponse,
  BatchPromoteSummary,
} from "@/components/chat/right-panel/runtime-log/batch-promote-modal/use-batch-promote-api"
import type {
  PromoteCommitBody,
  PromoteCommitGenericError,
  PromoteCommitResponse,
  V14RejectReason,
} from "@/components/chat/right-panel/runtime-log/promote-modal/use-promote-api"
import { create } from "zustand"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
/** 后端单次上限（mirror routes/phase4/batch-promote MAX_BATCH_ITEMS=50）。 */
const MAX_BATCH_ITEMS = 50

export interface PromoteJob {
  srcDraftPath: string
  destWikiPath: string
  status: "running" | "ok" | "failed"
  finalPath?: string
  eventId?: number
  /** 422 二次审计拒绝（弹窗 RejectPanel / 行徽标 title 用）。 */
  rejectReason?: V14RejectReason
  /** 网络/4xx/5xx 文案。 */
  error?: string
  fromBatch?: boolean
}

export interface BatchRun {
  status: "running" | "done"
  progress: { done: number; total: number }
  summary: BatchPromoteSummary | null
  error: string | null
}

type PromoteJobsStore = {
  jobs: Record<string, PromoteJob>
  batch: BatchRun | null
  /** 有 ok 且列表尚未 refetch 消费 → tab 端 useEffect 触发 refetch 后 markSettledConsumed()。 */
  settledUnconsumed: boolean
  startPromote: (body: PromoteCommitBody) => Promise<void>
  startBatch: (req: BatchPromoteRequest) => Promise<void>
  clearJob: (srcDraftPath: string) => void
  /** 对账式 GC：只清已从当前列表消失的 ok 项（在列的保留护栏——unlink-fail 兜底）。 */
  pruneOkJobsMissingFrom: (presentPaths: readonly string[]) => void
  dismissBatch: () => void
  markSettledConsumed: () => void
  /** 测试隔离用（zustand module 级单例跨用例保留状态）。 */
  resetAll: () => void
}

function setJob(
  set: (
    fn: (s: { jobs: Record<string, PromoteJob> }) => { jobs: Record<string, PromoteJob> },
  ) => void,
  job: PromoteJob,
): void {
  set((s) => ({ jobs: { ...s.jobs, [job.srcDraftPath]: job } }))
}

export const usePromoteJobsStore = create<PromoteJobsStore>((set, get) => ({
  jobs: {},
  batch: null,
  settledUnconsumed: false,

  startPromote: async (body) => {
    // 德彪 r2 P2：ok 也挡——unlink-fail 时后端返 ok 但 src 留盘（行还在列表），
    // 若放行会同 src 再 promote 到另一 dest。护栏由对账式 GC 在行真消失后解除。
    const cur = get().jobs[body.srcDraftPath]
    if (cur?.status === "running" || cur?.status === "ok") return
    const base: PromoteJob = {
      srcDraftPath: body.srcDraftPath,
      destWikiPath: body.destWikiPath,
      status: "running",
    }
    setJob(set, base)
    try {
      const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const raw = (await resp.json()) as PromoteCommitResponse
      if (raw.ok) {
        setJob(set, { ...base, status: "ok", finalPath: raw.finalPath, eventId: raw.eventId })
        set({ settledUnconsumed: true })
        return
      }
      if (resp.status === 422 && raw.code === "AUDIT_REJECTED" && "audit" in raw) {
        setJob(set, { ...base, status: "failed", rejectReason: raw.audit })
        return
      }
      setJob(set, {
        ...base,
        status: "failed",
        error: `${raw.code}: ${(raw as PromoteCommitGenericError).error ?? "promote failed"}`,
      })
    } catch (err) {
      setJob(set, { ...base, status: "failed", error: (err as Error).message ?? "network error" })
    }
  },

  startBatch: async (req) => {
    if (get().batch?.status === "running") return
    // 德彪 r1 P1：同 src 已有 running（单篇后台在跑）/ ok（已转正待 refetch 消行）的项
    // 必须过滤——否则同一 draft 会被两条路 promote 到两个 dest（后端只 lease dest 不锁 src）。
    const jobsNow = get().jobs
    const items = req.items.filter((it) => {
      const cur = jobsNow[it.srcDraftPath]
      return !(cur?.status === "running" || cur?.status === "ok")
    })
    const skipped = req.items.length - items.length
    if (items.length === 0) {
      set({
        batch: {
          status: "done",
          progress: { done: 0, total: 0 },
          summary: null,
          error: `所选 ${skipped} 篇均已有进行中/已完成的 promote，任务未提交`,
        },
      })
      return
    }
    const total = items.length
    set({ batch: { status: "running", progress: { done: 0, total }, summary: null, error: null } })
    for (const item of items) {
      setJob(set, {
        srcDraftPath: item.srcDraftPath,
        destWikiPath: item.destWikiPath,
        status: "running",
        fromBatch: true,
      })
    }
    // 语义与原 useBatchPromote 一致：>50 切片顺序提交；整体失败中断后续分片，
    // 已完成分片结果保留（promote 是已发生事实必须如实展示），error 置位提示剩余未提交。
    const merged: BatchPromoteSummary = { ok: true, total: 0, success: [], failed: [] }
    let firstError: string | null = null
    let done = 0
    const submittedPaths = new Set<string>()
    try {
      for (let i = 0; i < items.length; i += MAX_BATCH_ITEMS) {
        const chunk = items.slice(i, i + MAX_BATCH_ITEMS)
        const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/batch-promote`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...req, items: chunk }),
        })
        const raw = (await resp.json()) as BatchPromoteResponse
        if (!raw.ok) {
          firstError = `${raw.code}: ${raw.error ?? "batch promote failed"}`
          break
        }
        merged.total += raw.total
        merged.success.push(...raw.success)
        merged.failed.push(...raw.failed)
        for (const s of raw.success) {
          submittedPaths.add(s.srcDraftPath)
          setJob(set, {
            srcDraftPath: s.srcDraftPath,
            destWikiPath: s.destWikiPath,
            status: "ok",
            finalPath: s.finalPath,
            eventId: s.eventId,
            fromBatch: true,
          })
        }
        for (const f of raw.failed) {
          submittedPaths.add(f.srcDraftPath)
          setJob(set, {
            srcDraftPath: f.srcDraftPath,
            destWikiPath: f.destWikiPath,
            status: "failed",
            rejectReason: f.auditReject,
            error: f.auditReject ? undefined : `${f.status}: ${f.error}`,
            fromBatch: true,
          })
        }
        done += chunk.length
        set((s) =>
          s.batch ? { batch: { ...s.batch, progress: { done, total } } } : { batch: s.batch },
        )
      }
    } catch (err) {
      firstError = (err as Error).message ?? "network error"
    }
    // 中断/异常时：未提交的行退回 failed（诚实标注未提交，而非留 running 假象）
    if (firstError) {
      for (const item of items) {
        if (submittedPaths.has(item.srcDraftPath)) continue
        const cur = get().jobs[item.srcDraftPath]
        if (cur?.status === "running" && cur.fromBatch) {
          setJob(set, { ...cur, status: "failed", error: "未提交（前序分片失败中断）" })
        }
      }
    }
    set({
      batch: {
        status: "done",
        progress: { done, total },
        summary: merged.total > 0 ? merged : null,
        error: firstError,
      },
    })
    if (merged.success.length > 0) set({ settledUnconsumed: true })
  },

  clearJob: (srcDraftPath) =>
    set((s) => {
      const next = { ...s.jobs }
      delete next[srcDraftPath]
      return { jobs: next }
    }),

  // 德彪 r1 P2 + r2 P2：对账式 GC——只清「已从当前 drafts 列表消失」的 ok 项（正常转正
  // 后行被 unlink，refetch 消失 → 安全 GC 防陈旧徽标）；仍在列表的 ok 项保留（后端
  // unlink-fail 被吞、src 留盘的场景，护栏必须留着挡同 src 再 promote）。
  // 弹窗成功面板已是本地快照，不依赖 store 条目存活。
  pruneOkJobsMissingFrom: (presentPaths) => {
    const present = new Set(presentPaths)
    set((s) => {
      const next: Record<string, PromoteJob> = {}
      for (const [k, v] of Object.entries(s.jobs)) {
        if (v.status === "ok" && !present.has(k)) continue
        next[k] = v
      }
      return { jobs: next }
    })
  },

  dismissBatch: () => set({ batch: null }),

  markSettledConsumed: () => set({ settledUnconsumed: false }),

  resetAll: () => set({ jobs: {}, batch: null, settledUnconsumed: false }),
}))
