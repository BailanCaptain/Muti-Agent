"use client"

import { Loader2, RefreshCw } from "lucide-react"
import type { DispatchValidationRetryReason } from "@multi-agent/shared"
import { useDispatchRetryStore } from "../stores/dispatch-retry-store"

/**
 * F026 P3.1 · AC-14 实时进度卡
 *
 * 订阅 `useDispatchRetryStore` 中按 messageId 索引的 retry payload，
 * 渲染「🔄 派发格式不合契约，正在重写...（第 N 次 / 最多 M 次） · 原因：<reason>」。
 *
 * 与 Task7 已落地的 retry badge / 红 banner 区别：
 *   - 本卡片：assistant final 还没入库前，实时显示 retry 进度
 *   - retry badge / banner：assistant final 已入库，按 messages.retry_count 渲染历史
 *
 * 入站途径：page.tsx onMessage 收到 `dispatch.validation_retry` event → store.recordRetry()
 * 出站途径：
 *   - status="exhausted" → store 内部直接清掉（banner 接管）
 *   - assistant final 真正落库（带 retry_count）→ page.tsx onMessage 触发 store.clearRetry(messageId)
 */

const REASON_LABEL: Record<DispatchValidationRetryReason, string> = {
  nested_call_tag: "嵌套 [Call:]",
  naked_at_with_real_teammate: "行首裸 @ 缺 [Call:] 包装",
}

export function DispatchRetryProgressCard({ messageId }: { messageId: string }) {
  const payload = useDispatchRetryStore((s) => s.active[messageId])
  if (!payload) return null
  if (payload.status !== "retrying") return null

  const reasonText = REASON_LABEL[payload.reason] ?? payload.reason

  return (
    <div
      role="status"
      data-testid="dispatch-retry-progress-card"
      className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-800"
    >
      <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-amber-600" />
      <div className="leading-snug">
        <span className="font-medium">派发格式不合契约，正在重写...</span>
        <span className="ml-1 text-amber-700/80">
          （第 {payload.attemptIndex} 次 / 最多 {payload.maxAttempts} 次）
        </span>
        <span className="ml-1 text-amber-700/80">· 原因：{reasonText}</span>
      </div>
    </div>
  )
}

/**
 * F026 P3.1 · AC-22 retry 期间气泡占位锁
 *
 * retry 触发后，原 streaming 内容会被吞掉重写一遍——用户看到的"从头流"诡异感就是
 * 因为 streaming bubble 还残留前一轮的不合规文本，retry 第二次的 delta 接续在后面。
 *
 * 这个组件的职责：retry 期间替换 message-bubble 的 content 渲染区域，挂一个
 * "⏳ 正在按合规协议重写…" 占位条，等 settled / exhausted 后由 page.tsx 的
 * overwriteMessage 用最终 content 替换显示。
 *
 * 用法：在 message-bubble 渲染 content 之前判断 isLocked；锁住期间 BlockRenderer 不渲染。
 */
export function useDispatchRetryStreamingLock(messageId: string): {
  isLocked: boolean
  attemptIndex: number
  maxAttempts: number
} {
  const payload = useDispatchRetryStore((s) => s.active[messageId])
  if (!payload || payload.status !== "retrying") {
    return { isLocked: false, attemptIndex: 0, maxAttempts: 0 }
  }
  return {
    isLocked: true,
    attemptIndex: payload.attemptIndex,
    maxAttempts: payload.maxAttempts,
  }
}

export function DispatchRetryStreamingLock({
  attemptIndex,
  maxAttempts,
}: {
  attemptIndex: number
  maxAttempts: number
}) {
  return (
    <div
      data-testid="dispatch-retry-streaming-lock"
      className="flex items-center gap-2 rounded-lg border border-dashed border-amber-300/70 bg-amber-50/60 px-3 py-3 text-xs text-amber-700"
    >
      <RefreshCw className="h-3.5 w-3.5 animate-spin text-amber-600" />
      <span>
        正在按合规协议重写…（第 {attemptIndex} 次 / 最多 {maxAttempts} 次）
      </span>
    </div>
  )
}
