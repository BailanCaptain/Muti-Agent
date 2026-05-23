"use client"

import { create } from "zustand"

/**
 * F027 Phase 3 Week 4 Day 20 (AC-P3-5 + AC-P3-4 click drawer) · a2a drawer 全局 state
 *
 * 真相源：
 *   - V16.5 chap 18 line 1970-1986 (V16.5.2 拍 viewfinder §4 pill + prompt-inspector
 *     wake.trigger pill 共用同一 drawer + 同一 fetch GET /debug/a2a?root=callId)
 *   - feature.md AC-P3-4 line 180 (viewfinder §4 a2a pill click → in-place drawer 展开 mini call tree)
 *   - feature.md AC-P3-5 line 181 (prompt-inspector wake-up pill click → 同样 in-place drawer)
 *
 * 状态:
 *   - callId: null = drawer 关闭 / string = 当前展开的 root callId
 *   - source: 'viewfinder' | 'prompt-inspector' | null (审计 + 关闭后焦点回原 pill)
 *
 * 不持久化 (transient session-only, 同 runtime-log-store / wake-trigger-store)。
 */

export type A2ADrawerSource = "viewfinder" | "prompt-inspector"

export interface A2ADrawerState {
  callId: string | null
  source: A2ADrawerSource | null
  openDrawer: (callId: string, source: A2ADrawerSource) => void
  closeDrawer: () => void
}

export const useA2ADrawerStore = create<A2ADrawerState>((set) => ({
  callId: null,
  source: null,
  openDrawer: (callId, source) => set({ callId, source }),
  closeDrawer: () => set({ callId: null, source: null }),
}))
