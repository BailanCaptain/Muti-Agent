import type { TimelineMessage } from "@multi-agent/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type DeltaHoleInfo, setDeltaHoleHandler, useThreadStore } from "./thread-store"

/**
 * F031 AC4 · pendingDeltas offset segment 队列 + flush 时刻幂等判定（德彪 r2 P1 核心）。
 *
 * 行为契约：applyAssistantDelta/applyThinkingDelta 只入队 {offset, text} segment；
 * flushDeltas 以 flush 时刻 timeline 当前长度逐段判定：
 *   offset === 长度 → 追加；offset < → 重复丢弃（快照已覆盖）；
 *   offset > → 丢段 + hole handler（触发 catch-up）。
 * snapshot（replaceActiveGroup）与 RAF flush 任意交错顺序均收敛。
 */

function makeMessage(id: string, content = ""): TimelineMessage {
  return {
    id,
    provider: "claude",
    alias: "黄仁勋",
    role: "assistant",
    content,
    messageType: "final",
    model: null,
    createdAt: "2026-07-03T00:00:00.000Z",
  }
}

function snapshotWith(...messages: TimelineMessage[]) {
  return {
    id: "g1",
    roomId: null,
    title: "t",
    meta: "",
    timeline: messages,
    hasPendingDispatches: false,
    dispatchBarrierActive: false,
    providers: {} as never,
  }
}

/** flushDeltas 由 rAF 调度（happy-dom 计时驱动）；等一拍真 rAF 让真调度路径跑完 */
function awaitFlush() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function content(id: string): string | undefined {
  return useThreadStore.getState().timeline.find((m) => m.id === id)?.content
}

function thinkingOf(id: string): string | undefined {
  return useThreadStore.getState().timeline.find((m) => m.id === id)?.thinking
}

it("F044 same-room refresh keeps older pages outside the newest snapshot window", () => {
  useThreadStore.setState({
    activeGroup: {
      id: "g1",
      roomId: null,
      title: "t",
      meta: "",
      hasPendingDispatches: false,
      dispatchBarrierActive: false,
    },
    timeline: [makeMessage("older", "old"), makeMessage("m1", "new")],
  })

  useThreadStore.getState().replaceActiveGroup(snapshotWith(makeMessage("m1", "newer")))

  expect(useThreadStore.getState().timeline.map((message) => message.id)).toEqual(["older", "m1"])
})

describe("thread-store · delta offset 幂等化 (F031 AC4)", () => {
  beforeEach(() => {
    useThreadStore.setState({ timeline: [makeMessage("m1")] })
    setDeltaHoleHandler(null)
  })

  it("legacy 无 offset delta 盲追加（现行为回归保护）", async () => {
    const s = useThreadStore.getState()
    s.applyAssistantDelta("m1", "AB")
    s.applyAssistantDelta("m1", "C")
    await awaitFlush()
    expect(content("m1")).toBe("ABC")
  })

  it("offset 对齐 → 追加；连续段各自对齐", async () => {
    const s = useThreadStore.getState()
    s.applyAssistantDelta("m1", "AB", 0)
    s.applyAssistantDelta("m1", "CD", 2)
    await awaitFlush()
    expect(content("m1")).toBe("ABCD")
  })

  it("offset < 当前长度（dup）→ 丢弃不重复", async () => {
    useThreadStore.setState({ timeline: [makeMessage("m1", "ABCD")] })
    const s = useThreadStore.getState()
    s.applyAssistantDelta("m1", "CD", 2)
    await awaitFlush()
    expect(content("m1")).toBe("ABCD")
  })

  it("offset > 当前长度（hole）→ 丢段 + hole handler 收到结构化信息", async () => {
    const holes: DeltaHoleInfo[] = []
    setDeltaHoleHandler((info) => holes.push(info))
    const s = useThreadStore.getState()
    s.applyAssistantDelta("m1", "AB", 0)
    s.applyAssistantDelta("m1", "EF", 4) // 中间丢了 offset 2 的段
    await awaitFlush()
    expect(content("m1")).toBe("AB")
    expect(holes).toEqual([{ messageId: "m1", kind: "content", expected: 2, got: 4 }])
  })

  it("⑤ r2 P1 复现：segment 已入 RAF 队列 → 快照换基线（已含该段）→ flush 不重复追加", async () => {
    useThreadStore.setState({ timeline: [makeMessage("m1", "ABC")] })
    const s = useThreadStore.getState()
    // delta(offset=3,"D") 入队但尚未 flush
    s.applyAssistantDelta("m1", "D", 3)
    // catch-up 快照先落地，内容已含 "ABCD"
    s.replaceActiveGroup(snapshotWith(makeMessage("m1", "ABCD")))
    await awaitFlush()
    expect(content("m1")).toBe("ABCD") // 不是 "ABCDD"
  })

  it("④ 快照先落地，迟到 dup delta → 丢弃", async () => {
    const s = useThreadStore.getState()
    s.replaceActiveGroup(snapshotWith(makeMessage("m1", "ABCD")))
    s.applyAssistantDelta("m1", "C", 2)
    await awaitFlush()
    expect(content("m1")).toBe("ABCD")
  })

  it("content 与 thinking 独立 offset 空间", async () => {
    const s = useThreadStore.getState()
    s.applyAssistantDelta("m1", "AB", 0)
    s.applyThinkingDelta("m1", "思考中", 0)
    s.applyAssistantDelta("m1", "CD", 2)
    s.applyThinkingDelta("m1", "…", 3)
    await awaitFlush()
    expect(content("m1")).toBe("ABCD")
    expect(thinkingOf("m1")).toBe("思考中…")
  })

  it("thinking hole 独立上报 kind", async () => {
    const holes: DeltaHoleInfo[] = []
    setDeltaHoleHandler((info) => holes.push(info))
    const s = useThreadStore.getState()
    s.applyThinkingDelta("m1", "XY", 5)
    await awaitFlush()
    expect(holes).toEqual([{ messageId: "m1", kind: "thinking", expected: 0, got: 5 }])
  })

  it("resetAssistantStream 清空段队列（retry 清零对齐）", async () => {
    const s = useThreadStore.getState()
    s.applyAssistantDelta("m1", "bad", 0)
    s.resetAssistantStream("m1")
    s.applyAssistantDelta("m1", "good", 0)
    await awaitFlush()
    expect(content("m1")).toBe("good")
  })

  it("同一 RAF 批次内多段按序判定（对齐+dup 混合）", async () => {
    const s = useThreadStore.getState()
    s.applyAssistantDelta("m1", "AB", 0)
    s.applyAssistantDelta("m1", "AB", 0) // 重发段（dup）
    s.applyAssistantDelta("m1", "CD", 2)
    await awaitFlush()
    expect(content("m1")).toBe("ABCD")
  })
})
