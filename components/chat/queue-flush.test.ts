/**
 * F026 P0 场景1 后续 · review finding P1-2 修复
 *
 * 范德彪 review 发现：
 *   1) `composer.tsx` 的 `awaitingTurnStartRef` 是**全局 ref**（不按 groupId），
 *      切房时 A 房残留的 latch 会挡住 B 房的 flush。
 *   2) 队列消息若在入队时未 validate、发出时被 `sendMessage` 校验拒绝，
 *      latch 永不清 → 后续全停。
 *
 * 本测试把 flush 决策从 composer 的 useEffect 抽成纯函数，便于单测：
 *   - planQueueFlush() 只读一个 snapshot，输出该 snapshot 下唯一正确动作
 *   - resolveLatchAfterSend() 根据 sendResult 决定是否保留/清除当前 group 的 latch
 */

import { describe, expect, it } from "vitest"
import {
  planQueueFlush,
  resolveLatchAfterSend,
  type QueuedMessage,
} from "./queue-flush"

const msg = (id: string, text = `body-${id}`): QueuedMessage => ({ id, text })

describe("P1-2 planQueueFlush · per-group latch 分桶", () => {
  it("idle group 且 bucket 非空 → flush 队首", () => {
    const out = planQueueFlush({
      activeGroupId: "g1",
      isTurnLive: false,
      awaitingLatch: new Set(),
      bucket: [msg("a"), msg("b")],
    })
    expect(out).toEqual({ kind: "flush", message: msg("a") })
  })

  it("turn live → skip (reason busy)", () => {
    const out = planQueueFlush({
      activeGroupId: "g1",
      isTurnLive: true,
      awaitingLatch: new Set(),
      bucket: [msg("a")],
    })
    expect(out).toEqual({ kind: "skip", reason: "busy" })
  })

  it("当前 group 已在 awaitingLatch → skip (reason awaiting-latch)", () => {
    const out = planQueueFlush({
      activeGroupId: "g1",
      isTurnLive: false,
      awaitingLatch: new Set(["g1"]),
      bucket: [msg("a")],
    })
    expect(out).toEqual({ kind: "skip", reason: "awaiting-latch" })
  })

  it("切房：A 房 latch 不应挡住 B 房的 flush（bucket 专属 B 房）", () => {
    // 回归 baseline：老逻辑下 awaitingLatch 是 boolean，A 房残留 latch 直接挡 B 房
    const out = planQueueFlush({
      activeGroupId: "g2",
      isTurnLive: false,
      awaitingLatch: new Set(["g1"]), // 只 A 房有 latch
      bucket: [msg("b1")],
    })
    expect(out).toEqual({ kind: "flush", message: msg("b1") })
  })

  it("activeGroupId=null → skip (no-group)", () => {
    const out = planQueueFlush({
      activeGroupId: null,
      isTurnLive: false,
      awaitingLatch: new Set(),
      bucket: [msg("a")],
    })
    expect(out).toEqual({ kind: "skip", reason: "no-group" })
  })

  it("bucket 空 → skip (empty)", () => {
    const out = planQueueFlush({
      activeGroupId: "g1",
      isTurnLive: false,
      awaitingLatch: new Set(),
      bucket: [],
    })
    expect(out).toEqual({ kind: "skip", reason: "empty" })
  })
})

describe("P1-2 resolveLatchAfterSend · rejected 清当前 group latch", () => {
  it("accepted → latch 保留（等 isTurnLive 自然清）", () => {
    const latch = new Set(["g1"])
    const out = resolveLatchAfterSend(latch, "g1", { accepted: true })
    expect(out).toEqual(new Set(["g1"]))
  })

  it("rejected → 立即删除该 group 的 latch，防止永久卡死", () => {
    const latch = new Set(["g1", "g2"])
    const out = resolveLatchAfterSend(latch, "g1", { accepted: false, reason: "validation" })
    expect(out).toEqual(new Set(["g2"]))
  })

  it("rejected 且 groupId 不在 latch 集中 → 原样返回（不抛错）", () => {
    const latch = new Set(["g2"])
    const out = resolveLatchAfterSend(latch, "g1", { accepted: false, reason: "validation" })
    expect(out).toEqual(new Set(["g2"]))
  })
})
