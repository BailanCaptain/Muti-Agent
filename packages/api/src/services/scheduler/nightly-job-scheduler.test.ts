/**
 * F027 P19.1 · NightlyJobScheduler 框架测试
 *
 * 覆盖：
 *   - register / start / stop lifecycle（含 idempotent）
 *   - register-after-start 抛错
 *   - duplicate-name 抛错
 *   - health() 形状 + nextRun 在 running 时非空
 *   - default timezone（Asia/Shanghai）反映在 nextRun 计算
 *   - 真触发：1s 周期 → 1.5s 内 handler 至少跑 1 次
 *   - handler throw 不打断 scheduler（catch 捕获）
 *
 * 不覆盖（推后）：
 *   - lease 集成（P19.2 测试）
 *   - 长跑 reentrancy skip（P19.6 测试）
 *   - missed window trace（P19.4 contract 测试）
 */

import assert from "node:assert/strict"
import test from "node:test"
import { NightlyJobScheduler } from "./nightly-job-scheduler"

function newScheduler() {
  return new NightlyJobScheduler()
}

test("NightlyJobScheduler · register before start, health reports specs", () => {
  const sch = newScheduler()
  sch.register({ name: "noop-a", cron: "0 0 * * *", handler: () => {} })
  sch.register({ name: "noop-b", cron: "0 1 * * *", handler: () => {} })

  const h = sch.health()
  assert.equal(h.running, false)
  assert.equal(h.startedAt, null)
  assert.equal(h.jobs.length, 2)
  assert.deepEqual(
    h.jobs.map((j) => j.name).sort(),
    ["noop-a", "noop-b"],
  )
  for (const j of h.jobs) {
    assert.equal(j.nextRun, null, `nextRun should be null before start (${j.name})`)
  }
})

test("NightlyJobScheduler · start sets running, computes nextRun", () => {
  const sch = newScheduler()
  sch.register({ name: "midnight", cron: "0 0 * * *", handler: () => {} })

  sch.start()
  try {
    const h = sch.health()
    assert.equal(h.running, true)
    assert.ok(h.startedAt !== null, "startedAt should be ISO string")
    assert.match(h.startedAt!, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(h.jobs.length, 1)
    assert.ok(h.jobs[0].nextRun !== null, "nextRun should be set after start")
    assert.match(h.jobs[0].nextRun!, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    sch.stop()
  }
})

test("NightlyJobScheduler · start is idempotent", () => {
  const sch = newScheduler()
  sch.register({ name: "idem", cron: "0 0 * * *", handler: () => {} })

  sch.start()
  const first = sch.health().startedAt
  sch.start() // second call
  const second = sch.health().startedAt
  assert.equal(second, first, "startedAt unchanged after second start()")
  sch.stop()
})

test("NightlyJobScheduler · stop is idempotent + clears running state", () => {
  const sch = newScheduler()
  sch.register({ name: "idem-stop", cron: "0 0 * * *", handler: () => {} })

  sch.start()
  sch.stop()
  assert.equal(sch.health().running, false)
  assert.equal(sch.health().startedAt, null)

  // second stop — no throw
  sch.stop()
  assert.equal(sch.health().running, false)
})

test("NightlyJobScheduler · register after start throws", () => {
  const sch = newScheduler()
  sch.register({ name: "first", cron: "0 0 * * *", handler: () => {} })
  sch.start()
  try {
    assert.throws(
      () => sch.register({ name: "second", cron: "0 1 * * *", handler: () => {} }),
      /cannot register .* after start/,
    )
  } finally {
    sch.stop()
  }
})

test("NightlyJobScheduler · duplicate name throws", () => {
  const sch = newScheduler()
  sch.register({ name: "dup", cron: "0 0 * * *", handler: () => {} })
  assert.throws(
    () => sch.register({ name: "dup", cron: "0 1 * * *", handler: () => {} }),
    /duplicate job name 'dup'/,
  )
})

test("NightlyJobScheduler · default tz Asia/Shanghai applied", () => {
  const sch = new NightlyJobScheduler({ defaultTimezone: "Asia/Shanghai" })
  // 03:00 Shanghai 每天一次
  sch.register({ name: "tz-test", cron: "0 3 * * *", handler: () => {} })
  sch.start()
  try {
    const next = sch.health().jobs[0].nextRun
    assert.ok(next !== null)
    // 转回 UTC 应 19:00（Asia/Shanghai = UTC+8 无 DST）
    const d = new Date(next!)
    assert.equal(d.getUTCHours(), 19, `expected UTC 19:00 for 03:00 Shanghai, got ${next}`)
    assert.equal(d.getUTCMinutes(), 0)
  } finally {
    sch.stop()
  }
})

test("NightlyJobScheduler · handler fires on schedule (1s cadence)", async () => {
  const sch = newScheduler()
  let count = 0
  sch.register({
    name: "tick",
    cron: "* * * * * *", // 6-part: 每秒
    handler: () => {
      count += 1
    },
  })
  sch.start()
  try {
    // 等 ~1.5s，至少触发 1 次
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.ok(count >= 1, `handler should fire ≥ 1 time, got ${count}`)
  } finally {
    sch.stop()
  }
})

test("NightlyJobScheduler · handler throw caught, scheduler keeps running", async () => {
  const sch = newScheduler()
  let count = 0
  sch.register({
    name: "thrower",
    cron: "* * * * * *",
    handler: () => {
      count += 1
      throw new Error("intentional test error")
    },
  })
  sch.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 2200))
    // ≥ 2 次说明第一次抛错没炸 scheduler
    assert.ok(count >= 2, `expected ≥ 2 fires (caught error), got ${count}`)
    assert.equal(sch.health().running, true, "scheduler still running after handler throw")
  } finally {
    sch.stop()
  }
})

test("NightlyJobScheduler · P19.2 guard returns reason → handler skipped + onSkip fires", async () => {
  let count = 0
  const skipEvents: Array<{ name: string; reason: string }> = []
  const guardReason: string | null = "lease_lost"
  const sch = new NightlyJobScheduler({
    guard: () => guardReason,
    onSkip: (name, reason) => skipEvents.push({ name, reason }),
  })
  sch.register({
    name: "guarded",
    cron: "* * * * * *",
    handler: () => {
      count += 1
    },
  })
  sch.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(count, 0, "handler should NOT fire when guard returns reason")
    assert.ok(skipEvents.length >= 1, `onSkip should fire ≥ 1 time, got ${skipEvents.length}`)
    assert.equal(skipEvents[0].name, "guarded")
    assert.equal(skipEvents[0].reason, "lease_lost")
  } finally {
    sch.stop()
  }
  // 关 guard，验证 handler 恢复触发
  const sch2 = new NightlyJobScheduler({
    guard: () => null,
    onSkip: (name, reason) => skipEvents.push({ name, reason }),
  })
  let count2 = 0
  sch2.register({
    name: "ungated",
    cron: "* * * * * *",
    handler: () => {
      count2 += 1
    },
  })
  sch2.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.ok(count2 >= 1, `handler should fire when guard returns null, got ${count2}`)
  } finally {
    sch2.stop()
  }
  // 强制使用 guardReason 抑制未使用警告
  void guardReason
})

test("NightlyJobScheduler · P19.2 guard threw treated as skip with reason='guard_error'", async () => {
  const skipEvents: Array<{ name: string; reason: string }> = []
  let count = 0
  const sch = new NightlyJobScheduler({
    guard: () => {
      throw new Error("guard explosion")
    },
    onSkip: (name, reason) => skipEvents.push({ name, reason }),
  })
  sch.register({
    name: "boom-guard",
    cron: "* * * * * *",
    handler: () => {
      count += 1
    },
  })
  sch.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(count, 0, "guard error → handler skipped")
    assert.ok(skipEvents.length >= 1)
    assert.equal(skipEvents[0].reason, "guard_error")
  } finally {
    sch.stop()
  }
})

test("NightlyJobScheduler · health.jobs preserves spec order (insertion)", () => {
  const sch = newScheduler()
  sch.register({ name: "z-first", cron: "0 0 * * *", handler: () => {} })
  sch.register({ name: "a-second", cron: "0 1 * * *", handler: () => {} })
  sch.register({ name: "m-third", cron: "0 2 * * *", handler: () => {} })

  const names = sch.health().jobs.map((j) => j.name)
  assert.deepEqual(names, ["z-first", "a-second", "m-third"])
})
