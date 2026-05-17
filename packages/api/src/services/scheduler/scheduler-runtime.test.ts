/**
 * F027 P19.16 · SchedulerRuntime 测试 — AC-P2-1 + 范-r2 修复
 *
 * 覆盖：
 *   - start/stop lifecycle + health()
 *   - cron job 触发 → job_trace 落盘 status='ok' + 时间窗字段完整
 *   - cron job throw → trace status='failed' + pushAlert R-201
 *   - cron job timeout → trace status='timeout'
 *   - cron job 自报 outcome.status='missed_window' → trace 记之
 *   - 非 leader runtime → guard skip → trace status='skipped_not_leader' + reason
 *   - startup job 起来跑一次 / 非 leader → skipped_not_leader
 *   - event-driven job start/stop（leader 上）
 *   - 范-r2 P1-1：follower runtime → event-driven jobs 不起
 *   - 范-r2 P1-2：reentrancy guard — 长 job 不并发，落 skipped_reentry
 *   - 范-r2 P1-2：timeout ghost job 仍占 reentry guard
 *   - 范-r2 P1-2：timeout → AbortSignal，合作型 job 收到 abort
 *   - 范-r2 P2-1：follower→leader 提升 → recovered_from_crash trace + event-driven 起
 *   - 范-r2 P2-1：leader demote → lease_lost trace + event-driven 停
 *
 * leader 用真 SQLite-backed CompilerLeaderRepository（对齐 scheduler-leader.test.ts）。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { validateJobTrace, type JobTrace } from "./job-trace"
import { SchedulerLeader } from "./scheduler-leader"
import { SchedulerRuntime } from "./scheduler-runtime"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}
function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

async function buildRepo(tempDir: string) {
  const { createDrizzleDb } = await import("../../db/drizzle-instance")
  const { CompilerLeaderRepository } = await import(
    "../../db/repositories/compiler-leader-repository"
  )
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  return { repo: new CompilerLeaderRepository(db), close }
}

function readTraces(rootDir: string, jobName: string): JobTrace[] {
  const base = path.join(rootDir, ".runtime", "job-traces", jobName)
  if (!fs.existsSync(base)) return []
  const out: JobTrace[] = []
  for (const day of fs.readdirSync(base)) {
    const dayDir = path.join(base, day)
    if (!fs.statSync(dayDir).isDirectory()) continue
    for (const f of fs.readdirSync(dayDir)) {
      if (!f.endsWith(".json")) continue
      out.push(JSON.parse(fs.readFileSync(path.join(dayDir, f), "utf-8")) as JobTrace)
    }
  }
  return out
}

async function waitForTrace(
  rootDir: string,
  jobName: string,
  { timeoutMs = 4000, intervalMs = 50 } = {},
): Promise<JobTrace[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const traces = readTraces(rootDir, jobName)
    if (traces.length > 0) return traces
    await sleep(intervalMs)
  }
  return readTraces(rootDir, jobName)
}

async function waitFor(
  cond: () => boolean,
  { timeoutMs = 4000, intervalMs = 30 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(intervalMs)
  }
  return cond()
}

// ── lifecycle ────────────────────────────────────────────────────────────

test("SchedulerRuntime · AC-P2-1: start/stop lifecycle + health()", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-A",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [
      { name: "job-x", cron: "0 4 * * *", timeoutSeconds: 60, run: async () => {} },
      { name: "job-y", cron: "0 5 * * *", timeoutSeconds: 60, run: async () => {} },
    ],
  })
  try {
    await runtime.start()
    const h = runtime.health()
    assert.equal(h.running, true)
    assert.equal(h.jobs.length, 2)
    assert.ok(h.jobs.every((j) => j.nextRun !== null), "nextRun set after start")
    assert.equal(runtime.leaderRole(), "leader", "sole instance → leader")
    await runtime.stop()
    assert.equal(runtime.health().running, false)
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · start() idempotent", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-idem",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [{ name: "j", cron: "0 4 * * *", timeoutSeconds: 60, run: async () => {} }],
  })
  try {
    await runtime.start()
    await runtime.start() // noop
    assert.equal(runtime.health().jobs.length, 1)
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · 重复 cron name → 构造抛错", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  try {
    assert.throws(
      () =>
        new SchedulerRuntime({
          leaderAlias: "lc-dup",
          leaseRepo: repo,
          rootDir: tempDir,
          cronJobs: [
            { name: "dup", cron: "0 4 * * *", timeoutSeconds: 60, run: async () => {} },
            { name: "dup", cron: "0 5 * * *", timeoutSeconds: 60, run: async () => {} },
          ],
        }),
      /duplicate cron job/,
    )
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

// ── cron job 触发 → trace ────────────────────────────────────────────────

test("SchedulerRuntime · AC-P2-1: cron job 触发 → job_trace 落盘 status=ok", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  let runs = 0
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-ok",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [
      {
        name: "tick",
        cron: "* * * * * *", // 每秒
        timeoutSeconds: 60,
        run: async () => {
          runs += 1
          return { result: { runs } }
        },
      },
    ],
  })
  try {
    await runtime.start()
    const traces = await waitForTrace(tempDir, "tick")
    assert.ok(traces.length > 0, "至少落一条 trace")
    const t = traces[0]
    validateJobTrace(t)
    assert.equal(t.status, "ok")
    assert.equal(t.jobName, "tick")
    assert.ok(t.startedAt !== null && t.finishedAt !== null)
    assert.ok(typeof t.durationMs === "number" && t.durationMs >= 0)
    assert.match(t.scheduledFor, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(t.windowEnd, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(t.error, null)
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · cron job throw → trace status=failed + pushAlert R-201", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const alerts: JobTrace[] = []
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-fail",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    pushAlert: (t) => {
      alerts.push(t)
    },
    cronJobs: [
      {
        name: "boom",
        cron: "* * * * * *",
        timeoutSeconds: 60,
        run: async () => {
          throw new Error("kaboom")
        },
      },
    ],
  })
  try {
    await runtime.start()
    const traces = await waitForTrace(tempDir, "boom")
    const t = traces.find((x) => x.status === "failed")
    assert.ok(t, "应有 failed trace")
    assert.ok(t!.error !== null && /kaboom/.test(t!.error.message))
    assert.equal(t!.alertedRoom, "R-201")
    assert.ok(
      alerts.some((a) => a.status === "failed"),
      "failed → pushAlert 被调用",
    )
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · cron job timeout → trace status=timeout", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-to",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [
      {
        name: "slow",
        cron: "* * * * * *",
        timeoutSeconds: 0.1, // 100ms timeout
        run: async () => {
          await sleep(2000)
        },
      },
    ],
  })
  try {
    await runtime.start()
    let found: JobTrace | undefined
    await waitFor(() => {
      found = readTraces(tempDir, "slow").find((x) => x.status === "timeout")
      return !!found
    })
    assert.ok(found, "应有一条 timeout trace")
    assert.ok(found!.error !== null && /timeout/.test(found!.error.message))
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · cron job 自报 outcome.status=missed_window → trace 记之", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-mw",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [
      {
        name: "missy",
        cron: "* * * * * *",
        timeoutSeconds: 60,
        run: async () => ({ status: "missed_window" as const }),
      },
    ],
  })
  try {
    await runtime.start()
    const traces = await waitForTrace(tempDir, "missy")
    assert.ok(traces.some((t) => t.status === "missed_window"))
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── leader guard ─────────────────────────────────────────────────────────

test("SchedulerRuntime · 非 leader runtime → guard skip → trace skipped_not_leader", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  // 外部 leaderA 先抢到 → runtime 内部 leader B 成 follower
  const leaderA = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  leaderA.start()
  let runs = 0
  const runtime = new SchedulerRuntime({
    leaderAlias: "B",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [
      {
        name: "gated",
        cron: "* * * * * *",
        timeoutSeconds: 60,
        run: async () => {
          runs += 1
        },
      },
    ],
  })
  try {
    await runtime.start()
    assert.equal(runtime.leaderRole(), "follower")
    const traces = await waitForTrace(tempDir, "gated")
    const t = traces[0]
    assert.equal(t.status, "skipped_not_leader")
    assert.equal(t.reason, "role_not_leader")
    assert.equal(t.startedAt, null)
    assert.equal(runs, 0, "follower 不应真跑 job body")
  } finally {
    await runtime.stop()
    leaderA.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── startup jobs ─────────────────────────────────────────────────────────

test("SchedulerRuntime · startup job 起来跑一次 → trace", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  let ran = 0
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-su",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [],
    startupJobs: [
      {
        name: "reconciler",
        timeoutSeconds: 60,
        run: async () => {
          ran += 1
          return { result: { cleaned: 3 } }
        },
      },
    ],
  })
  try {
    await runtime.start()
    assert.equal(ran, 1, "startup job 跑一次")
    const traces = readTraces(tempDir, "reconciler")
    assert.equal(traces.length, 1)
    assert.equal(traces[0].status, "ok")
    validateJobTrace(traces[0])
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · startup job 非 leader → skipped_not_leader trace", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leaderA = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  leaderA.start()
  let ran = 0
  const runtime = new SchedulerRuntime({
    leaderAlias: "B",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [],
    startupJobs: [
      {
        name: "reconciler",
        timeoutSeconds: 60,
        run: async () => {
          ran += 1
        },
      },
    ],
  })
  try {
    await runtime.start()
    assert.equal(ran, 0, "follower 不跑 startup job")
    const traces = readTraces(tempDir, "reconciler")
    assert.equal(traces.length, 1)
    assert.equal(traces[0].status, "skipped_not_leader")
    assert.equal(traces[0].reason, "role_not_leader")
  } finally {
    await runtime.stop()
    leaderA.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── event-driven jobs ────────────────────────────────────────────────────

test("SchedulerRuntime · leader runtime → event-driven job start/stop 被调用", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const calls: string[] = []
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-ed",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [],
    eventDrivenJobs: [
      {
        name: "docs-watcher",
        start: () => {
          calls.push("watcher:start")
        },
        stop: () => {
          calls.push("watcher:stop")
        },
      },
      {
        name: "chained-alert",
        start: async () => {
          calls.push("alert:start")
        },
        stop: async () => {
          calls.push("alert:stop")
        },
      },
    ],
  })
  try {
    await runtime.start()
    assert.deepEqual(calls, ["watcher:start", "alert:start"], "leader 起来即起 event-driven")
    await runtime.stop()
    assert.deepEqual(calls, ["watcher:start", "alert:start", "watcher:stop", "alert:stop"])
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · 范-r2 P1-1: follower runtime → event-driven jobs 不起", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leaderA = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  leaderA.start()
  let started = 0
  const runtime = new SchedulerRuntime({
    leaderAlias: "B",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [],
    eventDrivenJobs: [
      {
        name: "docs-watcher",
        start: () => {
          started += 1
        },
      },
    ],
  })
  try {
    await runtime.start()
    assert.equal(runtime.leaderRole(), "follower")
    assert.equal(started, 0, "follower 不应起 event-driven job（防双 runtime 重复 ingest）")
  } finally {
    await runtime.stop()
    leaderA.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── 范-r2 P1-2: reentrancy guard + AbortSignal ───────────────────────────

test("SchedulerRuntime · 范-r2 P1-2: reentrancy guard — 长 job 全程不并发", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  let active = 0
  let maxActive = 0
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-re",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [
      {
        name: "longjob",
        cron: "* * * * * *", // 每秒触发
        timeoutSeconds: 60, // 不超时
        run: async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await sleep(1500) // 跨多个触发周期
          active -= 1
        },
      },
    ],
  })
  try {
    await runtime.start()
    await sleep(4200)
    await runtime.stop()
    await sleep(300) // 等末轮 job 收尾
    // 长 job 跨多个触发周期：croner protect（NightlyJobScheduler 已设）+ 本层
    // reentrancy guard 双重保证同名 job 绝不并发。非 timeout 长 job 由 croner
    // protect 在调度层静默跳过、不进 handler，故无 skipped_reentry trace；
    // skipped_reentry 只在 timeout-ghost 路径出现（见下一个测试）。
    assert.equal(maxActive, 1, "同名 job 全程绝不并发")
    const traces = readTraces(tempDir, "longjob")
    assert.ok(
      traces.some((t) => t.status === "ok"),
      "至少有一轮正常完成",
    )
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · 范-r2 P1-2: timeout 后 ghost job 仍占 reentry guard", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-ghost",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [
      {
        name: "ghostjob",
        cron: "* * * * * *",
        timeoutSeconds: 0.4, // 400ms 超时
        run: async () => {
          await sleep(2500) // 远超 timeout — 不理 abort，制造 ghost
        },
      },
    ],
  })
  try {
    await runtime.start()
    await sleep(3200)
    await runtime.stop()
    await sleep(400)
    const traces = readTraces(tempDir, "ghostjob")
    assert.ok(
      traces.some((t) => t.status === "timeout"),
      "首轮应 timeout",
    )
    assert.ok(
      traces.some((t) => t.status === "skipped_reentry"),
      "timeout 后 ghost 仍跑 → 后续触发落 skipped_reentry（证明 ghost 被 reentry guard 跟踪）",
    )
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · 范-r2 P1-2: timeout → AbortSignal，合作型 job 收到 abort", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  let abortObserved = false
  const runtime = new SchedulerRuntime({
    leaderAlias: "lc-abort",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
    rootDir: tempDir,
    cronJobs: [
      {
        name: "cooperative",
        cron: "* * * * * *",
        timeoutSeconds: 0.2, // 200ms 超时
        run: async (_ctx, signal) => {
          for (let i = 0; i < 100; i++) {
            await sleep(50)
            if (signal.aborted) {
              abortObserved = true
              return
            }
          }
        },
      },
    ],
  })
  try {
    await runtime.start()
    await waitFor(() => abortObserved, { timeoutMs: 3000 })
    assert.equal(abortObserved, true, "timeout 应 abort signal，合作型 job 早退")
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── 范-r2 P2-1: leader 生命周期 trace ────────────────────────────────────

test("SchedulerRuntime · 范-r2 P2-1: follower→leader 提升 → recovered_from_crash + event-driven 起", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  // 外部 leaderA 先持有
  const leaderA = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  leaderA.start()
  let edStarted = 0
  const runtime = new SchedulerRuntime({
    leaderAlias: "B",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 80, // 快 poll
    rootDir: tempDir,
    cronJobs: [],
    eventDrivenJobs: [
      {
        name: "docs-watcher",
        start: () => {
          edStarted += 1
        },
      },
    ],
  })
  try {
    await runtime.start()
    assert.equal(runtime.leaderRole(), "follower")
    assert.equal(edStarted, 0, "follower 阶段 event-driven 未起")
    // leaderA 释放 → runtime B 下一轮 poll 应抢到
    leaderA.stop()
    const promoted = await waitFor(() => runtime.leaderRole() === "leader", {
      timeoutMs: 3000,
    })
    assert.ok(promoted, "B 应被提升为 leader")
    await waitFor(() => edStarted > 0)
    assert.equal(edStarted, 1, "提升后 event-driven jobs 起")
    const traces = readTraces(tempDir, "scheduler-leader")
    assert.ok(
      traces.some((t) => t.status === "recovered_from_crash"),
      "提升应落 recovered_from_crash trace",
    )
  } finally {
    await runtime.stop()
    leaderA.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · 范-r2 P2-1: leader demote → lease_lost trace + event-driven 停", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  let now = new Date("2026-05-15T00:00:00.000Z")
  const clock = () => now
  let edStopped = 0
  const runtime = new SchedulerRuntime({
    leaderAlias: "A",
    leaseRepo: repo,
    leaderTtlSeconds: 30,
    heartbeatIntervalMs: 50, // 快 heartbeat
    followerPollIntervalMs: 9_999_999,
    clock,
    rootDir: tempDir,
    cronJobs: [],
    eventDrivenJobs: [
      {
        name: "docs-watcher",
        stop: () => {
          edStopped += 1
        },
      },
    ],
  })
  try {
    await runtime.start()
    assert.equal(runtime.leaderRole(), "leader")
    // 模拟 B 强抢：时钟推到 lease 过期 + B 直接拿走 term
    now = new Date(now.getTime() + 31_000)
    const stolen = repo.acquireLeader({
      leaderAlias: "B",
      ttlSeconds: 30,
      now: now.toISOString(),
    })
    assert.ok(stolen, "B 抢成功（A lease 已过期）")
    // 等 A heartbeat 跑 → renewLeader 拒 → selfDemote → onLeaderDemote
    const demoted = await waitFor(() => runtime.leaderRole() === "demoted", {
      timeoutMs: 3000,
    })
    assert.ok(demoted, "A 应自降级")
    await waitFor(() => edStopped > 0)
    assert.equal(edStopped, 1, "demote 应停 event-driven jobs")
    const traces = readTraces(tempDir, "scheduler-leader")
    const t = traces.find((x) => x.status === "lease_lost")
    assert.ok(t, "demote 应落 lease_lost trace")
    assert.equal(t!.reason, "heartbeat_failed")
    assert.equal(t!.alertedRoom, null, "无 pushAlert 注入 → alertedRoom null")
  } finally {
    await runtime.stop()
    close()
    safeCleanup(tempDir)
  }
})
