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
 * 持久边界：常规 running/ok/failed 仍是展示缓存；supersede partial 是服务端未收敛事实，
 * 从 wiki_events 账本重建，刷新页面不能丢。
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
import { create, type StoreApi } from "zustand"

const API_BASE_URL = process.env.NEXT_PUBLIC_API_HTTP_URL ?? "http://localhost:8787"
/** 后端单次上限（mirror routes/phase4/batch-promote MAX_BATCH_ITEMS=50）。 */
const MAX_BATCH_ITEMS = 50

export interface PromoteJob {
  srcDraftPath: string
  destWikiPath: string
  /**
   * 德彪 r2 P1-1 · "partial" = promote 本体成功但 supersede 归档有失败（旧版仍在正式区）。
   * 与 "ok" 分开：ok-GC（pruneOkJobsMissingFrom）只清 ok——partial 必须存活到用户处理
   * （下架旧版/显式忽略），否则告警随 draft 行消失而永久丢失。
   */
  status: "running" | "ok" | "partial" | "failed"
  finalPath?: string
  eventId?: number
  /** 422 二次审计拒绝（弹窗 RejectPanel / 行徽标 title 用）。 */
  rejectReason?: V14RejectReason
  /** 网络/4xx/5xx 文案。 */
  error?: string
  /** 后端错误码（如 DEST_EXISTS → 弹窗给「对比+替换」面板）。 */
  errorCode?: string
  /** 替换成功时：旧页归档到的 _rejected/ 相对路径（成功面板展示）。 */
  replacedArchivePath?: string
  /** F042 AC3 · SAME_SOURCE_EXISTS 载荷：同源冲突条目（SameSourcePanel 数据源）。 */
  sameSourceConflicts?: Array<{ path: string; title: string }>
  /** F042 AC3 · 取代成功归档的旧版路径（成功面板展示）。 */
  supersededPaths?: string[]
  /**
   * 德彪 r1 P1-3 · supersede 半态：promote 本体成功但旧版归档失败（旧版仍在正式区+
   * 召回面）。此前 store 丢弃该字段 → Modal 显示完全成功 = 用户以为取代完成。必须透出。
   */
  supersedeFailures?: Array<{ path: string; error: string; eventId?: number }>
  /** F3 · path 级 in-flight 锁；settle 时基于当前 state 原子移除。 */
  pendingSupersedePaths?: string[]
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
  partialHydration: "idle" | "loading" | "loaded"
  hydratePartialSupersedes: () => Promise<void>
  startPromote: (body: PromoteCommitBody) => Promise<void>
  startBatch: (req: BatchPromoteRequest) => Promise<void>
  /**
   * 德彪 r2 P1-1 · partial 半态的可行处理路径：下架仍在正式区的旧版（demote → _rejected/
   * 归档），达成取代的最终效果。src draft 在 promote 时已删，「重试 supersede」不存在——
   * demote 旧版是唯一由后端真实支持的补救操作。成功 → 从 failures 移除；清零 → 转 ok
   * （随后自然被 GC）。失败 → 保留 failures 并更新该项 error（可再试）。
   */
  resolvePartialSupersede: (
    srcDraftPath: string,
    oldPath: string,
    callerAlias: string,
  ) => Promise<boolean>
  dismissPartialSupersede: (srcDraftPath: string, callerAlias: string) => Promise<boolean>
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

function updatePartialFailure(
  set: StoreApi<PromoteJobsStore>["setState"],
  srcDraftPath: string,
  oldPath: string,
  error: string,
): void {
  set((s) => {
    const current = s.jobs[srcDraftPath]
    if (!current) return { jobs: s.jobs }
    const pending = (current.pendingSupersedePaths ?? []).filter((path) => path !== oldPath)
    return {
      jobs: {
        ...s.jobs,
        [srcDraftPath]: {
          ...current,
          supersedeFailures: current.supersedeFailures?.map((failure) =>
            failure.path === oldPath ? { ...failure, error } : failure,
          ),
          pendingSupersedePaths: pending.length > 0 ? pending : undefined,
        },
      },
    }
  })
}

export const usePromoteJobsStore = create<PromoteJobsStore>((set, get) => ({
  jobs: {},
  batch: null,
  settledUnconsumed: false,
  partialHydration: "idle",

  hydratePartialSupersedes: async () => {
    if (get().partialHydration !== "idle") return
    set({ partialHydration: "loading" })
    try {
      const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/partial-supersedes`)
      const raw = (await resp.json()) as {
        ok?: boolean
        failures?: Array<{
          eventId: number
          path: string
          promotionTarget: string
          error: string
        }>
      }
      if (!resp.ok || !raw.ok || !Array.isArray(raw.failures)) {
        set({ partialHydration: "idle" })
        return
      }
      set((s) => {
        const jobs = { ...s.jobs }
        for (const failure of raw.failures ?? []) {
          const key = `wiki-events/partial-supersede/${failure.eventId}`
          jobs[key] = {
            srcDraftPath: key,
            destWikiPath: failure.promotionTarget,
            finalPath: failure.promotionTarget,
            status: "partial",
            supersedeFailures: [
              { path: failure.path, error: failure.error, eventId: failure.eventId },
            ],
          }
        }
        return { jobs, partialHydration: "loaded" }
      })
    } catch {
      set({ partialHydration: "idle" })
    }
  },

  startPromote: async (body) => {
    // 德彪 r2 P2：ok 也挡——unlink-fail 时后端返 ok 但 src 留盘（行还在列表），
    // 若放行会同 src 再 promote 到另一 dest。护栏由对账式 GC 在行真消失后解除。
    const cur = get().jobs[body.srcDraftPath]
    if (cur?.status === "running" || cur?.status === "ok" || cur?.status === "partial") return
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
        setJob(set, {
          ...base,
          // 德彪 r1 P1-3 + r2 P1-1 · supersede 半态 = "partial"（不许静默当完全成功；
          // 且不许被 ok-GC 清——旧版仍在正式区+召回面，告警必须存活到被处理）
          status: raw.supersedeFailures?.length ? "partial" : "ok",
          finalPath: raw.finalPath,
          eventId: raw.eventId,
          replacedArchivePath: raw.replacedArchivePath,
          supersededPaths: raw.supersededPaths,
          supersedeFailures: raw.supersedeFailures,
        })
        set({ settledUnconsumed: true })
        return
      }
      if (resp.status === 422 && raw.code === "AUDIT_REJECTED" && "audit" in raw) {
        setJob(set, { ...base, status: "failed", rejectReason: raw.audit })
        return
      }
      // F042 AC3 · 同源撞车：conflicts 载荷进 job，弹窗给「取代/去合并」面板
      if (raw.code === "SAME_SOURCE_EXISTS" && "conflicts" in raw) {
        setJob(set, {
          ...base,
          status: "failed",
          errorCode: raw.code,
          sameSourceConflicts: raw.conflicts,
          error: `${raw.code}: ${raw.error ?? "same-source entry exists"}`,
        })
        return
      }
      setJob(set, {
        ...base,
        status: "failed",
        errorCode: raw.code,
        error: `${raw.code}: ${(raw as PromoteCommitGenericError).error ?? "promote failed"}`,
      })
    } catch (err) {
      setJob(set, { ...base, status: "failed", error: (err as Error).message ?? "network error" })
    }
  },

  resolvePartialSupersede: async (srcDraftPath, oldPath, callerAlias) => {
    const job = get().jobs[srcDraftPath]
    if (
      !job ||
      job.status !== "partial" ||
      !job.supersedeFailures?.some((failure) => failure.path === oldPath) ||
      job.pendingSupersedePaths?.includes(oldPath)
    )
      return false
    set((s) => {
      const current = s.jobs[srcDraftPath]
      if (!current || current.status !== "partial") return { jobs: s.jobs }
      return {
        jobs: {
          ...s.jobs,
          [srcDraftPath]: {
            ...current,
            pendingSupersedePaths: [...(current.pendingSupersedePaths ?? []), oldPath],
          },
        },
      }
    })
    try {
      const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/demote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          srcWikiPath: oldPath,
          callerAlias,
          reason: `supersede 半态补救：下架未归档旧版（新版 ${job.finalPath ?? job.destWikiPath}）`,
        }),
      })
      const raw = (await resp.json()) as { ok?: boolean; error?: string; code?: string }
      if (!raw.ok) {
        updatePartialFailure(
          set,
          srcDraftPath,
          oldPath,
          `下架失败：${raw.code ?? ""} ${raw.error ?? ""}`,
        )
        return false
      }
      set((s) => {
        const current = s.jobs[srcDraftPath]
        if (!current) return { jobs: s.jobs }
        const remaining = (current.supersedeFailures ?? []).filter((f) => f.path !== oldPath)
        const pending = (current.pendingSupersedePaths ?? []).filter((path) => path !== oldPath)
        return {
          jobs: {
            ...s.jobs,
            [srcDraftPath]: {
              ...current,
              status: remaining.length === 0 ? "ok" : "partial",
              supersedeFailures: remaining.length > 0 ? remaining : undefined,
              pendingSupersedePaths: pending.length > 0 ? pending : undefined,
              supersededPaths: Array.from(new Set([...(current.supersededPaths ?? []), oldPath])),
            },
          },
        }
      })
      return true
    } catch (err) {
      updatePartialFailure(
        set,
        srcDraftPath,
        oldPath,
        `下架失败：${(err as Error).message}`,
      )
      return false
    }
  },

  dismissPartialSupersede: async (srcDraftPath, callerAlias) => {
    const job = get().jobs[srcDraftPath]
    if (!job || job.status !== "partial") return false
    const eventIds = (job.supersedeFailures ?? [])
      .map((failure) => failure.eventId)
      .filter((id): id is number => typeof id === "number")
    try {
      for (const failureEventId of eventIds) {
        const resp = await fetch(`${API_BASE_URL}/api/wiki/drafts/partial-supersedes/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ failureEventId, callerAlias, resolution: "dismissed" }),
        })
        const raw = (await resp.json()) as { ok?: boolean }
        if (!resp.ok || !raw.ok) return false
      }
      get().clearJob(srcDraftPath)
      return true
    } catch {
      return false
    }
  },

  startBatch: async (req) => {
    if (get().batch?.status === "running") return
    // 德彪 r1 P1：同 src 已有 running（单篇后台在跑）/ ok（已转正待 refetch 消行）的项
    // 必须过滤——否则同一 draft 会被两条路 promote 到两个 dest（后端只 lease dest 不锁 src）。
    const jobsNow = get().jobs
    const items = req.items.filter((it) => {
      const cur = jobsNow[it.srcDraftPath]
      return !(cur?.status === "running" || cur?.status === "ok" || cur?.status === "partial")
    })
    const skipped = req.items.length - items.length
    if (items.length === 0) {
      set({
        batch: {
          status: "done",
          progress: { done: 0, total: 0 },
          summary: null,
          error: `所选 ${skipped} 篇均已有进行中/已完成/待处理半态的 promote，任务未提交`,
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
            // 德彪 replace-r1 P2：batch 撞 dest_exists 也要映射 errorCode——用户重开该行的
            // 单篇 PromoteModal 才能进「对比+替换」流（batch 本身不支持 replace，by design）。
            errorCode: f.status === "dest_exists" ? "DEST_EXISTS" : undefined,
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

  resetAll: () =>
    set({ jobs: {}, batch: null, settledUnconsumed: false, partialHydration: "idle" }),
}))
