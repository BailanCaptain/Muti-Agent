/**
 * F027 P19.6 · RoomCompilerTick 测试 — AC-P2-6
 *
 * 覆盖：
 *   - 正常 tick：executor 跑过 → status='ok' + roomsProcessed/durationMs 正确
 *   - reentrancy guard：长跑期间新触发 → 第二次 status='skipped_reentry'
 *     + executor 仅调用 1 次（验证 inProgress 锁正确）
 *   - missed window：scheduledFor 远在过去 → status='missed_window'
 *     + executor 不跑 + 落 trace
 *   - executor 抛错：trace status='failed' + inProgress 复位（finally）
 *     + 后续 tick 可正常跑（zombie lock 防御）
 *   - idle 30min：刚启动 → isIdle()=true；成功 tick 后 → false；时钟前进
 *     30min+ → 再次 true
 *   - trace 格式：onTrace 回调收到完整 JobTrace（schemaVersion / 时间窗 /
 *     status / runId 全字段）
 */

import assert from "node:assert/strict"
import test from "node:test"
import {
  JOB_TRACE_SCHEMA_VERSION,
  type JobTrace,
  validateJobTrace,
} from "./job-trace"
import { RoomCompilerTick } from "./room-compiler-tick"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeTick(opts: {
  executor?: () => Promise<{ roomsProcessed: number }>
  windowMinutes?: number
  idleThresholdMinutes?: number
  clock?: () => Date
  traceCollector?: JobTrace[]
}) {
  const traceCollector = opts.traceCollector ?? []
  const tick = new RoomCompilerTick({
    compileExecutor: opts.executor ?? (async () => ({ roomsProcessed: 0 })),
    windowMinutes: opts.windowMinutes,
    idleThresholdMinutes: opts.idleThresholdMinutes,
    clock: opts.clock,
    onTrace: (t) => traceCollector.push(t),
  })
  return { tick, traceCollector }
}

// ── (1) 正常路径 ─────────────────────────────────────────────────────────

test("RoomCompilerTick · normal tick → status='ok' with executor result", async () => {
  let now = new Date("2026-05-15T00:00:00.000Z")
  const clock = () => now
  let calls = 0
  const { tick, traceCollector } = makeTick({
    executor: async () => {
      calls += 1
      return { roomsProcessed: 7 }
    },
    clock,
  })

  const scheduledFor = new Date(now)
  // 让 startedAt 跟 scheduledFor 不同
  now = new Date(now.getTime() + 10)
  const result = await tick.tick(scheduledFor)

  assert.equal(result.status, "ok")
  if (result.status === "ok") {
    assert.equal(result.roomsProcessed, 7)
    assert.ok(result.durationMs >= 0)
  }
  assert.equal(calls, 1)
  assert.equal(traceCollector.length, 1)
  assert.equal(traceCollector[0].status, "ok")
  assert.deepEqual((traceCollector[0].result as { roomsProcessed: number }).roomsProcessed, 7)
})

test("RoomCompilerTick · executor returns roomsProcessed=0 (idle) → still status='ok'", async () => {
  const { tick, traceCollector } = makeTick({
    executor: async () => ({ roomsProcessed: 0 }),
  })
  const result = await tick.tick(new Date())
  assert.equal(result.status, "ok")
  if (result.status === "ok") assert.equal(result.roomsProcessed, 0)
  assert.equal(traceCollector[0].status, "ok")
})

// ── (2) Reentrancy guard ─────────────────────────────────────────────────

test("RoomCompilerTick · reentrancy: 长跑期间新触发 → 第二次 'skipped_reentry'", async () => {
  let calls = 0
  let resolveExecutor!: (value: { roomsProcessed: number }) => void
  const executorPromise = new Promise<{ roomsProcessed: number }>((resolve) => {
    resolveExecutor = resolve
  })
  const { tick, traceCollector } = makeTick({
    executor: async () => {
      calls += 1
      return executorPromise
    },
  })

  // 启动第一次 tick（不 await，executor 卡住）
  const firstPromise = tick.tick(new Date())
  // 等 microtask 让 inProgress=true
  await sleep(10)
  assert.equal(tick.isInProgress(), true)

  // 第二次触发应 skip_reentry
  const second = await tick.tick(new Date())
  assert.equal(second.status, "skipped_reentry")
  assert.equal(traceCollector.length, 1, "只 skip 落了 1 trace（first 还没完）")
  assert.equal(traceCollector[0].status, "skipped_reentry")

  // 释放第一次
  resolveExecutor({ roomsProcessed: 3 })
  const first = await firstPromise
  assert.equal(first.status, "ok")
  if (first.status === "ok") assert.equal(first.roomsProcessed, 3)
  assert.equal(calls, 1, "executor 仅被第一次 tick 调用一次")
  assert.equal(traceCollector.length, 2)
  assert.equal(traceCollector[1].status, "ok")
  assert.equal(tick.isInProgress(), false, "first 完成后 inProgress 复位")
})

// ── (3) Missed window ────────────────────────────────────────────────────

test("RoomCompilerTick · missed window: scheduledFor + windowMin < now → 'missed_window'", async () => {
  let calls = 0
  const baseNow = new Date("2026-05-15T00:30:00.000Z")
  const { tick, traceCollector } = makeTick({
    executor: async () => {
      calls += 1
      return { roomsProcessed: 1 }
    },
    windowMinutes: 5,
    clock: () => baseNow,
  })

  // scheduledFor 在 30min 前 → 远超 5min window
  const scheduledFor = new Date("2026-05-15T00:00:00.000Z")
  const result = await tick.tick(scheduledFor)

  assert.equal(result.status, "missed_window")
  assert.equal(calls, 0, "executor 不应被调用")
  assert.equal(traceCollector.length, 1)
  assert.equal(traceCollector[0].status, "missed_window")
  assert.equal(traceCollector[0].startedAt, null, "missed window 无 startedAt")
  assert.equal(traceCollector[0].finishedAt, null)
  assert.equal(traceCollector[0].durationMs, null)
})

test("RoomCompilerTick · within window (now < windowEnd) → tick runs", async () => {
  let calls = 0
  const baseNow = new Date("2026-05-15T00:02:30.000Z") // 2.5min after scheduledFor
  const { tick } = makeTick({
    executor: async () => {
      calls += 1
      return { roomsProcessed: 0 }
    },
    windowMinutes: 5,
    clock: () => baseNow,
  })
  const result = await tick.tick(new Date("2026-05-15T00:00:00.000Z"))
  assert.equal(result.status, "ok")
  assert.equal(calls, 1)
})

// ── (4) Executor 抛错 + zombie lock 防御 ────────────────────────────────

test("RoomCompilerTick · executor throws → status='failed' + inProgress 复位", async () => {
  let calls = 0
  const { tick, traceCollector } = makeTick({
    executor: async () => {
      calls += 1
      throw new Error("compile blew up")
    },
  })
  const result = await tick.tick(new Date())
  assert.equal(result.status, "failed")
  if (result.status === "failed") assert.match(result.error, /compile blew up/)
  assert.equal(calls, 1)
  assert.equal(traceCollector.length, 1)
  assert.equal(traceCollector[0].status, "failed")
  assert.equal(traceCollector[0].error?.message, "compile blew up")
  assert.equal(tick.isInProgress(), false, "异常路径 finally 必须复位 inProgress")

  // 后续 tick 应能正常跑（zombie lock 没卡住）
  const next = await tick.tick(new Date())
  assert.equal(next.status, "failed", "executor 仍然抛 → 仍 failed，但跑过")
  assert.equal(calls, 2)
})

// ── (5) Idle 30min ───────────────────────────────────────────────────────

test("RoomCompilerTick · isIdle: 启动期 true / success 后 false / 30min+ true", async () => {
  let now = new Date("2026-05-15T00:00:00.000Z")
  const { tick } = makeTick({
    executor: async () => ({ roomsProcessed: 0 }),
    idleThresholdMinutes: 30,
    clock: () => now,
  })

  assert.equal(tick.isIdle(), true, "lastSuccessAt=null 启动期")

  await tick.tick(now)
  assert.equal(tick.isIdle(), false, "刚成功，距阈值 < 30min")

  // 时钟前进 29min59s — 仍未到阈值
  now = new Date(now.getTime() + 29 * 60_000 + 59_000)
  assert.equal(tick.isIdle(), false)

  // 时钟前进到 30min — 命中
  now = new Date(now.getTime() + 1_000)
  assert.equal(tick.isIdle(), true, "lastSuccessAt 距 now 已 ≥ 30min")
})

test("RoomCompilerTick · isIdle accepts custom now param", async () => {
  const baseNow = new Date("2026-05-15T00:00:00.000Z")
  const { tick } = makeTick({
    executor: async () => ({ roomsProcessed: 1 }),
    idleThresholdMinutes: 5,
    clock: () => baseNow,
  })
  await tick.tick(baseNow)
  // 注入 now 参数
  const future = new Date(baseNow.getTime() + 6 * 60_000)
  assert.equal(tick.isIdle(future), true, "future +6min 应 idle")
  assert.equal(tick.isIdle(), false, "default clock baseNow 不 idle")
})

// ── (6) Trace 格式契约 ──────────────────────────────────────────────────

test("RoomCompilerTick · trace 全字段 + validateJobTrace 通过", async () => {
  const { tick, traceCollector } = makeTick({
    executor: async () => ({ roomsProcessed: 5 }),
  })
  await tick.tick(new Date("2026-05-15T00:00:00.000Z"))
  await tick.tick(new Date("2026-05-15T00:05:00.000Z"))
  assert.equal(traceCollector.length, 2)
  for (const trace of traceCollector) {
    assert.doesNotThrow(() => validateJobTrace(trace), "trace 应通过 P19.4 schema 校验")
    assert.equal(trace.schemaVersion, JOB_TRACE_SCHEMA_VERSION)
    assert.equal(trace.jobName, "room-compiler-tick")
    assert.match(trace.runId, /^[0-9a-f]{8}-/)
  }
  // runId 唯一
  assert.notEqual(traceCollector[0].runId, traceCollector[1].runId)
})

test("RoomCompilerTick · custom jobName + leaderTerm 反映在 trace", async () => {
  const traceCollector: JobTrace[] = []
  const tick = new RoomCompilerTick({
    compileExecutor: async () => ({ roomsProcessed: 0 }),
    onTrace: (t) => traceCollector.push(t),
    jobName: "my-custom-job",
    leaderTerm: "42",
  })
  await tick.tick(new Date())
  assert.equal(traceCollector[0].jobName, "my-custom-job")
  assert.equal(traceCollector[0].leaderTerm, "42")
})

// 范-r1 P3-1: leaderTerm getter — 每次 trace 实时取，不缓存构造时值
test("RoomCompilerTick · 范-r1 P3-1: leaderTerm getter 反映 reacquire 后新 term", async () => {
  const traceCollector: JobTrace[] = []
  let currentTerm: string | null = "1"
  const tick = new RoomCompilerTick({
    compileExecutor: async () => ({ roomsProcessed: 0 }),
    onTrace: (t) => traceCollector.push(t),
    leaderTerm: () => currentTerm, // getter
  })

  await tick.tick(new Date("2026-05-15T00:00:00.000Z"))
  assert.equal(traceCollector[0].leaderTerm, "1")

  // 模拟 leader reacquire，term++
  currentTerm = "2"
  await tick.tick(new Date("2026-05-15T00:05:00.000Z"))
  assert.equal(traceCollector[1].leaderTerm, "2", "getter 应捕获新 term，不是构造时缓存")

  // 模拟 selfDemote → null
  currentTerm = null
  await tick.tick(new Date("2026-05-15T00:10:00.000Z"))
  assert.equal(traceCollector[2].leaderTerm, null)
})

// ── (7) onTrace throw 不打断 tick ────────────────────────────────────────

test("RoomCompilerTick · onTrace throw 不打断 tick result", async () => {
  const tick = new RoomCompilerTick({
    compileExecutor: async () => ({ roomsProcessed: 1 }),
    onTrace: () => {
      throw new Error("trace writer broken")
    },
  })
  const result = await tick.tick(new Date())
  assert.equal(result.status, "ok", "onTrace 抛错应被吞")
})
