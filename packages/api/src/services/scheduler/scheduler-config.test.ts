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
import { SMTP_SEND_DEADLINE_MS } from "../daily-digest/email-sender"
import {
  DEFAULT_SUBTITLE_TIMEOUT_MS,
  SUBTITLE_429_RETRY_DELAY_MS,
} from "../daily-digest/sources/youtube-subs"
import { DEFAULT_TIMEOUT_MS, MAX_SUMMARIZE_ATTEMPTS } from "../daily-digest/summarizer"
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

// 范-r1 P1-1: Iron Laws 3 fail-safe — root 真文件存在 + gate2Approved=false → throw
test("scheduler-config · 范-r1 P1-1: root wiki.config.yaml 存在 + gate2Approved=false → throw", () => {
  const tempDir = safeTempDir("scheduler-config-iron-laws-3-")
  try {
    // 模拟有人偷偷创建 wiki.config.yaml (Iron Laws 3 violation)
    fs.writeFileSync(
      path.join(tempDir, "wiki.config.yaml"),
      "scheduled:\n  - name: stealth-job\n    cron: '0 0 * * *'\n",
      "utf-8",
    )
    assert.throws(
      () => loadSchedulerConfig({ rootDir: tempDir }), // 默认 gate2Approved=false
      /Iron Laws 3 violation.*gate2Approved=false/,
    )
  } finally {
    safeCleanup(tempDir)
  }
})

test("scheduler-config · 范-r1 P1-1: root wiki.config.yaml 存在 + gate2Approved=true → 正常加载", () => {
  const tempDir = safeTempDir("scheduler-config-gate2-approved-")
  try {
    fs.writeFileSync(
      path.join(tempDir, "wiki.config.yaml"),
      [
        "defaultTimezone: Asia/Shanghai",
        "scheduled:",
        "  - name: gate2-approved-job",
        "    kind: cron",
        "    cron: '0 6 * * *'",
        "    timezone: Asia/Shanghai",
        "    timeoutSeconds: 300",
        "    windowMinutes: 5",
      ].join("\n"),
      "utf-8",
    )
    const result = loadSchedulerConfig({ rootDir: tempDir, gate2Approved: true })
    assert.equal(result.fromFile, true)
    assert.equal(result.config.scheduled.length, 1)
    assert.equal(result.config.scheduled[0].name, "gate2-approved-job")
  } finally {
    safeCleanup(tempDir)
  }
})

test("scheduler-config · 范-r1 P1-1: configPath override 跳过 gate2 fail-safe（测试场景）", () => {
  const tempDir = safeTempDir("scheduler-config-explicit-path-")
  const configPath = path.join(tempDir, "test.scheduler.yaml")
  try {
    // configPath 注入路径不受 gate2 约束（测试 / 开发用）
    fs.writeFileSync(
      configPath,
      "scheduled:\n  - name: t\n    kind: cron\n    cron: '0 0 * * *'\n",
      "utf-8",
    )
    // 默认 gate2Approved=false 但 configPath 注入 → 不抛
    assert.doesNotThrow(() => loadSchedulerConfig({ configPath }))
  } finally {
    safeCleanup(tempDir)
  }
})

test("scheduler-config · DEFAULT all 'cron' kind patterns valid (croner) — non-cron skipped", () => {
  for (const job of DEFAULT_SCHEDULER_CONFIG.scheduled) {
    if (job.kind !== "cron") continue
    assert.doesNotThrow(
      () => new Cron(job.cron, { timezone: job.timezone, paused: true }),
      `invalid cron in default: ${job.name} '${job.cron}'`,
    )
  }
})

// 范-r1 P1-2: feature.md AC-P2-1 锁定 scheduled jobs 清单（F027 原 9 个；F037 日报 +3：
// daily-digest / daily-digest-reconcile / daily-digest-startup → 现 12 个）
test("scheduler-config · 范-r1 P1-2: DEFAULT 锁定 12 scheduled jobs (9 cron + 2 startup + 1 watcher)", () => {
  const expectedNames = [
    "room-compiler-tick",
    "nightly-health-check",
    "nightly-vacuum",
    "weekly-draft-digest",
    "drift-detector",
    "monthly-snapshot",
    "archive-yearly-sessions",
    "daily-digest",
    "daily-digest-reconcile",
    "startup-reconciler",
    "daily-digest-startup",
    "docs-watcher",
  ]
  const actualNames = DEFAULT_SCHEDULER_CONFIG.scheduled.map((j) => j.name).sort()
  assert.deepEqual(actualNames, [...expectedNames].sort())
  assert.equal(
    DEFAULT_SCHEDULER_CONFIG.scheduled.length,
    12,
    "exactly 12 scheduled (AC-P2-1 + F037)",
  )
})

// 德彪 DE-r3 锁值机制：日报三入口看门狗精确锁值，防回归改小产生假 timeout/幽灵任务。
// 最坏账见下一个测试（07-11 三拍 r1 P2-2 德彪重算→r2 修正 5670→07-12 字幕 429 重试 5970s）
test("scheduler-config · F037: 日报三入口看门狗 = 7200s（> 全链最坏 5970s，含摘要重试）", () => {
  for (const name of ["daily-digest", "daily-digest-reconcile", "daily-digest-startup"]) {
    const job = DEFAULT_SCHEDULER_CONFIG.scheduled.find((j) => j.name === name)
    assert.equal(job?.timeoutSeconds, 7200, name)
  }
})

// 07-11 三拍 r1 P2-2（德彪）：锁值之外补账目关系——摘要腿从 summarizer 导出常量推导，
// 重试次数 / LLM 超时改动直接改变最坏账，看门狗不够时这里变红（此前只锁 ===7200 不随腿动）。
// 其余腿预算散在各源文件（来源注释在行内），改那些预算时必须回来同步这笔账。
test("scheduler-config · F037: 看门狗 > 全链最坏账（腿账关系可校验，改腿必红）", () => {
  const llmS = DEFAULT_TIMEOUT_MS / 1000 // summarizer 单模型单次 360s
  const sourceStageMaxS = 900 // 并发源阶段取 max：podcast.ts timeoutBudgetMs 900_000（X 540 次之）
  const summarizeS = MAX_SUMMARIZE_ATTEMPTS * 2 * llmS // 4 尝试 × primary+fallback
  // 字幕单条最坏 = 90s 首次 + 30s 429 退避 + 90s 重试（07-12 字幕命中率批）；盖过非 yt 20s http 回落
  const subtitleWorstS = (DEFAULT_SUBTITLE_TIMEOUT_MS + SUBTITLE_429_RETRY_DELAY_MS + DEFAULT_SUBTITLE_TIMEOUT_MS) / 1000
  const deepReadS = 3 * subtitleWorstS + 2 * llmS // 3 条深读 + LLM 双模型
  const translateS = 2 * llmS
  // r2 P2-2：SMTP 腿只认发送总 deadline（三段 nodemailer 超时是无活动窗，推不出总上限）
  const smtpS = SMTP_SEND_DEADLINE_MS / 1000
  const worstS = sourceStageMaxS + summarizeS + deepReadS + translateS + smtpS
  assert.equal(worstS, 5970, "腿账变了——改 daily-digest 看门狗注释并重核 7200 余量")
  for (const name of ["daily-digest", "daily-digest-reconcile", "daily-digest-startup"]) {
    const job = DEFAULT_SCHEDULER_CONFIG.scheduled.find((j) => j.name === name)
    assert.ok(
      (job?.timeoutSeconds ?? 0) > worstS,
      `${name}: 看门狗 ${job?.timeoutSeconds}s 必须 > 最坏账 ${worstS}s`,
    )
  }
})

test("scheduler-config · 范-r1 P1-2: kind 分布 9 cron + 2 startup + 1 watcher", () => {
  const byKind: Record<string, number> = { cron: 0, startup: 0, watcher: 0 }
  for (const job of DEFAULT_SCHEDULER_CONFIG.scheduled) {
    byKind[job.kind] = (byKind[job.kind] ?? 0) + 1
  }
  assert.deepEqual(byKind, { cron: 9, startup: 2, watcher: 1 })
})

// 范-r1 P2-1: windowMinutes 全部 5 (cron) / 0 (non-cron)，违反 plan §4 min(cron_period, 5min) 修复
test("scheduler-config · 范-r1 P2-1: cron kind windowMinutes=5 / non-cron=0 (plan §4 锁定)", () => {
  for (const job of DEFAULT_SCHEDULER_CONFIG.scheduled) {
    if (job.kind === "cron") {
      assert.equal(
        job.windowMinutes,
        5,
        `${job.name}: cron kind windowMinutes 应统一 5（长任务用 timeoutSeconds 表达）`,
      )
    } else {
      assert.equal(job.windowMinutes, 0, `${job.name}: non-cron kind windowMinutes=0`)
    }
  }
})

test("scheduler-config · DEFAULT all jobs have positive timeoutSeconds", () => {
  for (const job of DEFAULT_SCHEDULER_CONFIG.scheduled) {
    assert.ok(job.timeoutSeconds > 0, `${job.name}: timeoutSeconds must be > 0`)
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
        "    kind: cron",
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
    assert.equal(result.config.scheduled[0].kind, "cron")
    assert.equal(result.config.scheduled[0].cron, "0 12 * * *")
  } finally {
    safeCleanup(tempDir)
  }
})

// 范-r1 P1-2: YAML 解析支持 kind='startup' / 'watcher' (skip cron 校验)
test("scheduler-config · YAML kind='startup' / 'watcher' skip cron validation", () => {
  const tempDir = safeTempDir("scheduler-config-non-cron-kind-")
  const configPath = path.join(tempDir, "test.scheduler.yaml")
  try {
    fs.writeFileSync(
      configPath,
      [
        "defaultTimezone: Asia/Shanghai",
        "scheduled:",
        "  - name: startup-job",
        "    kind: startup",
        "    cron: '@startup'", // 非合法 cron 但 kind='startup' 跳过校验
        "    timezone: Asia/Shanghai",
        "    timeoutSeconds: 60",
        "    windowMinutes: 0",
        "  - name: watcher-job",
        "    kind: watcher",
        "    cron: '@watcher'",
        "    timezone: Asia/Shanghai",
        "    timeoutSeconds: 30",
        "    windowMinutes: 0",
      ].join("\n"),
      "utf-8",
    )
    const result = loadSchedulerConfig({ configPath })
    assert.equal(result.config.scheduled.length, 2)
    assert.equal(result.config.scheduled[0].kind, "startup")
    assert.equal(result.config.scheduled[1].kind, "watcher")
  } finally {
    safeCleanup(tempDir)
  }
})

test("scheduler-config · YAML invalid kind value → throws", () => {
  const tempDir = safeTempDir("scheduler-config-bad-kind-")
  const configPath = path.join(tempDir, "test.scheduler.yaml")
  try {
    fs.writeFileSync(
      configPath,
      ["scheduled:", "  - name: weird", "    kind: not-a-kind", "    cron: '0 0 * * *'"].join("\n"),
      "utf-8",
    )
    assert.throws(
      () => loadSchedulerConfig({ configPath }),
      /kind must be 'cron'\|'startup'\|'watcher'/,
    )
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
