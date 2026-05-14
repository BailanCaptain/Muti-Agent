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
import { Cron } from "croner"
import { NightlyJobScheduler, computePlannedSlot } from "./nightly-job-scheduler"

function newScheduler() {
  return new NightlyJobScheduler()
}

test("NightlyJobScheduler · register before start, health reports specs", () => {
  const sch = newScheduler()
  sch.register({ name: "noop-a", cron: "0 0 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })
  sch.register({ name: "noop-b", cron: "0 1 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })

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
  sch.register({ name: "midnight", cron: "0 0 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })

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
  sch.register({ name: "idem", cron: "0 0 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })

  sch.start()
  const first = sch.health().startedAt
  sch.start() // second call
  const second = sch.health().startedAt
  assert.equal(second, first, "startedAt unchanged after second start()")
  sch.stop()
})

test("NightlyJobScheduler · stop is idempotent + clears running state", () => {
  const sch = newScheduler()
  sch.register({ name: "idem-stop", cron: "0 0 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })

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
  sch.register({ name: "first", cron: "0 0 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })
  sch.start()
  try {
    assert.throws(
      () => sch.register({ name: "second", cron: "0 1 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } }),
      /cannot register .* after start/,
    )
  } finally {
    sch.stop()
  }
})

test("NightlyJobScheduler · duplicate name throws", () => {
  const sch = newScheduler()
  sch.register({ name: "dup", cron: "0 0 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })
  assert.throws(
    () => sch.register({ name: "dup", cron: "0 1 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } }),
    /duplicate job name 'dup'/,
  )
})

test("NightlyJobScheduler · default tz Asia/Shanghai applied", () => {
  const sch = new NightlyJobScheduler({ defaultTimezone: "Asia/Shanghai" })
  // 03:00 Shanghai 每天一次
  sch.register({ name: "tz-test", cron: "0 3 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })
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

// 范-r1 P2-2: guard 抛错改走独立 onGuardError 回调，不引入新 reason enum
test("NightlyJobScheduler · 范-r1 P2-2: guard threw → onGuardError fires + handler skipped (no reason enum pollution)", async () => {
  const skipEvents: Array<{ name: string; reason: string }> = []
  const guardErrors: Array<{ name: string; message: string }> = []
  let count = 0
  const sch = new NightlyJobScheduler({
    guard: () => {
      throw new Error("guard explosion")
    },
    onSkip: (name, reason) => skipEvents.push({ name, reason }),
    onGuardError: (name, err) => guardErrors.push({ name, message: err.message }),
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
    assert.equal(count, 0, "guard error → handler skipped (fail-safe)")
    assert.equal(skipEvents.length, 0, "onSkip 不该 fire（guard error 是 infra 异常，非 spec'd skip reason）")
    assert.ok(guardErrors.length >= 1, `onGuardError 应 fire ≥ 1 次, got ${guardErrors.length}`)
    assert.equal(guardErrors[0].name, "boom-guard")
    assert.match(guardErrors[0].message, /guard explosion/)
  } finally {
    sch.stop()
  }
})

// 范-r1 P2-3: handler 接 JobContext (scheduledFor + window) — 验证传参正确
test("NightlyJobScheduler · 范-r1 P2-3: handler 接 JobContext { scheduledFor / windowStart / windowEnd }", async () => {
  const ctxCaptured: Array<{ scheduledFor: Date; windowStart: Date; windowEnd: Date }> = []
  const sch = new NightlyJobScheduler()
  sch.register({
    name: "ctx-test",
    cron: "* * * * * *", // 每秒
    windowMinutes: 3, // 自定义 window
    handler: (ctx) => {
      ctxCaptured.push(ctx)
    },
  })
  sch.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.ok(ctxCaptured.length >= 1, `handler 应 fire ≥ 1 次, got ${ctxCaptured.length}`)
    const c = ctxCaptured[0]
    // scheduledFor 与 windowStart 应一致
    assert.equal(c.windowStart.getTime(), c.scheduledFor.getTime())
    // windowEnd = scheduledFor + 3min
    assert.equal(c.windowEnd.getTime() - c.scheduledFor.getTime(), 3 * 60_000)
  } finally {
    sch.stop()
  }
})

// 范-r2 P2-3: scheduledFor 必须是 cron 计划槽位，不是 callback entry wall clock
test("computePlannedSlot · 范-r2 P2-3: 取 cron 槽位（previousRuns），不取 entry time", () => {
  // cron pattern '0 4 * * *' Asia/Shanghai = 每天 4:00 UTC+8 = 20:00 UTC
  const job = new Cron("0 4 * * *", { timezone: "Asia/Shanghai", paused: true })

  // 模拟 event loop 阻塞 30s 后才进 callback：
  // 真 cron 槽位是 2026-05-15T04:00:00 Asia/Shanghai = 2026-05-14T20:00:00Z
  // entry time 模拟为 +30s
  const entryTime = new Date("2026-05-14T20:00:30.000Z")
  const planned = computePlannedSlot(job, entryTime)

  // planned slot 应严格 < entryTime（不是 entry 当下）
  assert.ok(planned.getTime() < entryTime.getTime(), "planned slot 应早于 entry time")
  // planned slot 应 = 20:00:00 UTC（cron 槽位）
  assert.equal(
    planned.toISOString(),
    "2026-05-14T20:00:00.000Z",
    "planned slot 应是 cron pattern 上的精确时刻，不受 event loop delay 影响",
  )
})

test("computePlannedSlot · entry 正好是 cron 槽位 → planned = entry", () => {
  const job = new Cron("0 4 * * *", { timezone: "Asia/Shanghai", paused: true })
  const onSlot = new Date("2026-05-14T20:00:00.000Z")
  const planned = computePlannedSlot(job, onSlot)
  // 在 cron slot 当下，planned = 那个 slot 自己
  assert.equal(planned.toISOString(), "2026-05-14T20:00:00.000Z")
})

test("computePlannedSlot · 5min cron + delay 90s → planned 仍是 5min 边界", () => {
  // */5 * * * * 每 5 分钟（: 00, 05, 10, ...）
  const job = new Cron("*/5 * * * *", { timezone: "UTC", paused: true })
  // entry 在 12:05:00 + 90s 延迟 = 12:06:30
  const entryTime = new Date("2026-05-15T12:06:30.000Z")
  const planned = computePlannedSlot(job, entryTime)
  // planned 应是 12:05:00 (上一个 5min 槽位)
  assert.equal(planned.toISOString(), "2026-05-15T12:05:00.000Z")
  // delay = entry - planned = 90s（demonstrates missed-window 检测能感知到延迟）
  const delayMs = entryTime.getTime() - planned.getTime()
  assert.equal(delayMs, 90_000, "delay 应是 90s，证明 scheduler 能感知 event loop 阻塞")
})

test("NightlyJobScheduler · 范-r1 P2-3: handler windowMinutes 默认 5min", async () => {
  let captured: { scheduledFor: Date; windowEnd: Date } | null = null
  const sch = new NightlyJobScheduler()
  sch.register({
    name: "default-window",
    cron: "* * * * * *",
    handler: (ctx) => {
      if (!captured) captured = ctx
    },
  })
  sch.start()
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.ok(captured !== null)
    const c = captured as { scheduledFor: Date; windowEnd: Date }
    assert.equal(c.windowEnd.getTime() - c.scheduledFor.getTime(), 5 * 60_000)
  } finally {
    sch.stop()
  }
})

test("NightlyJobScheduler · health.jobs preserves spec order (insertion)", () => {
  const sch = newScheduler()
  sch.register({ name: "z-first", cron: "0 0 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })
  sch.register({ name: "a-second", cron: "0 1 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })
  sch.register({ name: "m-third", cron: "0 2 * * *", handler: () => {
        // 范-r1 P2-3 后 handler 接 ctx，但 noop 测试可省略参数
      } })

  const names = sch.health().jobs.map((j) => j.name)
  assert.deepEqual(names, ["z-first", "a-second", "m-third"])
})
