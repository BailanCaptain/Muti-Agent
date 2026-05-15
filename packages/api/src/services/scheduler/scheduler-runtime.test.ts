/**
 * F027 P19.16 · SchedulerRuntime 测试 — AC-P2-1
 *
 * 覆盖：
 *   - start/stop lifecycle + health()
 *   - cron job 触发 → job_trace 落盘 status='ok' + 时间窗字段完整
 *   - cron job throw → trace status='failed' + pushAlert R-201
 *   - cron job timeout → trace status='timeout'
 *   - cron job 自报 outcome.status='missed_window' → trace 记之
 *   - 非 leader runtime → guard skip → trace status='skipped_not_leader' + reason
 *   - startup job 起来跑一次 → trace
 *   - startup job 非 leader → skipped_not_leader trace
 *   - event-driven job start/stop 被调用
 *   - 重复 cron name → 构造抛错
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

// ── lifecycle ────────────────────────────────────────────────────────────

test("SchedulerRuntime · AC-P2-1: start/stop lifecycle + health()", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({
    leaderAlias: "lc-A",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const runtime = new SchedulerRuntime({
    leader,
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
    await runtime.stop()
    assert.equal(runtime.health().running, false)
  } finally {
    await runtime.stop()
    leader.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · start() idempotent", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({
    leaderAlias: "lc-idem",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const runtime = new SchedulerRuntime({
    leader,
    rootDir: tempDir,
    cronJobs: [{ name: "j", cron: "0 4 * * *", timeoutSeconds: 60, run: async () => {} }],
  })
  try {
    await runtime.start()
    await runtime.start() // noop
    assert.equal(runtime.health().jobs.length, 1)
  } finally {
    await runtime.stop()
    leader.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · 重复 cron name → 构造抛错", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({ leaderAlias: "lc-dup", leaseRepo: repo })
  try {
    assert.throws(
      () =>
        new SchedulerRuntime({
          leader,
          rootDir: tempDir,
          cronJobs: [
            { name: "dup", cron: "0 4 * * *", timeoutSeconds: 60, run: async () => {} },
            { name: "dup", cron: "0 5 * * *", timeoutSeconds: 60, run: async () => {} },
          ],
        }),
      /duplicate cron job/,
    )
  } finally {
    leader.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── cron job 触发 → trace ────────────────────────────────────────────────

test("SchedulerRuntime · AC-P2-1: cron job 触发 → job_trace 落盘 status=ok", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({
    leaderAlias: "lc-ok",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  let runs = 0
  const runtime = new SchedulerRuntime({
    leader,
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
    validateJobTrace(t) // schema 合法
    assert.equal(t.status, "ok")
    assert.equal(t.jobName, "tick")
    assert.ok(t.startedAt !== null && t.finishedAt !== null)
    assert.ok(typeof t.durationMs === "number" && t.durationMs >= 0)
    assert.match(t.scheduledFor, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(t.windowEnd, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(t.error, null)
  } finally {
    await runtime.stop()
    leader.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · cron job throw → trace status=failed + pushAlert R-201", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({
    leaderAlias: "lc-fail",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const alerts: JobTrace[] = []
  const runtime = new SchedulerRuntime({
    leader,
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
    const t = traces[0]
    assert.equal(t.status, "failed")
    assert.ok(t.error !== null && /kaboom/.test(t.error.message))
    assert.equal(t.alertedRoom, "R-201")
    assert.ok(alerts.length > 0, "failed → pushAlert 被调用")
    assert.equal(alerts[0].status, "failed")
  } finally {
    await runtime.stop()
    leader.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · cron job timeout → trace status=timeout", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({
    leaderAlias: "lc-to",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const runtime = new SchedulerRuntime({
    leader,
    rootDir: tempDir,
    cronJobs: [
      {
        name: "slow",
        cron: "* * * * * *",
        timeoutSeconds: 0.1, // 100ms timeout
        run: async () => {
          await sleep(2000) // 远超 timeout
        },
      },
    ],
  })
  try {
    await runtime.start()
    const traces = await waitForTrace(tempDir, "slow")
    const t = traces.find((x) => x.status === "timeout")
    assert.ok(t, "应有一条 timeout trace")
    assert.ok(t!.error !== null && /timeout/.test(t!.error.message))
  } finally {
    await runtime.stop()
    leader.stop()
    close()
    safeCleanup(tempDir)
  }
})

test("SchedulerRuntime · cron job 自报 outcome.status=missed_window → trace 记之", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({
    leaderAlias: "lc-mw",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const runtime = new SchedulerRuntime({
    leader,
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
    leader.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── leader guard ─────────────────────────────────────────────────────────

test("SchedulerRuntime · 非 leader runtime → guard skip → trace skipped_not_leader", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  // leaderA 先抢到 → leaderB 成 follower
  const leaderA = new SchedulerLeader({
    leaderAlias: "A",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  leaderA.start()
  const leaderB = new SchedulerLeader({
    leaderAlias: "B",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  let runs = 0
  const runtime = new SchedulerRuntime({
    leader: leaderB,
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
    assert.equal(leaderB.getRole(), "follower")
    const traces = await waitForTrace(tempDir, "gated")
    const t = traces[0]
    assert.equal(t.status, "skipped_not_leader")
    assert.equal(t.reason, "role_not_leader")
    assert.equal(t.startedAt, null)
    assert.equal(runs, 0, "follower 不应真跑 job body")
  } finally {
    await runtime.stop()
    leaderA.stop()
    leaderB.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── startup jobs ─────────────────────────────────────────────────────────

test("SchedulerRuntime · startup job 起来跑一次 → trace", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({
    leaderAlias: "lc-su",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  let ran = 0
  const runtime = new SchedulerRuntime({
    leader,
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
    leader.stop()
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
  const leaderB = new SchedulerLeader({
    leaderAlias: "B",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  let ran = 0
  const runtime = new SchedulerRuntime({
    leader: leaderB,
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
    leaderB.stop()
    close()
    safeCleanup(tempDir)
  }
})

// ── event-driven jobs ────────────────────────────────────────────────────

test("SchedulerRuntime · event-driven job start/stop 被调用", async () => {
  const tempDir = safeTempDir("sched-runtime-")
  const { repo, close } = await buildRepo(tempDir)
  const leader = new SchedulerLeader({
    leaderAlias: "lc-ed",
    leaseRepo: repo,
    heartbeatIntervalMs: 9_999_999,
    followerPollIntervalMs: 9_999_999,
  })
  const calls: string[] = []
  const runtime = new SchedulerRuntime({
    leader,
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
    assert.deepEqual(calls, ["watcher:start", "alert:start"])
    await runtime.stop()
    assert.deepEqual(calls, ["watcher:start", "alert:start", "watcher:stop", "alert:stop"])
  } finally {
    await runtime.stop()
    leader.stop()
    close()
    safeCleanup(tempDir)
  }
})
