"use client"

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import {
  type WarningSeverity,
  type WarningSummary,
  useWarningsData,
} from "./wiki-meta/use-wiki-meta-data"

/**
 * F027 Phase 4 Week 4 Day 17 (AC-P4-9 a) · WarningsTab — 真数据
 *
 * 真相源:
 *   - V16.5 chap 18 line 1953 (WarningsTab → GET /api/wiki/warnings)
 *   - V16.5 chap 22 line 3208-3210 (wiki/warnings/ dead-ref / dedup / drift)
 *   - plan F027-phase4 AC-P4-9 a + Day 16 fixture seed (wiki/warnings/*.md)
 *
 * 接入:
 *   - useWarningsData() GET /api/wiki/warnings (Day 17 backend done)
 *   - enabled wire = activeLvl2 === "warnings" (防 always-render 启动并发 fetch,
 *     跟 draft-approval / prompt-inspector tab 同款防御)
 *
 * 不做 (Day 17 范围):
 *   - 不实现"解决"按钮 / 删除 / mark resolved (推 F028)
 *   - 不实现 filter by severity / subtype (推 Week 5)
 */
export function WarningsTab() {
  const activeLvl2 = useRuntimeLogStore((s) => s.activeLvl2)
  const { data, isLoading, error } = useWarningsData({
    enabled: activeLvl2 === "warnings",
  })

  return (
    <div className="flex flex-col gap-2 p-3 text-xs" data-testid="warnings-tab">
      <Header total={data.total} isLoading={isLoading} error={error} />
      <WarningList warnings={data.warnings} />
    </div>
  )
}

function Header({
  total,
  isLoading,
  error,
}: {
  total: number
  isLoading: boolean
  error: string | null
}) {
  return (
    <div
      className="flex items-center justify-between rounded border border-slate-200 bg-slate-50 px-2 py-1.5"
      data-testid="warnings-header"
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-500">
        警告 · {total} 条
      </div>
      {isLoading && (
        <span className="text-[10px] text-slate-400" data-testid="warnings-loading">
          ⏳
        </span>
      )}
      {error && (
        <span className="text-[10px] text-red-500" data-testid="warnings-error" title={error}>
          ⚠ 加载失败
        </span>
      )}
    </div>
  )
}

function WarningList({ warnings }: { warnings: WarningSummary[] }) {
  if (warnings.length === 0) {
    return (
      <div
        className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-[10px] text-slate-400"
        data-testid="warnings-empty"
      >
        暂无警告 (wiki/warnings/ 空)
      </div>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5" data-testid="warnings-list">
      {warnings.map((w) => (
        <li key={w.path}>
          <WarningRow warning={w} />
        </li>
      ))}
    </ul>
  )
}

function WarningRow({ warning }: { warning: WarningSummary }) {
  return (
    <div
      className={`rounded border px-2 py-1.5 ${severityRowClass(warning.severity)}`}
      data-testid={`warnings-row-${warning.path}`}
      data-subtype={warning.subtype}
      data-severity={warning.severity ?? "unknown"}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 truncate">
          <SeverityBadge severity={warning.severity} />
          <span className="font-mono text-[10px] text-slate-700">{warning.subtype}</span>
        </div>
        <span className="shrink-0 text-[9px] text-slate-400" title={warning.detectedAt ?? ""}>
          {warning.detectedAt ? formatRelative(warning.detectedAt) : "—"}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[9px] text-slate-500">
        {warning.source && <span>source: {warning.source}</span>}
        {warning.raisedBy && <span>by {warning.raisedBy}</span>}
      </div>
      {warning.summary && (
        <div className="mt-1 text-[10px] text-slate-600" title={warning.summary}>
          {truncate(warning.summary, 120)}
        </div>
      )}
    </div>
  )
}

function SeverityBadge({ severity }: { severity: WarningSeverity | null }) {
  const label = severity ?? "unknown"
  const cls =
    severity === "critical"
      ? "bg-red-100 text-red-800 border-red-300"
      : severity === "high"
        ? "bg-orange-100 text-orange-800 border-orange-300"
        : severity === "warn"
          ? "bg-amber-100 text-amber-800 border-amber-300"
          : severity === "info"
            ? "bg-blue-100 text-blue-800 border-blue-300"
            : "bg-slate-100 text-slate-600 border-slate-300"
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-semibold ${cls}`}
      data-testid={`warnings-severity-${label}`}
    >
      {label.toUpperCase()}
    </span>
  )
}

function severityRowClass(severity: WarningSeverity | null): string {
  switch (severity) {
    case "critical":
      return "border-red-200 bg-red-50"
    case "high":
      return "border-orange-200 bg-orange-50"
    case "warn":
      return "border-amber-200 bg-amber-50"
    case "info":
      return "border-blue-200 bg-blue-50"
    default:
      return "border-slate-200 bg-white"
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
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
