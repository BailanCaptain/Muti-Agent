"use client"

import type { DispatchValidationRetryPayload } from "@multi-agent/shared"
import { create } from "zustand"

/**
 * F026 P3.1 · AC-14 / AC-21 实时进度卡 store
 *
 * 单一职责：把 WS `dispatch.validation_retry` event 按 messageId 暂存，
 * 让对应 assistant 气泡上方渲染「🔄 正在重写（第 N 次/最多 M 次） · 原因：...」。
 *
 * 生命周期（AC-21 后的强收尾契约）：
 *  - status="retrying"  → 写入；同 messageId 后续 attempt 覆盖
 *  - status="settled"   → 立刻清掉（retry 后合规已入库；没有 banner）
 *  - status="exhausted" → 立刻清掉；由 message-bubble 内的 ExhaustedBanner 接管硬警示
 *  - 兜底：assistant final 真正落库 → page.tsx onMessage 触发 clearRetry（保留兜底）
 *
 * 不持久化：纯内存 + per session group；用户切房间或刷新即重置。
 */

export type DispatchRetryActive = Record<string, DispatchValidationRetryPayload>

type State = {
  active: DispatchRetryActive
  recordRetry: (payload: DispatchValidationRetryPayload) => void
  clearRetry: (messageId: string) => void
  reset: () => void
}

export const useDispatchRetryStore = create<State>((set) => ({
  active: {},
  recordRetry: (payload) => {
    set((state) => {
      const next = { ...state.active }
      if (payload.status === "settled" || payload.status === "exhausted") {
        delete next[payload.messageId]
      } else {
        next[payload.messageId] = payload
      }
      return { active: next }
    })
  },
  clearRetry: (messageId) => {
    set((state) => {
      if (!(messageId in state.active)) return state
      const next = { ...state.active }
      delete next[messageId]
      return { active: next }
    })
  },
  reset: () => set({ active: {} }),
}))
