import assert from "node:assert/strict"
import test from "node:test"
import { createUsageSnapshotThrottle } from "./usage-snapshot-throttle"

// F043 AC8 · 轮中 usage 快照节流：leading-edge——首个快照立即放行（长轮至少一次
// 实时更新的保证），间隔内后续丢弃；末值不需要 trailing（turn 收尾的权威
// thread_snapshot_delta 会带上落库真值兜底）。

test("F043 AC8: first snapshot per thread emits immediately (leading edge)", () => {
  let t = 1_000
  const throttle = createUsageSnapshotThrottle(2_000, () => t)
  assert.equal(throttle.shouldEmit("t1"), true, "首个必放行")
  t += 500
  assert.equal(throttle.shouldEmit("t1"), false, "间隔内丢弃")
  t += 1_600
  assert.equal(throttle.shouldEmit("t1"), true, "超过间隔恢复放行")
})

test("F043 AC8: threads throttle independently", () => {
  let t = 1_000
  const throttle = createUsageSnapshotThrottle(2_000, () => t)
  assert.equal(throttle.shouldEmit("t1"), true)
  assert.equal(throttle.shouldEmit("t2"), true, "另一 thread 不受 t1 影响")
  t += 100
  assert.equal(throttle.shouldEmit("t1"), false)
  assert.equal(throttle.shouldEmit("t2"), false)
})
