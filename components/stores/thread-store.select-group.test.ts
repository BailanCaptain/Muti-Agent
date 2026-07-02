import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { streamMonitor } from "../ws/stream-monitor"
import { useThreadStore } from "./thread-store"

/**
 * F031 AC2/AC3 · selectSessionGroup：subscribe-before-fetch（德彪 r1 P2）+
 * 快照水位线换基线。
 */

const calls: string[] = []

vi.mock("@/components/ws/client", () => ({
  subscribeToRoom: (groupId: string) => {
    calls.push(`subscribe:${groupId}`)
  },
  connectRealtime: () => () => {},
  socketClient: {},
}))

function fakeSnapshotResponse() {
  return {
    activeGroup: {
      id: "g1",
      roomId: null,
      title: "t",
      meta: "",
      timeline: [],
      hasPendingDispatches: false,
      dispatchBarrierActive: false,
      providers: {},
    },
    wsWatermark: { epoch: "e-test", seq: 7 },
  }
}

describe("thread-store · selectSessionGroup (F031)", () => {
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(`fetch:${String(url)}`)
        return {
          ok: true,
          json: async () =>
            String(url).includes("/api/session-groups/") ? fakeSnapshotResponse() : {},
        }
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("先 subscribeToRoom 再 fetch 快照（缩窄订阅过滤丢失窗口）", async () => {
    await useThreadStore.getState().selectSessionGroup("g1")
    const subscribeIdx = calls.findIndex((c) => c === "subscribe:g1")
    const fetchIdx = calls.findIndex((c) => c.startsWith("fetch:") && c.includes("session-groups"))
    expect(subscribeIdx).toBeGreaterThanOrEqual(0)
    expect(fetchIdx).toBeGreaterThan(subscribeIdx)
  })

  it("快照 wsWatermark 换基线：seq ≤ 水位线 drop，> 水位线连续 apply", async () => {
    await useThreadStore.getState().selectSessionGroup("g1")
    const seqEvent = (seq: number) => ({
      type: "assistant_delta" as const,
      payload: { sessionGroupId: "g1", messageId: "m1", delta: "x" },
      seq,
      epoch: "e-test",
    })
    expect(streamMonitor.observe(seqEvent(7))).toBe("drop")
    expect(streamMonitor.observe(seqEvent(8))).toBe("apply")
  })
})
