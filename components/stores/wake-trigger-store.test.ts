/**
 * F027 Phase 3 P20 Week 3 Day 14-15 (AC-P3-5) · wake-trigger-store 单元测试
 *
 * 覆盖:
 *   - recordTrigger 写入 + key=(roomId, alias)
 *   - getLatest 按 key 查
 *   - 同 (roomId, alias) 后入覆盖
 *   - 不同 alias 在同 room 各自保留
 *   - roomId=null fallback key
 *   - clear 清空
 */

import type { WakeTriggerPayload } from "@multi-agent/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useWakeTriggerStore } from "./wake-trigger-store"

function makeTrigger(overrides: Partial<WakeTriggerPayload> = {}): WakeTriggerPayload {
  return {
    threadId: "thread-1",
    sessionGroupId: "group-1",
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "a2a_handoff",
    a2aCallId: "call-abc",
    triggeredAt: "2026-05-22T17:00:00Z",
    ...overrides,
  }
}

function resetStore() {
  useWakeTriggerStore.setState({ latestByKey: new Map() })
}

describe("wake-trigger-store", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("recordTrigger 写入 + getLatest 按 key 查", () => {
    const payload = makeTrigger({ alias: "黄仁勋", roomId: "R-201" })
    useWakeTriggerStore.getState().recordTrigger(payload)
    expect(useWakeTriggerStore.getState().getLatest("R-201", "黄仁勋")).toEqual(payload)
  })

  it("未记录的 key 返 null", () => {
    expect(useWakeTriggerStore.getState().getLatest("R-999", "桂芬")).toBeNull()
  })

  it("同 (roomId, alias) 后入覆盖先入", () => {
    const t1 = makeTrigger({ triggeredAt: "2026-05-22T17:00:00Z", a2aCallId: "call-1" })
    const t2 = makeTrigger({ triggeredAt: "2026-05-22T17:05:00Z", a2aCallId: "call-2" })
    useWakeTriggerStore.getState().recordTrigger(t1)
    useWakeTriggerStore.getState().recordTrigger(t2)
    expect(useWakeTriggerStore.getState().getLatest("R-201", "黄仁勋")).toEqual(t2)
  })

  it("同 room 不同 alias 各自保留", () => {
    const tHuang = makeTrigger({ alias: "黄仁勋", a2aCallId: "call-h" })
    const tGui = makeTrigger({ alias: "桂芬", a2aCallId: "call-g" })
    useWakeTriggerStore.getState().recordTrigger(tHuang)
    useWakeTriggerStore.getState().recordTrigger(tGui)
    expect(useWakeTriggerStore.getState().getLatest("R-201", "黄仁勋")?.a2aCallId).toBe("call-h")
    expect(useWakeTriggerStore.getState().getLatest("R-201", "桂芬")?.a2aCallId).toBe("call-g")
  })

  it("roomId=null fallback key (旧数据 / 测试 fixture 未绑 canonical)", () => {
    const payload = makeTrigger({ roomId: null, alias: "黄仁勋" })
    useWakeTriggerStore.getState().recordTrigger(payload)
    expect(useWakeTriggerStore.getState().getLatest(null, "黄仁勋")).toEqual(payload)
    // R-201 查不到（key 不同）
    expect(useWakeTriggerStore.getState().getLatest("R-201", "黄仁勋")).toBeNull()
  })

  it("clear 清空 store", () => {
    useWakeTriggerStore.getState().recordTrigger(makeTrigger())
    useWakeTriggerStore.getState().clear()
    expect(useWakeTriggerStore.getState().getLatest("R-201", "黄仁勋")).toBeNull()
    expect(useWakeTriggerStore.getState().latestByKey.size).toBe(0)
  })

  it("不同 scenario 覆盖（最新 scenario 替换）", () => {
    const t1 = makeTrigger({ scenario: "a2a_handoff" })
    const t2 = makeTrigger({ scenario: "direct_turn" })
    useWakeTriggerStore.getState().recordTrigger(t1)
    useWakeTriggerStore.getState().recordTrigger(t2)
    expect(useWakeTriggerStore.getState().getLatest("R-201", "黄仁勋")?.scenario).toBe(
      "direct_turn",
    )
  })
})
