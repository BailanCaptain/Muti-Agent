import { beforeEach, describe, expect, it } from "vitest"
import type { TimelineMessage } from "@multi-agent/shared"
import { useThreadStore } from "./thread-store"

/**
 * F026 P4 follow-up · retry-badge-realtime fix
 *
 * 行为契约：dispatch.validation_retry settled / exhausted 事件到达后，
 * page.tsx 调 applyMessageRetryFields 把 retryCount + retryReasons 实时同步到
 * timeline 对应 assistant message。之前只在 DB 持久化，前端必须刷新走
 * thread_snapshot 才补字段，badge 因此延迟出现。
 */

function makeMessage(id: string): TimelineMessage {
  return {
    id,
    provider: "claude",
    alias: "黄仁勋",
    role: "assistant",
    content: "hi",
    messageType: "final",
    model: null,
    createdAt: "2026-04-29T02:30:00.000Z",
  }
}

describe("thread-store · applyMessageRetryFields (F026 P4 retry-badge-realtime)", () => {
  beforeEach(() => {
    useThreadStore.setState({ timeline: [] })
  })

  it("写入 retryCount + retryReasons 到对应 messageId 的 timeline 项", () => {
    useThreadStore.setState({ timeline: [makeMessage("msg-A"), makeMessage("msg-B")] })
    useThreadStore
      .getState()
      .applyMessageRetryFields("msg-A", 2, ["nested_call_tag", "naked_at_with_real_teammate"])
    const timeline = useThreadStore.getState().timeline
    const a = timeline.find((m) => m.id === "msg-A")
    const b = timeline.find((m) => m.id === "msg-B")
    expect(a?.retryCount).toBe(2)
    expect(a?.retryReasons).toEqual(["nested_call_tag", "naked_at_with_real_teammate"])
    // 不应污染其他消息
    expect(b?.retryCount).toBeUndefined()
    expect(b?.retryReasons).toBeUndefined()
  })

  it("messageId 不在 timeline 时是 no-op（不抛、不插入）", () => {
    useThreadStore.setState({ timeline: [makeMessage("msg-A")] })
    useThreadStore.getState().applyMessageRetryFields("msg-NOT-THERE", 1, ["nested_call_tag"])
    const timeline = useThreadStore.getState().timeline
    expect(timeline).toHaveLength(1)
    expect(timeline[0].id).toBe("msg-A")
    expect(timeline[0].retryCount).toBeUndefined()
  })

  it("retryReasons 数组复制 — 后续外部 mutation 不污染 store", () => {
    useThreadStore.setState({ timeline: [makeMessage("msg-A")] })
    const reasons: import("@multi-agent/shared").DispatchValidationRetryReason[] = [
      "nested_call_tag",
    ]
    useThreadStore.getState().applyMessageRetryFields("msg-A", 1, reasons)
    reasons.push("naked_at_with_real_teammate")
    const a = useThreadStore.getState().timeline.find((m) => m.id === "msg-A")
    expect(a?.retryReasons).toEqual(["nested_call_tag"])
  })

  it("可以覆盖前一次写入的 retryCount + retryReasons（settled 后 exhausted 这种场景不会发生但语义可叠）", () => {
    useThreadStore.setState({ timeline: [makeMessage("msg-A")] })
    useThreadStore.getState().applyMessageRetryFields("msg-A", 1, ["nested_call_tag"])
    useThreadStore
      .getState()
      .applyMessageRetryFields("msg-A", 3, ["nested_call_tag", "naked_at_with_real_teammate"])
    const a = useThreadStore.getState().timeline.find((m) => m.id === "msg-A")
    expect(a?.retryCount).toBe(3)
    expect(a?.retryReasons).toEqual(["nested_call_tag", "naked_at_with_real_teammate"])
  })
})
