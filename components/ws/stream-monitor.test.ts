import type { SequencedRealtimeServerEvent } from "@multi-agent/shared"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StreamMonitor } from "./stream-monitor"

/**
 * F031 AC3/AC6 · 客户端 gap 检测：基线=快照水位线，观测带 seq 事件判
 * apply/drop，跳号/epoch 变化触发 catch-up（debounce + 重试上限 + 降级），
 * gap/降级 有结构化 console.warn。
 */

function ev(groupId: string, seq?: number, epoch?: string): SequencedRealtimeServerEvent {
  const base = {
    type: "assistant_delta" as const,
    payload: { sessionGroupId: groupId, messageId: "m1", delta: "x" },
  }
  return seq === undefined ? base : { ...base, seq, epoch }
}

describe("StreamMonitor (F031 AC3 gap 检测 + AC6 可观测性)", () => {
  let monitor: StreamMonitor
  let catchUps: string[]
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    monitor = new StreamMonitor()
    catchUps = []
    monitor.onCatchUp((reason) => catchUps.push(reason))
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it("基线后连续 seq 全 apply，不触发 catch-up", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 5 })
    expect(monitor.observe(ev("g1", 6, "e1"))).toBe("apply")
    expect(monitor.observe(ev("g1", 7, "e1"))).toBe("apply")
    expect(monitor.observe(ev("g1", 8, "e1"))).toBe("apply")
    expect(catchUps).toEqual([])
  })

  it("seq ≤ 水位线 → drop（快照已覆盖，不误报）", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 5 })
    expect(monitor.observe(ev("g1", 4, "e1"))).toBe("drop")
    expect(monitor.observe(ev("g1", 5, "e1"))).toBe("drop")
    expect(catchUps).toEqual([])
  })

  it("跳号 → gap：事件本身 apply + catch-up 一次 + 结构化 warn 含丢失区间", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 5 })
    expect(monitor.observe(ev("g1", 9, "e1"))).toBe("apply")
    expect(catchUps).toEqual(["gap"])
    expect(warnSpy).toHaveBeenCalledWith(
      "[F031:ws-gap]",
      expect.objectContaining({ groupId: "g1", epoch: "e1", missedFrom: 6, missedTo: 8 }),
    )
    // gap 后基线推进到跳号位，后续连续不再触发
    expect(monitor.observe(ev("g1", 10, "e1"))).toBe("apply")
    expect(catchUps).toEqual(["gap"])
  })

  it("catch-up 进行中再遇 gap 不叠加（debounce）；done 后恢复", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 0 })
    monitor.observe(ev("g1", 3, "e1"))
    monitor.observe(ev("g1", 7, "e1"))
    expect(catchUps).toEqual(["gap"])
    monitor.catchUpDone(true)
    monitor.observe(ev("g1", 12, "e1"))
    expect(catchUps).toEqual(["gap", "gap"])
  })

  it("epoch 变化 → 重置基线 + catch-up（服务端重启全量重拉）", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 100 })
    expect(monitor.observe(ev("g1", 1, "e2"))).toBe("apply")
    expect(catchUps).toEqual(["epoch-changed"])
    monitor.catchUpDone(true)
    // 新 epoch 基线生效：seq 2 连续
    expect(monitor.observe(ev("g1", 2, "e2"))).toBe("apply")
    expect(catchUps).toEqual(["epoch-changed"])
  })

  it("无 seq 事件（直发/legacy）apply 且不动基线", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 5 })
    expect(monitor.observe(ev("g1"))).toBe("apply")
    expect(monitor.observe(ev("g1", 6, "e1"))).toBe("apply")
    expect(catchUps).toEqual([])
  })

  it("非当前跟踪组事件 apply 不参与校验", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 5 })
    expect(monitor.observe(ev("g2", 99, "e1"))).toBe("apply")
    expect(monitor.observe(ev("g1", 6, "e1"))).toBe("apply")
    expect(catchUps).toEqual([])
  })

  it("连续失败达上限（3）→ 降级 warn，不再触发 catch-up；setBaseline 复位", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 0 })
    for (let i = 0; i < 3; i++) {
      monitor.observe(ev("g1", 10 + i * 10, "e1"))
      expect(catchUps.length).toBe(i + 1)
      monitor.catchUpDone(false)
    }
    monitor.observe(ev("g1", 90, "e1"))
    expect(catchUps.length).toBe(3) // 降级：不再触发
    expect(warnSpy).toHaveBeenCalledWith(
      "[F031:ws-gap]",
      expect.objectContaining({ degraded: true }),
    )
    // 快照成功换基线后复位
    monitor.setBaseline("g1", { epoch: "e1", seq: 100 })
    monitor.observe(ev("g1", 105, "e1"))
    expect(catchUps.length).toBe(4)
  })

  it("reportHole 复用同一 catch-up 通道 + debounce", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 0 })
    monitor.reportHole({ messageId: "m1", kind: "content", expected: 2, got: 4 })
    monitor.reportHole({ messageId: "m1", kind: "content", expected: 2, got: 6 })
    expect(catchUps).toEqual(["delta-hole"])
    expect(warnSpy).toHaveBeenCalledWith(
      "[F031:ws-gap]",
      expect.objectContaining({ hole: expect.objectContaining({ messageId: "m1" }) }),
    )
  })

  it("未设基线（无水位线）时带 seq 事件 apply 并静默建立基线", () => {
    expect(monitor.observe(ev("g1", 7, "e1"))).toBe("apply")
    expect(catchUps).toEqual([])
    expect(monitor.observe(ev("g1", 8, "e1"))).toBe("apply")
    expect(monitor.observe(ev("g1", 8, "e1"))).toBe("drop")
  })

  // ── 德彪 r4 P1 · 切房间 pending 窗口 ────────────────────────────────

  it("r4 P1：pending 窗口内新组事件 seq > 落地水位线 → setBaseline 立即触发 catch-up（终版事件不丢）", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 3 })
    monitor.beginSwitch("g2")
    // fetch 在途，新组事件到达（page 会因 activeGroupId 未切而丢弃内容——monitor 必须记账）
    expect(monitor.observe(ev("g2", 8, "e1"))).toBe("apply")
    expect(catchUps).toEqual([])
    // 快照落地，水位线只到 7 —— seq 8 的事件不在快照里且已被丢弃
    monitor.setBaseline("g2", { epoch: "e1", seq: 7 })
    expect(catchUps).toEqual(["gap"])
    expect(warnSpy).toHaveBeenCalledWith(
      "[F031:ws-gap]",
      expect.objectContaining({ groupId: "g2", pendingMaxSeq: 8, watermarkSeq: 7 }),
    )
  })

  it("r4 P1：pending 窗口事件已被快照覆盖（seq ≤ 水位线）→ 不触发 catch-up", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 3 })
    monitor.beginSwitch("g2")
    monitor.observe(ev("g2", 7, "e1"))
    monitor.setBaseline("g2", { epoch: "e1", seq: 7 })
    expect(catchUps).toEqual([])
    // 基线正常生效：8 连续
    expect(monitor.observe(ev("g2", 8, "e1"))).toBe("apply")
    expect(catchUps).toEqual([])
  })

  it("r4 P1：同组重选（catch-up 重拉）无切换窗口，观测照常", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 3 })
    monitor.beginSwitch("g1")
    expect(monitor.observe(ev("g1", 4, "e1"))).toBe("apply")
    monitor.setBaseline("g1", { epoch: "e1", seq: 4 })
    expect(catchUps).toEqual([])
  })

  it("r5 P1：fresh monitor（无基线）+ beginSwitch 窗口事件也走 pending 记账，不被静默采纳吞掉", () => {
    // 首次加载：monitor 无基线，选房间 g1，fetch 在途收到 g1 seq 8（page 会丢内容）
    monitor.beginSwitch("g1")
    expect(monitor.observe(ev("g1", 8, "e1"))).toBe("apply")
    // 快照落地水位线 7 —— seq 8 不在快照里，必须补拉
    monitor.setBaseline("g1", { epoch: "e1", seq: 7 })
    expect(catchUps).toEqual(["gap"])
  })

  // ── 德彪 r4 P2 · 提取规则与服务端同源 ──────────────────────────────

  it("r4 P2：dispatch.blocked（groupId 在 attempts[0]）推进基线，不造假 gap", () => {
    monitor.setBaseline("g1", { epoch: "e1", seq: 5 })
    const blocked = {
      type: "dispatch.blocked",
      payload: {
        attempts: [
          {
            sessionGroupId: "g1",
            rootMessageId: "r1",
            from: { agentId: "a", messageId: "m", provider: "claude" },
            to: { agentId: "b", provider: "codex" },
            reason: "dedup",
            taskSnippet: "",
          },
        ],
      },
      seq: 6,
      epoch: "e1",
    } as unknown as SequencedRealtimeServerEvent
    expect(monitor.observe(blocked)).toBe("apply")
    // 下一条普通事件 seq 7 必须被视为连续——lastSeq 已被 dispatch.blocked 推进到 6
    expect(monitor.observe(ev("g1", 7, "e1"))).toBe("apply")
    expect(catchUps).toEqual([])
  })
})
