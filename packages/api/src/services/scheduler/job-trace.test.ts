/**
 * F027 P19.4 · job-trace 契约测试 — AC-P2-4 (v2b F2)
 *
 * 覆盖：
 *   - 8 status enum 值全部接受（v2b F2 锁定）
 *   - 4 reason enum 值全部接受
 *   - 时间窗 3 字段（scheduledFor/windowStart/windowEnd）必填
 *   - schemaVersion '1.0' 校验
 *   - 非法 status / reason / 缺字段 / 错时间格式 → throw
 *   - writeJobTrace 落点路径：<root>/.runtime/job-traces/<job>/<YYYY-MM-DD>/<HHMMSS-runId>.json
 *   - atomic write：成功后无 .tmp 残留
 *   - JSON 内容 roundtrip
 *   - 同 job 同日多次写产生不同文件（runId 区分）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import {
  JOB_TRACE_REASON_VALUES,
  JOB_TRACE_SCHEMA_VERSION,
  JOB_TRACE_STATUS_VALUES,
  type JobTrace,
  newRunId,
  validateJobTrace,
  writeJobTrace,
} from "./job-trace"

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

function makeValidTrace(overrides: Partial<JobTrace> = {}): JobTrace {
  return {
    schemaVersion: JOB_TRACE_SCHEMA_VERSION,
    jobName: "nightly-health-check",
    runId: newRunId(),
    scheduledFor: "2026-05-15T04:00:00.000Z",
    windowStart: "2026-05-15T04:00:00.000Z",
    windowEnd: "2026-05-15T04:05:00.000Z",
    startedAt: "2026-05-15T04:00:02.123Z",
    finishedAt: "2026-05-15T04:00:32.456Z",
    durationMs: 30333,
    status: "ok",
    leaderTerm: "12",
    reason: null,
    result: { healthChecksRun: 5 },
    error: null,
    alertedRoom: null,
    ...overrides,
  }
}

// ── enum 完整性（v2b F2）──────────────────────────────────────────────

test("job-trace · status enum — 8 种 v2b F2 锁定全覆盖", () => {
  assert.equal(JOB_TRACE_STATUS_VALUES.length, 8, "status enum 必须 8 种")
  assert.deepEqual(
    [...JOB_TRACE_STATUS_VALUES].sort(),
    [
      "failed",
      "lease_lost",
      "missed_window",
      "ok",
      "recovered_from_crash",
      "skipped_not_leader",
      "skipped_reentry",
      "timeout",
    ],
  )
})

test("job-trace · reason enum — 至少 4 种 v2b F2 锁定", () => {
  assert.ok(JOB_TRACE_REASON_VALUES.length >= 4)
  for (const r of ["lease_expired", "lease_lost", "role_not_leader", "heartbeat_failed"]) {
    assert.ok(
      (JOB_TRACE_REASON_VALUES as readonly string[]).includes(r),
      `reason enum 缺 '${r}'`,
    )
  }
})

test("job-trace · 8 status fixture 各通过 validateJobTrace", () => {
  for (const status of JOB_TRACE_STATUS_VALUES) {
    const trace = makeValidTrace({ status })
    assert.doesNotThrow(() => validateJobTrace(trace), `status='${status}' 应通过`)
  }
})

test("job-trace · 4 reason fixture 各通过 validateJobTrace", () => {
  for (const reason of JOB_TRACE_REASON_VALUES) {
    const trace = makeValidTrace({ status: "skipped_not_leader", reason })
    assert.doesNotThrow(() => validateJobTrace(trace), `reason='${reason}' 应通过`)
  }
})

// ── 字段必填 / 类型校验 ─────────────────────────────────────────────────

test("job-trace · schemaVersion 错误 → throw", () => {
  const t = makeValidTrace({ schemaVersion: "0.9" })
  assert.throws(() => validateJobTrace(t), /schemaVersion must be '1.0'/)
})

test("job-trace · 缺 jobName → throw", () => {
  const t = makeValidTrace({ jobName: "" })
  assert.throws(() => validateJobTrace(t), /jobName.*non-empty/)
})

test("job-trace · 缺 runId → throw", () => {
  const t = makeValidTrace({ runId: "" })
  assert.throws(() => validateJobTrace(t), /runId.*non-empty/)
})

test("job-trace · scheduledFor 非 ISO UTC → throw（v2a F3）", () => {
  const t = makeValidTrace({ scheduledFor: "2026-05-15 04:00" })
  assert.throws(() => validateJobTrace(t), /scheduledFor.*ISO UTC/)
})

test("job-trace · windowStart 非 ISO UTC → throw（v2a F3）", () => {
  const t = makeValidTrace({ windowStart: "tomorrow" })
  assert.throws(() => validateJobTrace(t), /windowStart.*ISO UTC/)
})

test("job-trace · windowEnd 非 ISO UTC → throw（v2a F3）", () => {
  const t = makeValidTrace({ windowEnd: "" })
  assert.throws(() => validateJobTrace(t), /windowEnd.*ISO UTC/)
})

test("job-trace · 非法 status → throw + 列出 allowed", () => {
  const t = makeValidTrace({ status: "weird-status" as never })
  assert.throws(() => validateJobTrace(t), /invalid status.*allowed:/)
})

test("job-trace · 非法 reason → throw + 列出 allowed", () => {
  const t = makeValidTrace({ reason: "weird-reason" as never })
  assert.throws(() => validateJobTrace(t), /invalid reason.*allowed:/)
})

test("job-trace · durationMs 负数 → throw", () => {
  const t = makeValidTrace({ durationMs: -1 })
  assert.throws(() => validateJobTrace(t), /durationMs.*non-negative/)
})

test("job-trace · error 形状错误 → throw", () => {
  const t = makeValidTrace({
    status: "failed",
    error: { code: 42 } as unknown as JobTrace["error"],
  })
  assert.throws(() => validateJobTrace(t), /error must be/)
})

test("job-trace · startedAt/finishedAt 允许 null（skipped 场景）", () => {
  const t = makeValidTrace({
    status: "skipped_not_leader",
    reason: "role_not_leader",
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  })
  assert.doesNotThrow(() => validateJobTrace(t))
})

// ── 文件落点 + atomic write ────────────────────────────────────────────

test("job-trace · writeJobTrace 落点路径正确", () => {
  const tempDir = safeTempDir("job-trace-path-")
  try {
    const fixedTime = new Date("2026-05-15T04:00:02.123Z")
    const trace = makeValidTrace({ runId: "deterministic-run-id" })
    const result = writeJobTrace({
      rootDir: tempDir,
      trace,
      clock: () => fixedTime,
    })
    const expected = path.join(
      tempDir,
      ".runtime",
      "job-traces",
      "nightly-health-check",
      "2026-05-15",
      "040002-deterministic-run-id.json",
    )
    assert.equal(result.absolutePath, expected)
    assert.ok(fs.existsSync(expected), "trace file should exist")
  } finally {
    safeCleanup(tempDir)
  }
})

test("job-trace · atomic write — 成功后无 .tmp 残留", () => {
  const tempDir = safeTempDir("job-trace-atomic-")
  try {
    const trace = makeValidTrace()
    const result = writeJobTrace({ rootDir: tempDir, trace })
    const tmpPath = `${result.absolutePath}.tmp`
    assert.equal(fs.existsSync(tmpPath), false, ".tmp 应在 rename 后消失")
    assert.ok(fs.existsSync(result.absolutePath))
  } finally {
    safeCleanup(tempDir)
  }
})

test("job-trace · JSON 内容 roundtrip", () => {
  const tempDir = safeTempDir("job-trace-roundtrip-")
  try {
    const trace = makeValidTrace({
      status: "failed",
      error: { message: "boom", stack: "Error: boom\n    at handler" },
      alertedRoom: "R-201",
    })
    const result = writeJobTrace({ rootDir: tempDir, trace })
    const raw = fs.readFileSync(result.absolutePath, "utf-8")
    const parsed = JSON.parse(raw) as JobTrace
    assert.equal(parsed.schemaVersion, "1.0")
    assert.equal(parsed.status, "failed")
    assert.equal(parsed.error?.message, "boom")
    assert.equal(parsed.alertedRoom, "R-201")
    assert.deepEqual(parsed.scheduledFor, trace.scheduledFor)
  } finally {
    safeCleanup(tempDir)
  }
})

test("job-trace · 同 job/同日多次写产生不同文件（runId 区分）", () => {
  const tempDir = safeTempDir("job-trace-multi-")
  try {
    const t1 = makeValidTrace({ runId: "run-a" })
    const t2 = makeValidTrace({ runId: "run-b" })
    const fixedTime = new Date("2026-05-15T04:00:02.123Z")
    const r1 = writeJobTrace({ rootDir: tempDir, trace: t1, clock: () => fixedTime })
    const r2 = writeJobTrace({ rootDir: tempDir, trace: t2, clock: () => fixedTime })
    assert.notEqual(r1.absolutePath, r2.absolutePath, "两次写应产生不同文件")
    assert.ok(fs.existsSync(r1.absolutePath))
    assert.ok(fs.existsSync(r2.absolutePath))
  } finally {
    safeCleanup(tempDir)
  }
})

test("job-trace · newRunId 产生 uuid v4 格式", () => {
  const id = newRunId()
  // uuid v4: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})
