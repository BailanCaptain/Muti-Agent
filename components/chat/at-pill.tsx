"use client"

import type { PendingChangePayload, TimelineMessage } from "@multi-agent/shared"
import { CheckCircle2, Eye, Hourglass, Loader2, RotateCcw, TimerOff, XCircle } from "lucide-react"

/**
 * F026 P5 F1 · @ pill 状态机六态
 *
 * 接收 connector message 上 LEFT JOIN 来的 a2a_calls.status，映射到六个用户可见
 * 状态。timeout / error 两态可选传 onRetry 回调显示重发按钮（按钮位接管点击事件，
 * 阻止冒泡避免触发 connector card click）。
 *
 * 跟 P3.1 dispatch-retry-progress-card 的关系：
 *   - retry-progress-card 是 dispatch validation 阶段的进度卡（assistant final 落库前）
 *   - AtPill 是 a2a 派发后到 settle 全生命周期的状态展示（connector message 上）
 *   - 两者作用在不同 message 上，不冲突；retry 卡走 assistant message-bubble，
 *     AtPill 走 connector-bubble（a2a 分支）。
 */

export type AtPillStatus = "sending" | "ack" | "working" | "done" | "timeout" | "error"

const STATUS_META: Record<
  AtPillStatus,
  {
    label: string
    Icon: typeof Hourglass
    spin?: boolean
    bg: string
    text: string
    border: string
  }
> = {
  sending: {
    label: "派发中",
    Icon: Hourglass,
    bg: "bg-slate-50/80",
    text: "text-slate-600",
    border: "border-slate-200",
  },
  ack: {
    label: "已阅",
    Icon: Eye,
    bg: "bg-sky-50/80",
    text: "text-sky-700",
    border: "border-sky-200",
  },
  working: {
    label: "处理中",
    Icon: Loader2,
    spin: true,
    bg: "bg-amber-50/80",
    text: "text-amber-800",
    border: "border-amber-200",
  },
  done: {
    label: "已完成",
    Icon: CheckCircle2,
    bg: "bg-emerald-50/80",
    text: "text-emerald-700",
    border: "border-emerald-200",
  },
  timeout: {
    label: "超时",
    Icon: TimerOff,
    bg: "bg-red-50/80",
    text: "text-red-700",
    border: "border-red-200",
  },
  error: {
    label: "失败",
    Icon: XCircle,
    bg: "bg-rose-50/80",
    text: "text-rose-700",
    border: "border-rose-200",
  },
}

export function AtPill({
  targetAlias,
  status,
  onRetry,
}: {
  targetAlias?: string
  status: AtPillStatus
  onRetry?: () => void
}) {
  const meta = STATUS_META[status]
  const { Icon } = meta
  const showRetry = !!onRetry && (status === "timeout" || status === "error")

  return (
    <span
      data-testid="at-pill"
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-caption ${meta.bg} ${meta.text} ${meta.border}`}
    >
      <Icon className={`h-3 w-3 ${meta.spin ? "animate-spin" : ""}`} aria-hidden="true" />
      {targetAlias ? <span className="font-medium">@{targetAlias}</span> : null}
      <span>{meta.label}</span>
      {showRetry ? (
        <button
          data-testid="at-pill-retry"
          type="button"
          aria-label={`重发 @${targetAlias ?? ""}`}
          onClick={(e) => {
            e.stopPropagation()
            onRetry?.()
          }}
          className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-surface-canvas px-1.5 py-0.5 text-micro font-medium text-rose-700 transition hover:bg-surface-elevated"
        >
          <RotateCcw className="h-2.5 w-2.5" aria-hidden="true" />
          重发
        </button>
      ) : null}
    </span>
  )
}

/**
 * 把后端 a2a_calls.status（ADR-004 状态机：pending / working / done / failed / timeout / cancelled）
 * 映射到 AtPill 六态。未知值 fallback 'sending'（forward-compat — 后端加新状态前端不崩）。
 */
export function deriveAtPillStatus(callStatus: string | null | undefined): AtPillStatus {
  switch (callStatus) {
    case "pending":
      return "ack"
    case "working":
      return "working"
    case "done":
      return "done"
    case "timeout":
      return "timeout"
    case "failed":
    case "cancelled":
      return "error"
    default:
      return "sending"
  }
}

/**
 * F026 P5 F1 follow-up · 实时 status 反查 pendingByRoot
 *
 * connector_message 上 LEFT JOIN 来的 a2aCallStatus 是 message.created 那一瞬间的快照；
 * 之后 a2a_calls.status 流转（pending→working→done）只 emit `pending.change`（喂
 * thread-store.pendingByRoot / settledByRoot），不重发 message envelope。直接用
 * snapshot 会让 AtPill 永远停在第一次拿到的状态。
 *
 * 反查策略（F026 review#4 fix · A'，三档 fallback）：
 *   1. pendingByRoot[rootCallId] 命中 → entry.status（pending → "ack" / working → "working"）
 *   2. settledByRoot[rootCallId][callId] 命中 → 终态映射（done/failed/timeout/cancelled）
 *      —— 解决 settle 后 entry 离开 pendingSet 但 envelope 不重发导致 AtPill 卡 ack 的 P1
 *   3. fallback 到 message envelope snapshot（向后兼容 / 字段缺失）
 *
 * settledByRoot 不能在 root 收口（pendingSet 空 → 删 pendingByRoot key）时同步清掉，
 * 否则单 child settle 场景立即回落 snapshot=pending = ack — P1 还在。
 * 仅在 active group 切换 / snapshot 重载时清。
 */
export type SettledByRoot = Record<
  string,
  Record<string, "done" | "failed" | "timeout" | "cancelled">
>

export function deriveLiveAtPillStatus(
  message: Pick<TimelineMessage, "a2aCallId" | "a2aRootCallId" | "a2aCallStatus">,
  pendingByRoot: Record<string, PendingChangePayload["pendingSet"]>,
  settledByRoot: SettledByRoot = {},
): AtPillStatus {
  const { a2aCallId: callId, a2aRootCallId: rootCallId } = message
  if (callId && rootCallId) {
    const pendingSet = pendingByRoot[rootCallId]
    if (pendingSet) {
      const entry = pendingSet.find((row) => row.callId === callId)
      if (entry) {
        return entry.status === "pending" ? "ack" : "working"
      }
    }
    const terminal = settledByRoot[rootCallId]?.[callId]
    if (terminal) {
      return deriveAtPillStatus(terminal)
    }
  }
  return deriveAtPillStatus(message.a2aCallStatus)
}
