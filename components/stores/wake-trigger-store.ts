"use client"

import type { WakeTriggerPayload } from "@multi-agent/shared"
import { create } from "zustand"

/**
 * F027 Phase 3 P20 Week 3 Day 14-15 (AC-P3-5) · wake-trigger store
 *
 * 真相源：
 *   - G1 commit c227eef (后端 broadcast wake.trigger event)
 *   - V16.5 §18 line 1975-1983 V16.5.2 prompt-inspector 顶部触发因块
 *   - feature.md line 181 AC-P3-5
 *
 * 数据流：
 *   - app/page.tsx onMessage 拦截 event.type === "wake.trigger" → store.recordTrigger()
 *   - PromptInspectorTab 顶部读 store.getLatest(roomId, alias) 渲染 🔔 触发因块
 *   - 内存 only，不 persist（reload 后空，runtime 重新累积）
 *
 * key = (roomId, alias) → 同房间多 agent 各自 latest trigger 独立保留
 *   - roomId 用 canonical R-### (sessionGroupId fallback) — 跟 audit row 一致
 *   - alias 是目标 agent 别名
 */

function makeKey(roomId: string | null, alias: string): string {
  return `${roomId ?? "_null"}::${alias}`
}

type WakeTriggerStore = {
  /** key=makeKey(roomId, alias) → latest WakeTriggerPayload */
  latestByKey: Map<string, WakeTriggerPayload>
  recordTrigger: (payload: WakeTriggerPayload) => void
  getLatest: (roomId: string | null, alias: string) => WakeTriggerPayload | null
  clear: () => void
}

export const useWakeTriggerStore = create<WakeTriggerStore>((set, get) => ({
  latestByKey: new Map(),
  recordTrigger: (payload) => {
    set((state) => {
      const next = new Map(state.latestByKey)
      next.set(makeKey(payload.roomId, payload.alias), payload)
      return { latestByKey: next }
    })
  },
  getLatest: (roomId, alias) => get().latestByKey.get(makeKey(roomId, alias)) ?? null,
  clear: () => set({ latestByKey: new Map() }),
}))
