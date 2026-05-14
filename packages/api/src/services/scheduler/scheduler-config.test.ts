/**
 * F027 P19.3a · ConfigLoader 测试 — AC-P2-3a (v2b F3)
 *
 * 覆盖：
 *   - 无 wiki.config.yaml → fallback 内置默认（fromFile=false）
 *   - DEFAULT_SCHEDULER_CONFIG 全部 cron pattern 通过 croner 校验
 *   - DEFAULT_SCHEDULER_CONFIG 含 7 个已知 scheduled job
 *   - **Iron Laws 3 gate**：测试运行前后 worktree 内 wiki.config.yaml 不存在 / 未被创建
 *   - YAML 文件解析路径（用 tempdir，避开 worktree 根 wiki.config.yaml 名）
 *   - 非法 cron / 缺字段 → 抛错
 *   - **DST fixture**：America/New_York spring forward (2026-03-08)
 *     + fall back (2026-11-01) → croner.nextRun 单调推进，不重复 / 不跳过
 *   - tz Asia/Shanghai (UTC+8 无 DST) → 跨 DST 边界仍线性
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { Cron } from "croner"
import {
  DEFAULT_SCHEDULER_CONFIG,
  assertNoConfigFile,
  loadSchedulerConfig,
} from "./scheduler-config"

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

// ── Iron Laws 3 fail-safe：测试运行前 + 收尾后 worktree 根都不应有 wiki.config.yaml ──
test("scheduler-config · Iron Laws 3 (pre): worktree root has NO wiki.config.yaml", () => {
  const root = process.cwd()
  assertNoConfigFile(root) // throws if violated
})

test("scheduler-config · loadSchedulerConfig with no file → fallback default + fromFile=false", () => {
  const tempDir = safeTempDir("scheduler-config-no-file-")
  try {
    const result = loadSchedulerConfig({ rootDir: tempDir })
    assert.equal(result.fromFile, false)
    assert.equal(result.config.source, "fallback:default")
    assert.equal(result.config.defaultTimezone, "Asia/Shanghai")
    assert.equal(result.config.scheduled.length, DEFAULT_SCHEDULER_CONFIG.scheduled.length)
    // **Iron Laws 3**: load 后 worktree 内不应有 wiki.config.yaml
    assert.equal(
      fs.existsSync(path.join(tempDir, "wiki.config.yaml")),
      false,
      "loadSchedulerConfig must NOT create wiki.config.yaml",
    )
  } finally {
    safeCleanup(tempDir)
  }
})

test("scheduler-config · DEFAULT_SCHEDULER_CONFIG all cron patterns valid (croner)", () => {
  for (const job of DEFAULT_SCHEDULER_CONFIG.scheduled) {
    assert.doesNotThrow(
      () => new Cron(job.cron, { timezone: job.timezone, paused: true }),
      `invalid cron in default: ${job.name} '${job.cron}'`,
    )
  }
})

test("scheduler-config · DEFAULT_SCHEDULER_CONFIG covers known scheduled jobs", () => {
  const expectedNames = [
    "room-compiler-tick",
    "nightly-health-check",
    "nightly-vacuum",
    "weekly-draft-digest",
    "drift-detector",
    "monthly-snapshot",
    "archive-yearly-sessions",
  ]
  const actualNames = DEFAULT_SCHEDULER_CONFIG.scheduled.map((j) => j.name).sort()
  assert.deepEqual(actualNames, expectedNames.sort())
})

test("scheduler-config · DEFAULT all jobs have non-zero timeout + windowMinutes", () => {
  for (const job of DEFAULT_SCHEDULER_CONFIG.scheduled) {
    assert.ok(job.timeoutSeconds > 0, `${job.name}: timeoutSeconds must be > 0`)
    assert.ok(job.windowMinutes > 0, `${job.name}: windowMinutes must be > 0`)
  }
})

// ── YAML 解析路径（用 tempdir，文件名不同于 wiki.config.yaml 也行——这里直接走 configPath 注入）──
test("scheduler-config · YAML file load (via configPath override; not at worktree root)", () => {
  const tempDir = safeTempDir("scheduler-config-yaml-")
  const configPath = path.join(tempDir, "test.scheduler.yaml")
  try {
    fs.writeFileSync(
      configPath,
      [
        "defaultTimezone: Asia/Shanghai",
        "scheduled:",
        "  - name: my-test-job",
        "    cron: '0 12 * * *'",
        "    timezone: Asia/Shanghai",
        "    timeoutSeconds: 120",
        "    windowMinutes: 5",
      ].join("\n"),
      "utf-8",
    )
    const result = loadSchedulerConfig({ configPath })
    assert.equal(result.fromFile, true)
    assert.match(result.config.source, /^file:/)
    assert.equal(result.config.scheduled.length, 1)
    assert.equal(result.config.scheduled[0].name, "my-test-job")
    assert.equal(result.config.scheduled[0].cron, "0 12 * * *")
  } finally {
    safeCleanup(tempDir)
  }
})

test("scheduler-config · YAML invalid cron → throws", () => {
  const tempDir = safeTempDir("scheduler-config-bad-cron-")
  const configPath = path.join(tempDir, "test.scheduler.yaml")
  try {
    fs.writeFileSync(
      configPath,
      [
        "defaultTimezone: Asia/Shanghai",
        "scheduled:",
        "  - name: bad-cron-job",
        "    cron: 'not-a-cron-pattern'",
      ].join("\n"),
      "utf-8",
    )
    assert.throws(() => loadSchedulerConfig({ configPath }), /invalid cron/)
  } finally {
    safeCleanup(tempDir)
  }
})

test("scheduler-config · YAML missing job.name → throws", () => {
  const tempDir = safeTempDir("scheduler-config-no-name-")
  const configPath = path.join(tempDir, "test.scheduler.yaml")
  try {
    fs.writeFileSync(
      configPath,
      ["defaultTimezone: Asia/Shanghai", "scheduled:", "  - cron: '0 0 * * *'"].join("\n"),
      "utf-8",
    )
    assert.throws(() => loadSchedulerConfig({ configPath }), /name required/)
  } finally {
    safeCleanup(tempDir)
  }
})

test("scheduler-config · YAML scheduled not array → throws", () => {
  const tempDir = safeTempDir("scheduler-config-not-array-")
  const configPath = path.join(tempDir, "test.scheduler.yaml")
  try {
    fs.writeFileSync(configPath, "scheduled: not-an-array\n", "utf-8")
    assert.throws(() => loadSchedulerConfig({ configPath }), /must be an array/)
  } finally {
    safeCleanup(tempDir)
  }
})

// ── DST 行为（croner 内置 tz 处理；本测试做语义锁库 — 跨 DST 边界 nextRun 单调）──

test("scheduler-config · DST fixture: America/New_York spring forward (2026-03-08) — nextRun 单调", () => {
  // 美东 2026-03-08 02:00 LST → 03:00 EDT（spring forward 跳过 02:00-03:00）
  // cron "0 2 * * *" tz=America/New_York 在 spring forward 当天 02:00 不存在 → croner 推到次日
  const job = new Cron("0 2 * * *", { timezone: "America/New_York", paused: true })
  // 起点 2026-03-07T12:00Z（晚于当天 02:00 EST = 07:00Z）
  const ref = new Date("2026-03-07T12:00:00.000Z")
  const next1 = job.nextRun(ref)
  assert.ok(next1, "next1 should exist")
  // 2026-03-08T02:00 EST = 07:00 UTC，但 spring forward 跳过 02:00-03:00 → 03:00 EDT = 07:00 UTC
  // 不论 croner 选哪个，next1 应在 ref 之后
  assert.ok(next1!.getTime() > ref.getTime(), "next1 > ref")
  // next2 严格在 next1 之后（24h+ 跨 DST 边界）
  const next2 = job.nextRun(next1)
  assert.ok(next2, "next2 should exist")
  assert.ok(next2!.getTime() > next1!.getTime(), "next2 > next1 (monotonic across DST)")
})

test("scheduler-config · DST fixture: America/New_York fall back (2026-11-01) — nextRun 单调", () => {
  // 美东 2026-11-01 02:00 EDT → 01:00 EST（fall back 重复 01:00-02:00）
  // cron "30 1 * * *" tz=America/New_York 在 fall back 日 01:30 出现两次 → croner 应只触发一次
  const job = new Cron("30 1 * * *", { timezone: "America/New_York", paused: true })
  const ref = new Date("2026-10-31T12:00:00.000Z")
  const next1 = job.nextRun(ref)
  assert.ok(next1)
  assert.ok(next1!.getTime() > ref.getTime())
  // 推进到下一次：next2 应在 next1 之后（不重复触发同一墙时刻）
  const next2 = job.nextRun(next1)
  assert.ok(next2)
  assert.ok(
    next2!.getTime() - next1!.getTime() >= 23 * 3600 * 1000,
    `fall-back day next2 距 next1 至少 23h（含 25h gain），实际差 ${(next2!.getTime() - next1!.getTime()) / 3600000}h`,
  )
})

test("scheduler-config · Asia/Shanghai (UTC+8 no DST) — nextRun exactly 24h apart", () => {
  // 取 DST 边界附近日期验证 Asia/Shanghai 不受影响
  const job = new Cron("0 4 * * *", { timezone: "Asia/Shanghai", paused: true })
  const ref = new Date("2026-03-07T12:00:00.000Z")
  const next1 = job.nextRun(ref)
  const next2 = job.nextRun(next1)
  assert.ok(next1 && next2)
  const diffMs = next2!.getTime() - next1!.getTime()
  assert.equal(diffMs, 24 * 3600 * 1000, `Asia/Shanghai 应严格 24h 间隔，实际 ${diffMs / 3600000}h`)
})

// ── Iron Laws 3 fail-safe：所有测试结束后再次断言 worktree 根无 wiki.config.yaml ──
test("scheduler-config · Iron Laws 3 (post): worktree root still has NO wiki.config.yaml", () => {
  const root = process.cwd()
  assertNoConfigFile(root)
})
