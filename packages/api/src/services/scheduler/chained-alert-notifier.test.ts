/**
 * F027 P19.14 · ChainedAlertNotifier 测试 — AC-P2-16
 *
 * 覆盖：
 *   - notify → pushAlert 收到 R-201 alert（draftPath / reason / relatedPaths）
 *   - 默认 targetRoom = R-201；自定义 targetRoom
 *   - dedup：同 draftPath 窗口内重复 → 只推 1 次
 *   - 不同 draftPath → 各自推
 *   - dedup 窗口外 → 重新推
 *   - pushAlert throw → alerted=false skipReason=push_failed
 *   - dedupWindowMs=0（默认）→ 不去重
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  ChainedAlertNotifier,
  type ChainedAlert,
  type ChainedSuspectEvent,
} from "./chained-alert-notifier"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function evt(over: Partial<ChainedSuspectEvent> = {}): ChainedSuspectEvent {
  return {
    draftPath: "wiki/concepts/draft/_quarantined/sus-1.md",
    reason: "5-layer sanitize: cross-correlation hit",
    ...over,
  }
}

// ── 基础 notify ─────────────────────────────────────────────────────────

test("ChainedAlertNotifier · AC-P2-16: notify → pushAlert 收到 R-201 alert", async () => {
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushed.push(a)
    },
  })
  const result = await notifier.notify(
    evt({
      draftPath: "wiki/concepts/draft/_quarantined/x.md",
      reason: "chained drop detected",
      relatedPaths: ["wiki/concepts/draft/_quarantined/y.md"],
    }),
  )
  assert.equal(result.alerted, true)
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].targetRoom, "R-201", "默认推 R-201")
  assert.equal(pushed[0].draftPath, "wiki/concepts/draft/_quarantined/x.md")
  assert.equal(pushed[0].reason, "chained drop detected")
  assert.deepEqual(pushed[0].relatedPaths, ["wiki/concepts/draft/_quarantined/y.md"])
  assert.match(pushed[0].alertedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test("ChainedAlertNotifier · 自定义 targetRoom", async () => {
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushed.push(a)
    },
    targetRoom: "R-999",
  })
  await notifier.notify(evt())
  assert.equal(pushed[0].targetRoom, "R-999")
})

test("ChainedAlertNotifier · relatedPaths 缺省 → 空数组", async () => {
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushed.push(a)
    },
  })
  await notifier.notify(evt({ relatedPaths: undefined }))
  assert.deepEqual(pushed[0].relatedPaths, [])
})

test("ChainedAlertNotifier · detectedAt 注入 → alertedAt 用它", async () => {
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushed.push(a)
    },
  })
  await notifier.notify(evt({ detectedAt: "2026-05-15T08:00:00.000Z" }))
  assert.equal(pushed[0].alertedAt, "2026-05-15T08:00:00.000Z")
})

// ── dedup ────────────────────────────────────────────────────────────────

test("ChainedAlertNotifier · dedup: 同 draftPath 窗口内重复 → 只推 1 次", async () => {
  let now = new Date("2026-05-15T00:00:00.000Z")
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushed.push(a)
    },
    dedupWindowMs: 60_000,
    clock: () => now,
  })
  const r1 = await notifier.notify(evt({ draftPath: "wiki/.../same.md" }))
  assert.equal(r1.alerted, true)
  // 30s 后同 path 再 notify → 窗口内 dedup
  now = new Date(now.getTime() + 30_000)
  const r2 = await notifier.notify(evt({ draftPath: "wiki/.../same.md" }))
  assert.equal(r2.alerted, false)
  assert.equal(r2.skipReason, "deduped")
  assert.equal(pushed.length, 1, "窗口内只推 1 次")
})

test("ChainedAlertNotifier · dedup: 窗口外 → 重新推", async () => {
  let now = new Date("2026-05-15T00:00:00.000Z")
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushed.push(a)
    },
    dedupWindowMs: 60_000,
    clock: () => now,
  })
  await notifier.notify(evt({ draftPath: "wiki/.../same.md" }))
  // 61s 后 → 窗口外，重新推
  now = new Date(now.getTime() + 61_000)
  const r2 = await notifier.notify(evt({ draftPath: "wiki/.../same.md" }))
  assert.equal(r2.alerted, true)
  assert.equal(pushed.length, 2)
})

test("ChainedAlertNotifier · dedup: 不同 draftPath → 各自推", async () => {
  const now = new Date("2026-05-15T00:00:00.000Z")
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushed.push(a)
    },
    dedupWindowMs: 60_000,
    clock: () => now,
  })
  await notifier.notify(evt({ draftPath: "wiki/.../a.md" }))
  await notifier.notify(evt({ draftPath: "wiki/.../b.md" }))
  assert.equal(pushed.length, 2, "不同 path 不互相 dedup")
})

test("ChainedAlertNotifier · dedupWindowMs=0（默认）→ 不去重", async () => {
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushed.push(a)
    },
    // dedupWindowMs 不传 → 默认 0
  })
  await notifier.notify(evt({ draftPath: "wiki/.../same.md" }))
  await notifier.notify(evt({ draftPath: "wiki/.../same.md" }))
  assert.equal(pushed.length, 2, "默认不去重，每次都推")
})

// ── pushAlert 错误处理 ──────────────────────────────────────────────────

test("ChainedAlertNotifier · pushAlert throw → alerted=false skipReason=push_failed", async () => {
  const notifier = new ChainedAlertNotifier({
    pushAlert: async () => {
      throw new Error("R-201 unreachable")
    },
  })
  const result = await notifier.notify(evt())
  assert.equal(result.alerted, false)
  assert.equal(result.skipReason, "push_failed")
})

test("ChainedAlertNotifier · 范-r2 P3-1: 并发同 draftPath notify → 只推 1 次", async () => {
  let releasePush!: () => void
  const firstPush = new Promise<void>((resolve) => {
    releasePush = resolve
  })
  const pushed: ChainedAlert[] = []
  let pushCalls = 0
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      pushCalls += 1
      if (pushCalls === 1) await firstPush // 第一次卡在 push 里
      pushed.push(a)
    },
  })
  // 并发两次同 path notify：n1 卡在 pushAlert（已进 inFlight）
  const n1 = notifier.notify(evt({ draftPath: "wiki/.../concurrent.md" }))
  await sleep(10)
  const r2 = await notifier.notify(evt({ draftPath: "wiki/.../concurrent.md" }))
  assert.equal(r2.alerted, false, "并发 in-flight → deduped")
  assert.equal(r2.skipReason, "deduped")
  releasePush()
  const r1 = await n1
  assert.equal(r1.alerted, true)
  assert.equal(pushCalls, 1, "并发只调 pushAlert 1 次")
  assert.equal(pushed.length, 1)
})

test("ChainedAlertNotifier · pushAlert 失败 → dedup 不记录（下次仍可推）", async () => {
  let now = new Date("2026-05-15T00:00:00.000Z")
  let failNext = true
  const pushed: ChainedAlert[] = []
  const notifier = new ChainedAlertNotifier({
    pushAlert: async (a) => {
      if (failNext) {
        failNext = false
        throw new Error("transient failure")
      }
      pushed.push(a)
    },
    dedupWindowMs: 60_000,
    clock: () => now,
  })
  // 第一次失败
  const r1 = await notifier.notify(evt({ draftPath: "wiki/.../retry.md" }))
  assert.equal(r1.alerted, false)
  // 立刻重试（同 path，窗口内）— 因为上次失败没记 dedup，应能推
  now = new Date(now.getTime() + 1_000)
  const r2 = await notifier.notify(evt({ draftPath: "wiki/.../retry.md" }))
  assert.equal(r2.alerted, true, "上次 push 失败未记 dedup → 重试能推")
  assert.equal(pushed.length, 1)
})
