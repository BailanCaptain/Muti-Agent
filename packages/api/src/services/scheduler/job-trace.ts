/**
 * F027 P19.4 · Job Trace 契约 — schema 冻结
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md §4 + AC-P2-4 (v2b F2)
 *
 * 落点：`<rootDir>/.runtime/job-traces/<jobName>/<YYYY-MM-DD>/<HHMMSS-runId>.json`
 *
 * v2b F2 status enum 8 种：
 *   ok / failed / timeout / skipped_reentry / skipped_not_leader /
 *   missed_window / recovered_from_crash / lease_lost
 *
 * v2b F2 reason enum ≥ 4 种（区分 skipped_not_leader 三段 guard + heartbeat 失败）：
 *   lease_expired / lease_lost / role_not_leader / heartbeat_failed
 *
 * v2a F3 时间窗字段：scheduledFor / windowStart / windowEnd 必填。
 *
 * Phase 3 scheduler panel 直接读 .runtime/job-traces/ 目录；
 * failed / timeout / recovered_from_crash / lease_lost 同时推 R-201 告警
 * （**不写 wiki_events**——避免 enum drift / Iron Laws 3）。
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export const JOB_TRACE_SCHEMA_VERSION = "1.0"

/** v2b F2 锁定 8 种 status enum。 */
export type JobTraceStatus =
  | "ok"
  | "failed"
  | "timeout"
  | "skipped_reentry"
  | "skipped_not_leader"
  | "missed_window"
  | "recovered_from_crash"
  | "lease_lost"

export const JOB_TRACE_STATUS_VALUES: ReadonlyArray<JobTraceStatus> = [
  "ok",
  "failed",
  "timeout",
  "skipped_reentry",
  "skipped_not_leader",
  "missed_window",
  "recovered_from_crash",
  "lease_lost",
]

/** v2b F2 锁定 ≥ 4 种 reason enum。 */
export type JobTraceReason =
  | "lease_expired"
  | "lease_lost"
  | "role_not_leader"
  | "heartbeat_failed"

export const JOB_TRACE_REASON_VALUES: ReadonlyArray<JobTraceReason> = [
  "lease_expired",
  "lease_lost",
  "role_not_leader",
  "heartbeat_failed",
]

export interface JobTrace {
  /** 永远 "1.0"（schema 冻结后改新版需 bump）。 */
  schemaVersion: string
  jobName: string
  /** uuid v4。 */
  runId: string
  /** v2a F3 时间窗：cron 触发时刻（ISO UTC）。 */
  scheduledFor: string
  /** v2a F3 时间窗：有效窗口起点（通常 = scheduledFor）。 */
  windowStart: string
  /** v2a F3 时间窗：有效窗口终点（默认 scheduledFor + min(cron_period, 5min)）。 */
  windowEnd: string
  /** 实际开跑时刻；skipped/missed_window 时为 null。 */
  startedAt: string | null
  /** 完成时刻；skipped/timeout 时为 null（timeout 是 finishedAt 写但 status=timeout）。 */
  finishedAt: string | null
  /** finishedAt - startedAt；skipped 时 null。 */
  durationMs: number | null
  status: JobTraceStatus
  /** 当时 leaderTerm；skipped_not_leader (role_not_leader) 时可能为 null。 */
  leaderTerm: string | null
  /** skipped_not_leader 必填；其他可 null。 */
  reason: JobTraceReason | null
  /** Job-specific result payload（structurally cloneable）。 */
  result: unknown
  /** failed/timeout 必填；其他 null。 */
  error: { message: string; stack?: string } | null
  /** failed/timeout/recovered_from_crash/lease_lost 推 R-201；记 room id；其他 null。 */
  alertedRoom: string | null
}

/**
 * Schema 校验。任何字段缺失 / 类型错 / enum 越界都抛 Error。
 *
 * 不做：
 *   - 业务规则交叉校验（如 status='ok' 时 error 必须 null）—— 本契约只锁
 *     字段存在性 + 类型 + enum 成员。业务规则由各 job runner 自己保证。
 */
export function validateJobTrace(t: JobTrace): void {
  if (t.schemaVersion !== JOB_TRACE_SCHEMA_VERSION) {
    throw new Error(
      `job_trace: schemaVersion must be '${JOB_TRACE_SCHEMA_VERSION}', got '${t.schemaVersion}'`,
    )
  }
  requireNonEmptyString(t, "jobName")
  requireNonEmptyString(t, "runId")
  requireIsoUtc(t, "scheduledFor")
  requireIsoUtc(t, "windowStart")
  requireIsoUtc(t, "windowEnd")
  requireIsoUtcOrNull(t, "startedAt")
  requireIsoUtcOrNull(t, "finishedAt")
  if (t.durationMs !== null && (typeof t.durationMs !== "number" || t.durationMs < 0)) {
    throw new Error("job_trace: durationMs must be non-negative number or null")
  }
  if (!JOB_TRACE_STATUS_VALUES.includes(t.status)) {
    throw new Error(
      `job_trace: invalid status '${t.status}'; allowed: ${JOB_TRACE_STATUS_VALUES.join("|")}`,
    )
  }
  if (t.leaderTerm !== null && typeof t.leaderTerm !== "string") {
    throw new Error("job_trace: leaderTerm must be string or null")
  }
  if (t.reason !== null && !JOB_TRACE_REASON_VALUES.includes(t.reason)) {
    throw new Error(
      `job_trace: invalid reason '${t.reason}'; allowed: ${JOB_TRACE_REASON_VALUES.join("|")} or null`,
    )
  }
  if (t.error !== null && (typeof t.error !== "object" || typeof t.error.message !== "string")) {
    throw new Error("job_trace: error must be { message: string, stack?: string } or null")
  }
  if (t.alertedRoom !== null && typeof t.alertedRoom !== "string") {
    throw new Error("job_trace: alertedRoom must be string or null")
  }
}

export interface WriteJobTraceOptions {
  /** 默认 process.cwd()。 */
  rootDir?: string
  trace: JobTrace
  /** 测试注入时钟决定 dir 切片。 */
  clock?: () => Date
}

export interface WriteJobTraceResult {
  absolutePath: string
}

/**
 * 写 trace 到 `<rootDir>/.runtime/job-traces/<jobName>/<YYYY-MM-DD>/<HHMMSS-runId>.json`。
 *
 * Atomic：先写 .tmp，再 rename（防 reader 读到半文件）。
 *
 * Iron Laws 1：不删 / 不改既有 trace；同 runId 重复写会覆盖（业务侧应保证 runId 唯一）。
 */
export function writeJobTrace(opts: WriteJobTraceOptions): WriteJobTraceResult {
  validateJobTrace(opts.trace)
  const root = opts.rootDir ?? process.cwd()
  const tsDate = opts.clock?.() ?? new Date()
  const tsIso = tsDate.toISOString()
  const yyyymmdd = tsIso.slice(0, 10) // 2026-05-15
  const hhmmss = tsIso.slice(11, 19).replace(/:/g, "") // 040002
  const dir = path.join(root, ".runtime", "job-traces", opts.trace.jobName, yyyymmdd)
  fs.mkdirSync(dir, { recursive: true })
  const absolutePath = path.join(dir, `${hhmmss}-${opts.trace.runId}.json`)
  const tmpPath = `${absolutePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(opts.trace, null, 2), "utf-8")
  fs.renameSync(tmpPath, absolutePath)
  return { absolutePath }
}

/** 生成新 runId（uuid v4）。 */
export function newRunId(): string {
  return randomUUID()
}

// ── private helpers ────────────────────────────────────────────────────

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function requireNonEmptyString<K extends keyof JobTrace>(t: JobTrace, field: K): void {
  const v = t[field]
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`job_trace: '${String(field)}' must be non-empty string`)
  }
}

function requireIsoUtc<K extends keyof JobTrace>(t: JobTrace, field: K): void {
  const v = t[field]
  if (typeof v !== "string" || !ISO_UTC_RE.test(v)) {
    throw new Error(`job_trace: '${String(field)}' must be ISO UTC like 2026-05-15T04:00:00.000Z`)
  }
}

function requireIsoUtcOrNull<K extends keyof JobTrace>(t: JobTrace, field: K): void {
  const v = t[field]
  if (v === null) return
  if (typeof v !== "string" || !ISO_UTC_RE.test(v)) {
    throw new Error(`job_trace: '${String(field)}' must be ISO UTC string or null`)
  }
}
