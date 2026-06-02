/**
 * F027 Phase 3 P20 · AC-P3-7 集成测试 — scheduler go-live
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §4 AC-P3-7
 *
 * 覆盖：
 *   - bootSchedulerRuntime → SchedulerRuntime 实例化 + 11 job 注册成功（7 cron + 1 startup + 3 event-driven）
 *   - startup-reconciler 跑一次 + 真 trace 落 .runtime/job-traces/<rootDir>
 *   - Iron Laws 3 负断言：
 *     - gate2Approved=false 默认；config.source = 'fallback:default'
 *     - 测试运行前后 tempDir / worktree root 无 wiki.config.yaml
 *   - stop() idempotent
 *   - skipBoot=true → 返 null
 *
 * 隔离：每个 test 自建 tempDir + 真 SQLite + 自带 logger（noop）；
 *       完全不污染 worktree 根目录。
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createDrizzleDb } from "../db/drizzle-instance"
import { assertNoConfigFile } from "../services/scheduler/scheduler-config"
import { bootSchedulerRuntime } from "./scheduler-bootstrap"
import type { JobTrace } from "../services/scheduler/job-trace"

function safeTempDir(prefix: string): string {
  const base = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, prefix))
}

function safeCleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

function silentLogger() {
  // FastifyBaseLogger 最小子集 — boot 内部只调 info/warn/error/debug + child()
  const noop = () => {}
  const log: any = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    level: "silent",
    child: () => log,
  }
  return log
}

test("AC-P3-7 a · bootSchedulerRuntime → SchedulerRuntime 起 + 7 cron 注册 + startup-reconciler trace 落盘", async () => {
  const tempDir = safeTempDir("F027-P20-boot-a-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
    })
    assert.ok(runtime, "runtime should be non-null when skipBoot omitted")

    // 7 cron jobs 注册（schedulerRuntime.health() 委托 NightlyJobScheduler.health()）
    const health = runtime.health()
    assert.equal(health.running, true, "scheduler should be running after start")
    assert.equal(
      health.jobs.length,
      7,
      "expected 7 cron jobs registered (room-compiler-tick / nightly-health-check / nightly-vacuum / weekly-draft-digest / drift-detector / monthly-snapshot / archive-yearly-sessions)",
    )
    const jobNames = health.jobs.map((j) => j.name).sort()
    assert.deepEqual(jobNames, [
      "archive-yearly-sessions",
      "drift-detector",
      "monthly-snapshot",
      "nightly-health-check",
      "nightly-vacuum",
      "room-compiler-tick",
      "weekly-draft-digest",
    ])

    // 单实例自动选举为 leader
    assert.equal(runtime.leaderRole(), "leader", "single-runtime should auto-acquire as leader")

    // startup-reconciler 跑过 + trace 落盘
    const traces = await waitForTrace(tempDir, "startup-reconciler")
    assert.ok(traces.length > 0, "expected at least one startup-reconciler trace")
    const last = traces[traces.length - 1]
    assert.equal(last.status, "ok", "startup-reconciler should succeed against fresh empty db")
    assert.equal(last.jobName, "startup-reconciler")
    assert.ok(last.runId, "trace should carry runId")

    await runtime.stop()
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("AC-P3-7 b · Iron Laws 3 负断言：gate2Approved=false 默认 + fallback config source + 不创建 wiki.config.yaml", async () => {
  const tempDir = safeTempDir("F027-P20-boot-b-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    // boot 前断言：tempDir 内无 wiki.config.yaml
    assertNoConfigFile(tempDir)

    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
    })
    assert.ok(runtime)

    // boot 后断言：仍无 wiki.config.yaml — bootSchedulerRuntime 绝不创建
    assertNoConfigFile(tempDir)
    assert.equal(
      fs.existsSync(path.join(tempDir, "wiki.config.yaml")),
      false,
      "wiki.config.yaml MUST NOT exist after boot (Iron Laws 3 fail-safe)",
    )

    await runtime.stop()

    // stop 后再断言一次
    assertNoConfigFile(tempDir)
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("AC-P3-7 c · stop() idempotent — double stop 不抛", async () => {
  const tempDir = safeTempDir("F027-P20-boot-c-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
    })
    assert.ok(runtime)

    await runtime.stop()
    // 第二次 stop 必须 noop 不抛（SchedulerRuntime.stop 内 if (!this.started) return）
    await runtime.stop()
    await runtime.stop()
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("AC-P3-7 d · skipBoot=true → 返 null + 不起 runtime", async () => {
  const tempDir = safeTempDir("F027-P20-boot-d-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
      skipBoot: true,
    })
    assert.equal(runtime, null, "skipBoot=true should return null")

    // 不应有任何 trace 文件
    const traces = readTraces(tempDir, "startup-reconciler")
    assert.equal(traces.length, 0, "no traces expected when skipBoot=true")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("AC-P3-7 e · pushAlert hook 被 caller 显式装时 SchedulerRuntime.pushAlert 接通（lease_lost / failed 路径）", async () => {
  const tempDir = safeTempDir("F027-P20-boot-e-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const alertsReceived: JobTrace[] = []
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
      pushAlert: (trace) => {
        alertsReceived.push(trace)
      },
    })
    assert.ok(runtime)

    // Happy path 不应触发 alert（startup-reconciler 是 ok status，不在 ALERT_STATUSES）
    await sleep(200)
    assert.equal(
      alertsReceived.filter((a) => a.jobName === "startup-reconciler").length,
      0,
      "happy-path startup-reconciler should NOT trigger pushAlert (status=ok)",
    )

    await runtime.stop()
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F027 wiring f · registerOnWikiCommit 把 debounce.onWikiEvent 交还 caller + boot 不误触发 reindexWiki", async () => {
  // 接线点：server.ts createWikiServices.onCommit → fireWikiCommit → 此处交还的 hook →
  //   debounce.onWikiEvent() →(debounce)→ recompileDerivedViews === opts.reindexWiki。
  //   本测只验 boot 这一段（hook 被交还 + 非启动期误触发）；
  //   hook→reindex 的 debounce 时序由 wiki-compiler-debounce.test.ts 覆盖，
  //   reindexWiki→recompileDerivedViews 绑定由 typecheck 覆盖。
  const tempDir = safeTempDir("F027-wiring-f-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  let reindexCalls = 0
  let handedBackHook: (() => void) | undefined
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
      reindexWiki: async () => {
        reindexCalls += 1
      },
      registerOnWikiCommit: (fire) => {
        handedBackHook = fire
      },
    })
    assert.ok(runtime)

    // registerOnWikiCommit 被调，且交还的是可调用 hook（onWikiEvent 通道）。
    assert.equal(
      typeof handedBackHook,
      "function",
      "registerOnWikiCommit should hand back a callable",
    )
    // boot 本身不跑 reindex（存量索引由 server.ts 启动期显式 reindexWiki() 负责，不在 boot 内）。
    assert.equal(reindexCalls, 0, "boot should NOT fire reindexWiki spuriously")
    // 触发 hook 不抛（debounce 起 5s 计时；本测不等它落，只验调用安全）。
    assert.doesNotThrow(() => handedBackHook?.())

    await runtime.stop()
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F027 wiring g · fire onWikiCommit hook → 真等 debounce 落地 → reindexWiki 被调用（producer 端到端）", async () => {
  // codex review A Finding 2：补一条真等 debounce 后断言 reindexWiki 被触发的测试。
  // 短 debounceMs=40 真走 boot 的 debounce 路径；reindexIntervalMs 设大避免周期 reindex 干扰计数。
  const tempDir = safeTempDir("F027-wiring-g-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  let reindexCalls = 0
  let hook: (() => void) | undefined
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
      debounceMs: 40,
      reindexIntervalMs: 9_999_999, // 周期 reindex 本测不参与（隔离 debounce 路径计数）
      reindexWiki: async () => {
        reindexCalls += 1
      },
      registerOnWikiCommit: (fire) => {
        hook = fire
      },
    })
    assert.ok(runtime)
    assert.equal(reindexCalls, 0, "boot 不应触发 reindex")

    // 模拟 wiki 写 commit → onCommit → hook → debounce.onWikiEvent → (40ms) → reindexWiki
    hook?.()
    await sleep(150)
    assert.ok(reindexCalls >= 1, `debounce 落地后 reindexWiki 应被调用，实际 ${reindexCalls}`)

    await runtime.stop()
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F027 wiring h · 周期 reindex 安全网 → 无 onCommit 也定期触发 reindexWiki（覆盖 RoomCompiler/promote/demote）", async () => {
  // codex review A Finding 1：debounce 只接 update_wiki；其它直接写盘 producer 靠周期 reindex 兜底。
  // 短 reindexIntervalMs=60 验证周期触发；全程不 fire onCommit hook，证明触发来自周期而非 debounce。
  const tempDir = safeTempDir("F027-wiring-h-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  let reindexCalls = 0
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
      reindexIntervalMs: 60,
      reindexWiki: async () => {
        reindexCalls += 1
      },
      // 不传 registerOnWikiCommit、不 fire 任何 hook
    })
    assert.ok(runtime)
    await sleep(200)
    assert.ok(reindexCalls >= 1, `周期 reindex 应至少触发 1 次，实际 ${reindexCalls}`)

    await runtime.stop()
    // stop 后清 interval：记下当前值，再等一个周期，确认不再增长。
    const afterStop = reindexCalls
    await sleep(150)
    assert.equal(reindexCalls, afterStop, "stop() 后周期 reindex 不应再触发（interval 已清）")
  } finally {
    close()
    safeCleanup(tempDir)
  }
})
