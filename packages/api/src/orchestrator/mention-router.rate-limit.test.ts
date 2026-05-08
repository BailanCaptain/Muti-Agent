import assert from "node:assert/strict"
import test from "node:test"
import { MentionRateLimiter } from "./mention-router"

// F026 ADR-003 · 反循环与去重
//   单消息内同 target 最多派发 1 次
//   同 (sessionGroupId, source, target) 30 秒滑动窗口，第二次派发 blocked
// F026 1B.7 R-085 fix · sliding-window 按 sessionGroupId 分桶（跨房间不互拒）

test("rate-limit: 单消息内同 target 多次 @X → 仅 1 次通过", () => {
  const rl = new MentionRateLimiter({ now: () => Date.parse("2026-04-23T13:00:00Z") })
  const messageId = "m1"
  const r1 = rl.allow({ source: "黄仁勋", target: "codex", messageId, sessionGroupId: "g" })
  const r2 = rl.allow({ source: "黄仁勋", target: "codex", messageId, sessionGroupId: "g" })
  const r3 = rl.allow({ source: "黄仁勋", target: "codex", messageId, sessionGroupId: "g" })
  assert.equal(r1.allowed, true)
  assert.equal(r2.allowed, false)
  assert.equal(r2.reason, "duplicate-in-message")
  assert.equal(r3.allowed, false)
})

test("rate-limit: 不同 messageId 内同 target 同 sessionGroup 30s 内 blocked", () => {
  const rl = new MentionRateLimiter({ now: () => Date.parse("2026-04-23T13:00:00Z") })
  assert.equal(
    rl.allow({ source: "黄仁勋", target: "codex", messageId: "m1", sessionGroupId: "g" }).allowed,
    true,
  )
  // 不同 messageId，但在 30s 内同 (sessionGroup, source, target) → sliding-window blocked
  const r = rl.allow({
    source: "黄仁勋",
    target: "codex",
    messageId: "m2",
    sessionGroupId: "g",
  })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, "sliding-window-30s")
})

test("rate-limit: 不同 target，不相互阻塞", () => {
  const rl = new MentionRateLimiter({ now: () => Date.parse("2026-04-23T13:00:00Z") })
  assert.equal(
    rl.allow({ source: "黄仁勋", target: "codex", messageId: "m1", sessionGroupId: "g" }).allowed,
    true,
  )
  assert.equal(
    rl.allow({ source: "黄仁勋", target: "gemini", messageId: "m1", sessionGroupId: "g" }).allowed,
    true,
  )
})

test("rate-limit: 同 (sessionGroup, source, target) 31 秒后允许", () => {
  let clock = Date.parse("2026-04-23T13:00:00.000Z")
  const rl = new MentionRateLimiter({ now: () => clock })
  assert.equal(
    rl.allow({ source: "A", target: "codex", messageId: "m1", sessionGroupId: "g" }).allowed,
    true,
  )
  clock += 29_000
  assert.equal(
    rl.allow({ source: "A", target: "codex", messageId: "m2", sessionGroupId: "g" }).allowed,
    false,
    "29s still in window",
  )
  clock += 2_000 // total 31s
  assert.equal(
    rl.allow({ source: "A", target: "codex", messageId: "m3", sessionGroupId: "g" }).allowed,
    true,
    "31s outside window",
  )
})

test("rate-limit: 不同 source 对同 target 独立计时", () => {
  const clock = Date.parse("2026-04-23T13:00:00.000Z")
  const rl = new MentionRateLimiter({ now: () => clock })
  assert.equal(
    rl.allow({ source: "A", target: "codex", messageId: "mA", sessionGroupId: "g" }).allowed,
    true,
  )
  assert.equal(
    rl.allow({ source: "B", target: "codex", messageId: "mB", sessionGroupId: "g" }).allowed,
    true,
    "不同 source 不互相阻塞",
  )
})

test("rate-limit: blocked 时提供结构化 reason 便于日志", () => {
  const rl = new MentionRateLimiter({ now: () => Date.parse("2026-04-23T13:00:00Z") })
  rl.allow({ source: "A", target: "codex", messageId: "m1", sessionGroupId: "g" })
  const r = rl.allow({ source: "A", target: "codex", messageId: "m1", sessionGroupId: "g" })
  assert.equal(r.allowed, false)
  assert.ok(r.reason && r.reason.length > 0)
  // 窗口信息暴露给日志
  if ("lastDispatchAt" in r) {
    assert.ok(typeof r.lastDispatchAt === "number")
  }
})

// F026 1B.7 R-085 fix · 跨房间 sliding-window 不互拒
//
// 历史 bug：rateLimiter perSourceTarget 全局 key，跨 sessionGroup 误共享 30s 窗口。
// R-084 房间黄仁勋 08:11:11 派给范德彪后，R-085 房间 08:11:25 黄仁勋再派范德彪
// （diff 14s < 30s）→ 全局 key 命中 → blocked sliding-window-30s → R-085 第 1 棒
// a2a_calls 0 child（DB 实证）。修法：window key 加 sessionGroupId 前缀，跨房间隔离。
test("rate-limit (1B.7 R-085 fix): 跨 sessionGroupId 同 (source,target) 30s 内独立 — 不互拒", () => {
  let clock = Date.parse("2026-05-04T08:11:11.846Z")
  const rl = new MentionRateLimiter({ now: () => clock })
  // R-084 黄仁勋 → 范德彪
  assert.equal(
    rl.allow({
      source: "黄仁勋",
      target: "codex",
      messageId: "msg-R084",
      sessionGroupId: "session-R084",
    }).allowed,
    true,
  )
  // 14s 后 R-085 房间 黄仁勋 → 范德彪（实测 R-085 真实间隔）
  clock += 14_000
  const r = rl.allow({
    source: "黄仁勋",
    target: "codex",
    messageId: "msg-R085",
    sessionGroupId: "session-R085",
  })
  assert.equal(r.allowed, true, "different sessionGroupId must NOT share window — R-085 fix")
})

// 防回归：同 sessionGroup 内 30s 滑动窗口仍生效（防 LLM 对同人爆 spam）
test("rate-limit (1B.7): 同 sessionGroupId 30s 内同 (source,target) 仍 blocked — 反 spam 不退化", () => {
  let clock = Date.parse("2026-05-04T08:11:00.000Z")
  const rl = new MentionRateLimiter({ now: () => clock })
  assert.equal(
    rl.allow({
      source: "黄仁勋",
      target: "codex",
      messageId: "m1",
      sessionGroupId: "same-room",
    }).allowed,
    true,
  )
  clock += 5_000
  const r = rl.allow({
    source: "黄仁勋",
    target: "codex",
    messageId: "m2",
    sessionGroupId: "same-room",
  })
  assert.equal(r.allowed, false, "同房间 5s 内仍要拒")
  assert.equal(r.reason, "sliding-window-30s")
})
