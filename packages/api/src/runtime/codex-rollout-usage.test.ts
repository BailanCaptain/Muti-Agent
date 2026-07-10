import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { CodexRuntime } from "./codex-runtime"

// F043 AC2：codex 真足迹只存在于 rollout 文件（~/.codex/sessions/YYYY/MM/DD/
// rollout-<ts>-<sessionId>.jsonl）的 token_count 行里 —— last_token_usage 是每请求
// 真实上下文，model_context_window 是真窗口。stream 侧 turn.completed 只有 session
// 累计值。fixture = AC0 探针 rollout 真实尾段（session_meta + 3×token_count +
// task_complete；session_meta 的 base_instructions 已裁，解析器不读该字段）。

const FIXTURE = path.join(__dirname, "__fixtures__", "f043", "codex-rollout-tail.jsonl")
const SESSION_ID = "019f4b0b-91ba-7db3-9072-cb640aab7f3e"

function makeSessionsDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "f043-codex-sessions-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function plantRollout(sessionsDir: string, dateParts: [string, string, string], sessionId: string) {
  const dayDir = path.join(sessionsDir, ...dateParts)
  mkdirSync(dayDir, { recursive: true })
  const file = path.join(dayDir, `rollout-2026-07-10T16-01-17-${sessionId}.jsonl`)
  copyFileSync(FIXTURE, file)
  return file
}

test("F043 AC2: resolveUsage tail-reads last token_count → true footprint + true window", async () => {
  const { dir, cleanup } = makeSessionsDir()
  try {
    plantRollout(dir, ["2026", "07", "10"], SESSION_ID)
    const runtime = new CodexRuntime({}, dir)
    const usage = await runtime.resolveUsage({ sessionId: SESSION_ID })
    // 探针末条 last_token_usage：input 13,384 + output 16 = total 13,400（真足迹）
    // vs 同轮 turn.completed 累计 39,727 —— 差距即封存假阳性来源
    assert.equal(usage?.scope, "context")
    assert.equal(usage?.exact, true)
    assert.equal(usage?.totalTokens, 13_400)
    assert.equal(usage?.contextWindow, 353_400)
    // P1-2（德彪 r1）：UsageDetail 统一契约 = inputTokens 只算「非缓存输入」。
    // codex 原生 input_tokens 含 cached（cached ⊆ input），adapter 归一化拆开；
    // 否则展示层按 claude 语义 input+cacheRead 求和 → 缓存双计（26,440 假高，真值 13,384）。
    assert.deepEqual(usage?.detail, {
      inputTokens: 328, // 13,384 − 13,056 = 非缓存输入
      outputTokens: 16,
      cacheReadTokens: 13_056,
      cacheCreationTokens: 0,
    })
  } finally {
    cleanup()
  }
})

test("F043 AC2: tail scan skips non-token_count lines (real rollouts end with task_complete)", async () => {
  const { dir, cleanup } = makeSessionsDir()
  try {
    plantRollout(dir, ["2026", "07", "10"], SESSION_ID)
    const runtime = new CodexRuntime({}, dir)
    const usage = await runtime.resolveUsage({ sessionId: SESSION_ID })
    // fixture 末行是 task_complete —— 若倒序扫描不跳非 token_count 行，这里会是 null
    assert.ok(usage, "task_complete 尾行必须被跳过")
  } finally {
    cleanup()
  }
})

test("F043 AC2: degraded path — rollout missing → null (stream approx snapshot survives)", async () => {
  const { dir, cleanup } = makeSessionsDir()
  try {
    const runtime = new CodexRuntime({}, dir)
    assert.equal(await runtime.resolveUsage({ sessionId: "no-such-session" }), null)
  } finally {
    cleanup()
  }
})

test("F043 AC2: null sessionId → null without touching the filesystem", async () => {
  const runtime = new CodexRuntime({}, path.join(os.tmpdir(), "f043-does-not-exist"))
  assert.equal(await runtime.resolveUsage({ sessionId: null }), null)
})

test("F043 AC2: sessions dir absent entirely → null, never throws", async () => {
  const runtime = new CodexRuntime({}, path.join(os.tmpdir(), "f043-does-not-exist"))
  assert.equal(await runtime.resolveUsage({ sessionId: SESSION_ID }), null)
})

test("F043 AC2: malformed tail lines tolerated — scan back to last valid token_count", async () => {
  const { dir, cleanup } = makeSessionsDir()
  try {
    const file = plantRollout(dir, ["2026", "07", "10"], SESSION_ID)
    // 追加损坏行（进程被杀写了半行的真实场景）
    writeFileSync(file, '{"broken json\n{"type":"event_msg","payload":{"type":"other"}}\n', {
      flag: "a",
    })
    const runtime = new CodexRuntime({}, dir)
    const usage = await runtime.resolveUsage({ sessionId: SESSION_ID })
    assert.equal(usage?.totalTokens, 13_400)
  } finally {
    cleanup()
  }
})

test("F043 AC2: rollout in a different date dir still found (cross-midnight turn)", async () => {
  const { dir, cleanup } = makeSessionsDir()
  try {
    plantRollout(dir, ["2026", "07", "09"], SESSION_ID)
    const runtime = new CodexRuntime({}, dir)
    const usage = await runtime.resolveUsage({ sessionId: SESSION_ID })
    assert.equal(usage?.totalTokens, 13_400)
  } finally {
    cleanup()
  }
})

test("F043 AC2: rollout without any token_count line → null", async () => {
  const { dir, cleanup } = makeSessionsDir()
  try {
    const dayDir = path.join(dir, "2026", "07", "10")
    mkdirSync(dayDir, { recursive: true })
    writeFileSync(
      path.join(dayDir, `rollout-2026-07-10T00-00-00-${SESSION_ID}.jsonl`),
      '{"type":"session_meta","payload":{"id":"x"}}\n',
    )
    const runtime = new CodexRuntime({}, dir)
    assert.equal(await runtime.resolveUsage({ sessionId: SESSION_ID }), null)
  } finally {
    cleanup()
  }
})
