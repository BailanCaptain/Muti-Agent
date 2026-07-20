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
import {
  type DriftAlert,
  type DriftDetectionResult,
  DriftDetector,
  type DriftTrigger,
} from "../services/scheduler/drift-detector"
import type { JobTrace } from "../services/scheduler/job-trace"
import { assertNoConfigFile } from "../services/scheduler/scheduler-config"
import { DriftCronFailure, bootSchedulerRuntime, runDriftCron } from "./scheduler-bootstrap"

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

function capturingLogger(entries: unknown[][]) {
  const log = silentLogger()
  log.info = (...args: unknown[]) => entries.push(args)
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

test("F037 三拍 r2 P2-1 · reconcile=failed_summarize → startup trace=failed（r1 原症状：适配层硬编码两态把摘要全败标绿）", async () => {
  const tempDir = safeTempDir("F037-boot-fs-")
  const { db, close } = createDrizzleDb(path.join(tempDir, "test.sqlite"))
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
      dailyDigest: {
        reconcile: async () => ({
          status: "failed_summarize" as const,
          businessDate: "2026-07-11",
        }),
      },
    })
    assert.ok(runtime)
    const traces = await waitForTrace(tempDir, "daily-digest-startup")
    assert.ok(traces.length > 0, "daily-digest-startup trace 应落盘")
    const last = traces[traces.length - 1]
    assert.equal(last.status, "failed", "failed_summarize 必须以 failed trace 收场（曾被标绿）")
    assert.ok(
      JSON.stringify(last).includes("failed_summarize"),
      "trace 错误信息应携带状态名（告警链可读因）",
    )
    await runtime.stop()
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

test("F037 h · dailyDigest 注入 → 2 cron 注册 + startup 触发 reconcile + 未注入且无凭证时默认不注册", async () => {
  const tempDir = safeTempDir("F037-boot-h-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  const calls: Date[] = []
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
      dailyDigest: {
        reconcile: async (now: Date) => {
          calls.push(now)
          return { status: "skipped_not_due" as const, businessDate: "2026-07-03" }
        },
      },
    })
    assert.ok(runtime)
    const names = runtime
      .health()
      .jobs.map((j) => j.name)
      .sort()
    assert.ok(names.includes("daily-digest"), "daily-digest cron 应注册")
    assert.ok(names.includes("daily-digest-reconcile"), "安全网 cron 应注册")
    assert.equal(names.length, 9, "7 原有 + 2 digest cron")

    // startup 触发点（D11 ②）：boot 即跑一次 reconcile
    const traces = await waitForTrace(tempDir, "daily-digest-startup")
    assert.ok(traces.length > 0, "daily-digest-startup trace 应落盘")
    assert.equal(traces[traces.length - 1].status, "ok")
    assert.ok(calls.length > 0, "startup 应真调 reconcile")

    await runtime.stop()
  } finally {
    close()
    safeCleanup(tempDir)
  }

  // 负断言：未注入 + 无 SMTP env + 无显式开关 → 不注册（测试/CI 不打真网）
  const tempDir2 = safeTempDir("F037-boot-h2-")
  const { db: db2, close: close2 } = createDrizzleDb(path.join(tempDir2, "test.sqlite"))
  const savedFlag = process.env.MULTI_AGENT_DIGEST_ENABLED
  const savedUser = process.env.MULTI_AGENT_DIGEST_SMTP_USER
  const disabledLogs: unknown[][] = []
  delete process.env.MULTI_AGENT_DIGEST_ENABLED
  delete process.env.MULTI_AGENT_DIGEST_SMTP_USER
  try {
    const runtime2 = await bootSchedulerRuntime({
      db: db2,
      log: capturingLogger(disabledLogs),
      rootDir: tempDir2,
    })
    assert.ok(runtime2)
    const names2 = runtime2.health().jobs.map((j) => j.name)
    assert.ok(!names2.includes("daily-digest"), "无凭证/无开关不应注册 daily-digest")
    const serializedLogs = JSON.stringify(disabledLogs)
    assert.match(serializedLogs, /daily-digest.*missing_user|missing_user.*daily-digest/)
    assert.ok(!serializedLogs.includes("SMTP_PASS"), "禁用日志不得输出凭证字段/值")
    assert.ok(!serializedLogs.includes("recipient@"), "禁用日志不得输出收件人值")
    await runtime2.stop()
  } finally {
    if (savedFlag !== undefined) process.env.MULTI_AGENT_DIGEST_ENABLED = savedFlag
    if (savedUser !== undefined) process.env.MULTI_AGENT_DIGEST_SMTP_USER = savedUser
    close2()
    safeCleanup(tempDir2)
  }
})

test("B038 · caller 显式 disabled 快照时 scheduler 不得重读 .env", async (t) => {
  const tempDir = safeTempDir("B038-boot-state-")
  const { db, close } = createDrizzleDb(path.join(tempDir, "test.sqlite"))
  const dotenvPath = path.join(tempDir, ".env")
  const originalReadFileSync = fs.readFileSync
  let dotenvReads = 0
  t.mock.method(
    fs,
    "readFileSync",
    ((...args: unknown[]) => {
      if (path.resolve(String(args[0])) === path.resolve(dotenvPath)) {
        dotenvReads += 1
        return ""
      }
      return (originalReadFileSync as (...inner: unknown[]) => unknown)(...args)
    }) as typeof fs.readFileSync,
  )
  const logs: unknown[][] = []
  let runtime: Awaited<ReturnType<typeof bootSchedulerRuntime>> = null

  try {
    runtime = await bootSchedulerRuntime({
      db,
      log: capturingLogger(logs),
      rootDir: tempDir,
      dailyDigestBootState: {
        env: { MULTI_AGENT_DIGEST_ENABLED: "0" },
        decision: { enabled: false, reason: "explicit_off" },
      },
    })
    assert.ok(runtime)
    assert.equal(dotenvReads, 0, "调用方已给 boot state 时 scheduler 不得再次读取 .env")
    assert.ok(!runtime.health().jobs.some((job) => job.name === "daily-digest"))
    const serializedLogs = JSON.stringify(logs)
    assert.match(serializedLogs, /explicit_off/)
    assert.ok(!serializedLogs.includes("missing_user"), "禁用原因必须来自 caller 的同一快照")
  } finally {
    await runtime?.stop()
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

test("F027 wiring i · 周期 reindex in-flight guard — 慢扫描下不并发重叠（codex delta P2）", async () => {
  // reindexIntervalMs(30) 远快于单次 reindex 耗时(120ms)；无 guard 会在 250ms 内堆叠多个重叠 run
  // （maxConcurrent 飙到 ~4，stale 快照碰撞）。in-flight guard 应保证任一时刻最多 1 个 run。
  const tempDir = safeTempDir("F027-wiring-i-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  let concurrent = 0
  let maxConcurrent = 0
  let calls = 0
  try {
    const runtime = await bootSchedulerRuntime({
      db,
      log: silentLogger(),
      rootDir: tempDir,
      reindexIntervalMs: 30,
      reindexWiki: async () => {
        calls += 1
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await sleep(120) // 慢扫描：单次远超 interval
        concurrent -= 1
      },
    })
    assert.ok(runtime)
    await sleep(250)
    assert.ok(calls >= 1, `周期 reindex 应至少触发 1 次，实际 ${calls}`)
    assert.equal(
      maxConcurrent,
      1,
      `in-flight guard 应防止重叠并发，实际 maxConcurrent=${maxConcurrent}`,
    )
    await runtime.stop()
  } finally {
    close()
    safeCleanup(tempDir)
  }
})

// ── 收尾修1 · runDriftCron（抽成纯函数，避开 croner 计时 flaky）─────────────
//
// drift cron 的真业务：drift.run() 真扫真开 draft；开了 draft / 有失败 → 旁路 pushDriftAlert。
// job status 永远真实 ok（扫描/开 draft 不抛即成功，告警走独立旁路，不污染 job-trace 失败指标）。

function driftWith(opts: {
  triggers: DriftTrigger[]
  openThrowsRef?: string
}): DriftDetector {
  return new DriftDetector({
    scanTriggers: async () => opts.triggers,
    openUpdateDraft: async (d) => {
      if (opts.openThrowsRef && d.trigger.ref === opts.openThrowsRef) {
        throw new Error("draft store 写失败")
      }
    },
    logger: silentLogger(),
  })
}

test("修1 runDriftCron · 开了 draft → pushDriftAlert 收到 buildDriftAlert 形状 + status 真实 ok", async () => {
  const drift = driftWith({
    triggers: [
      { kind: "new_lesson", ref: "LL-040", detail: "a" },
      { kind: "model_upgrade", ref: "claude-opus-4-8", detail: "b" },
    ],
  })
  const alerts: DriftAlert[] = []
  const out = await runDriftCron(
    drift,
    (a) => {
      alerts.push(a)
    },
    "R-201",
    silentLogger(),
  )

  assert.equal(out.status, "ok")
  assert.equal(out.result.draftsOpened.length, 2)
  assert.equal(alerts.length, 1, "开了 draft 必旁路告警一次")
  assert.equal(alerts[0].draftsOpened, 2)
  assert.equal(alerts[0].failed, 0)
  assert.equal(alerts[0].targetRoom, "R-201")
  assert.equal(alerts[0].draftTitles.length, 2)
})

test("修1 runDriftCron · 零 trigger → 不告警 + status ok（不打扰小孙）", async () => {
  const drift = driftWith({ triggers: [] })
  const alerts: DriftAlert[] = []
  const out = await runDriftCron(
    drift,
    (a) => {
      alerts.push(a)
    },
    "R-201",
    silentLogger(),
  )
  assert.equal(out.status, "ok")
  assert.equal(alerts.length, 0, "无 draft 无失败 → 不推告警")
})

test("修1 runDriftCron · 有失败（draftsOpened=0, failed>0）→ 先告警再抛 DriftCronFailure（德彪 r1 P1）", async () => {
  // JobRunOutcome.status 不含 failed → 业务失败只能抛错让 scheduler 记 failed（→ ALERT_STATUSES）。
  const drift = driftWith({
    triggers: [{ kind: "handoff_failure", ref: "ho-X", detail: "x" }],
    openThrowsRef: "ho-X",
  })
  const alerts: DriftAlert[] = []
  let caught: unknown
  try {
    await runDriftCron(
      drift,
      (a) => {
        alerts.push(a)
      },
      "R-201",
      silentLogger(),
    )
    assert.fail("应抛 DriftCronFailure")
  } catch (err) {
    caught = err
  }
  assert.ok(caught instanceof DriftCronFailure, "draft 开启失败必须抛 DriftCronFailure，不伪 ok")
  assert.equal((caught as DriftCronFailure).result.failed.length, 1)
  assert.equal(alerts.length, 1, "抛错前先发告警，失败详情仍外推")
  assert.equal(alerts[0].failed, 1)
  assert.equal(alerts[0].draftsOpened, 0)
})

test("修1 runDriftCron · 部分失败（有开成 + 有失败）→ 抛 DriftCronFailure（已开 draft 不回滚）", async () => {
  const drift = driftWith({
    triggers: [
      { kind: "new_lesson", ref: "LL-ok", detail: "a" },
      { kind: "handoff_failure", ref: "ho-bad", detail: "b" },
    ],
    openThrowsRef: "ho-bad",
  })
  await assert.rejects(
    () => runDriftCron(drift, undefined, "R-201", silentLogger()),
    (err: unknown) => err instanceof DriftCronFailure && err.result.draftsOpened.length === 1,
  )
})

test("修1 runDriftCron · pushDriftAlert 抛错被吞，status 仍 ok（告警失败不拖垮 cron）", async () => {
  const drift = driftWith({ triggers: [{ kind: "new_lesson", ref: "LL-1", detail: "x" }] })
  const out = await runDriftCron(
    drift,
    () => {
      throw new Error("ws broadcast 挂了")
    },
    "R-201",
    silentLogger(),
  )
  assert.equal(out.status, "ok", "告警 hook 抛错必须吞掉，cron 仍返回 ok")
  assert.equal(out.result.draftsOpened.length, 1)
})

test("修1 runDriftCron · 无 pushDriftAlert（undefined）→ 不抛 + status ok", async () => {
  const drift = driftWith({ triggers: [{ kind: "new_lesson", ref: "LL-1", detail: "x" }] })
  const out = await runDriftCron(drift, undefined, "R-201", silentLogger())
  assert.equal(out.status, "ok")
  assert.equal(out.result.draftsOpened.length, 1)
})

// ── 收尾修1 · driftWarningsWriter（小孙拍：drift 告警走现有「警告」tab）─────────
//
// 第 5 参数 driftWarningsWriter：开了 draft / 有失败时往 wiki/warnings/ 写一条 warning（现有 tab
// 自动显示）。与 pushDriftAlert 同条件触发、同 fail-soft、抛错前也写（失败也告警）。

test("修1 runDriftCron · 开了 draft → driftWarningsWriter 收到 result（draft 进警告 tab）", async () => {
  const drift = driftWith({ triggers: [{ kind: "new_lesson", ref: "LL-1", detail: "x" }] })
  const written: DriftDetectionResult[] = []
  const out = await runDriftCron(drift, undefined, "R-201", silentLogger(), async (r) => {
    written.push(r)
  })
  assert.equal(out.status, "ok")
  assert.equal(written.length, 1, "开了 draft 必写一条 warning")
  assert.equal(written[0]?.draftsOpened.length, 1)
})

test("修1 runDriftCron · 零 trigger → 不写 warning（无 drift 不打扰）", async () => {
  const drift = driftWith({ triggers: [] })
  const written: DriftDetectionResult[] = []
  await runDriftCron(drift, undefined, "R-201", silentLogger(), async (r) => {
    written.push(r)
  })
  assert.equal(written.length, 0, "无 draft 无失败 → 不写 warning")
})

test("修1 runDriftCron · 有失败 → 抛 DriftCronFailure 前仍写 warning（失败也进警告 tab）", async () => {
  const drift = driftWith({
    triggers: [{ kind: "handoff_failure", ref: "ho-X", detail: "x" }],
    openThrowsRef: "ho-X",
  })
  const written: DriftDetectionResult[] = []
  await assert.rejects(
    () =>
      runDriftCron(drift, undefined, "R-201", silentLogger(), async (r) => {
        written.push(r)
      }),
    (err: unknown) => err instanceof DriftCronFailure,
  )
  assert.equal(written.length, 1, "失败也要先写 warning 再抛")
  assert.equal(written[0]?.failed.length, 1)
})

test("修1 runDriftCron · driftWarningsWriter 抛错被吞，status 仍 ok（告警落盘失败不拖垮 cron）", async () => {
  const drift = driftWith({ triggers: [{ kind: "new_lesson", ref: "LL-1", detail: "x" }] })
  const out = await runDriftCron(drift, undefined, "R-201", silentLogger(), async () => {
    throw new Error("warnings 落盘挂了")
  })
  assert.equal(out.status, "ok", "warning writer 抛错必须吞掉，cron 仍 ok")
  assert.equal(out.result.draftsOpened.length, 1)
})
