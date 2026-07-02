import type { SequencedRealtimeServerEvent, TimelineMessage } from "@multi-agent/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setDeltaHoleHandler, useThreadStore } from "../stores/thread-store"
import { StreamMonitor } from "./stream-monitor"

/**
 * F031 AC5 · 集成五场景：monitor + store 全链合成流。
 * deliver() 复刻 page.tsx onMessage 接线：observe → drop 则跳过 → applyAssistantDelta(带 offset)。
 * catch-up 复刻 selectSessionGroup 重拉：快照 replaceActiveGroup + setBaseline + catchUpDone。
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

function delta(
  text: string,
  offset: number,
  seq?: number,
  epoch = "e1",
): SequencedRealtimeServerEvent {
  const base = {
    type: "assistant_delta" as const,
    payload: { sessionGroupId: "g1", messageId: "m1", delta: text, offset },
  }
  return seq === undefined ? base : { ...base, seq, epoch }
}

function awaitFlush() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function content(): string | undefined {
  return useThreadStore.getState().timeline.find((m) => m.id === "m1")?.content
}

describe("F031 AC5 · 集成五场景", () => {
  let monitor: StreamMonitor
  let catchUps: string[]
  /** 每场景可换的"服务端真相"：catch-up 重拉时落什么快照/水位线 */
  let serverTruth: { content: string; seq: number; epoch: string }
  let warnSpy: ReturnType<typeof vi.spyOn>

  const deliver = (event: SequencedRealtimeServerEvent) => {
    if (monitor.observe(event) === "drop") return
    if (event.type === "assistant_delta") {
      useThreadStore
        .getState()
        .applyAssistantDelta(event.payload.messageId, event.payload.delta, event.payload.offset)
    }
  }

  beforeEach(() => {
    monitor = new StreamMonitor()
    catchUps = []
    serverTruth = { content: "", seq: 0, epoch: "e1" }
    monitor.onCatchUp((reason) => {
      catchUps.push(reason)
      // 复刻 selectSessionGroup 全量重拉（同步模拟）：快照 + 水位线换基线
      useThreadStore.getState().replaceActiveGroup(snapshotWith(makeMessage("m1", serverTruth.content)))
      monitor.setBaseline("g1", { epoch: serverTruth.epoch, seq: serverTruth.seq })
      monitor.catchUpDone(true)
    })
    setDeltaHoleHandler((info) => monitor.reportHole(info))
    useThreadStore.setState({ timeline: [makeMessage("m1")] })
    monitor.setBaseline("g1", { epoch: "e1", seq: 0 })
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    setDeltaHoleHandler(null)
    warnSpy.mockRestore()
  })

  it("① evict 丢广播：seq gap + delta 空洞双通道触发 catch-up，最终收敛到服务端真相", async () => {
    deliver(delta("AB", 0, 1))
    deliver(delta("C", 2, 2))
    await awaitFlush()
    expect(content()).toBe("ABC")

    // seq 3("DE")/4("F") 丢失（socket evict 窗口），seq 5("G") 到达
    serverTruth = { content: "ABCDEFG", seq: 5, epoch: "e1" }
    deliver(delta("G", 6, 5))
    expect(catchUps).toEqual(["gap"]) // 跳号立即触发（快照同步落地）
    await awaitFlush()
    expect(content()).toBe("ABCDEFG") // 收敛：无重复无缺失

    // catch-up 后流恢复连续
    serverTruth = { content: "ABCDEFGH", seq: 6, epoch: "e1" }
    deliver(delta("H", 7, 6))
    await awaitFlush()
    expect(content()).toBe("ABCDEFGH")
    expect(catchUps).toEqual(["gap"])
  })

  it("② 服务端重启：epoch 变化 → 重置基线 + 全量重拉收敛", async () => {
    deliver(delta("AB", 0, 1))
    await awaitFlush()
    expect(content()).toBe("AB")

    // 重启：epoch e2，seq 归零重新从 1 开始；重启期间服务端内容已推进
    serverTruth = { content: "ABCD", seq: 1, epoch: "e2" }
    deliver(delta("E", 4, 1, "e2"))
    expect(catchUps).toEqual(["epoch-changed"])
    await awaitFlush()
    // 快照落地 ABCD；e2/seq1 的 delta("E",4) 与快照对齐追加
    expect(content()).toBe("ABCDE")

    serverTruth = { content: "ABCDEF", seq: 2, epoch: "e2" }
    deliver(delta("F", 5, 2, "e2"))
    await awaitFlush()
    expect(content()).toBe("ABCDEF")
    expect(catchUps).toEqual(["epoch-changed"])
  })

  it("③ 同组另一 socket 收直发事件（无 seq）：本 socket 无假 gap，直发 delta 正常应用", async () => {
    deliver(delta("AB", 0, 1))
    // 直发通道事件（用户自己 turn 的流，无 seq）穿插
    deliver(delta("CD", 2))
    deliver(delta("EF", 4, 2))
    await awaitFlush()
    expect(content()).toBe("ABCDEF")
    expect(catchUps).toEqual([]) // 直发不消耗计数器 → 无假 gap
  })

  it("④ catch-up 快照已含某 streamed delta：随后到达的同 delta（直发无 seq）不重复追加", async () => {
    // 快照先落地（含 "ABCD"），水位线 seq 3
    useThreadStore.getState().replaceActiveGroup(snapshotWith(makeMessage("m1", "ABCD")))
    monitor.setBaseline("g1", { epoch: "e1", seq: 3 })
    // 迟到的直发 delta（无 seq → observe 不拦，靠 offset 判 dup）
    deliver(delta("C", 2))
    // 迟到的广播 delta（stale seq → observe 直接 drop）
    deliver(delta("D", 3, 2))
    await awaitFlush()
    expect(content()).toBe("ABCD")
    expect(catchUps).toEqual([])
  })

  it("⑤ delta 已入 RAF 队列 → 快照换基线 → flush 不重复追加（德彪 r2 P1 复现）", async () => {
    deliver(delta("ABC", 0, 1))
    await awaitFlush()
    // delta("D",3) 入队但尚未 flush
    deliver(delta("D", 3, 2))
    // catch-up/切房间快照此刻落地，内容已含 "ABCD"
    useThreadStore.getState().replaceActiveGroup(snapshotWith(makeMessage("m1", "ABCD")))
    monitor.setBaseline("g1", { epoch: "e1", seq: 2 })
    await awaitFlush()
    expect(content()).toBe("ABCD") // 不是 "ABCDD"
    expect(catchUps).toEqual([])
  })
})
