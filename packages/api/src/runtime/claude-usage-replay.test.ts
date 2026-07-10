import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import type { ParsedUsage } from "./base-runtime"
import { ClaudeRuntime } from "./claude-runtime"

// F043 AC9：真实录制事件序列驱动的口径回归（语料 = AC0 探针档案，禁手造 fixture）。
// 档案：.agents/acceptance/F043/probes/PROBE-NOTES.md（字段真相源，每个断言数值可回指）。
// 场景：haiku + 1 次 Read 工具 = 2 次 API 调用（claude CLI 2.1.206, stream-json
// + --include-partial-messages + --verbose，与生产 runtime 同参数）。

const FIXTURE = path.join(__dirname, "__fixtures__", "f043", "claude-multicall.ndjson")

function replay(runtime: ClaudeRuntime): ParsedUsage[] {
  const lines = readFileSync(FIXTURE, "utf-8").split("\n").filter(Boolean)
  const out: ParsedUsage[] = []
  for (const line of lines) {
    const parsed = runtime.parseUsage(JSON.parse(line) as Record<string, unknown>)
    if (parsed) out.push(parsed)
  }
  return out
}

test("F043 replay: context footprint tracks per-call message_start, not cumulative sum", () => {
  const usages = replay(new ClaudeRuntime())
  const contexts = usages.filter((u) => u.scope === "context")

  // 探针实测：call1 足迹 = 10+21256+7302 = 28,568；call2 = 8+28558+338 = 28,904。
  // 每次调用 message_start + message_delta 各报一次同值足迹。
  assert.deepEqual(
    contexts.map((u) => u.totalTokens),
    [28_568, 28_568, 28_904, 28_904],
  )

  // 域内 latest-wins 语义正确：末次 context 值 = 轮末真实上下文占用
  const last = contexts[contexts.length - 1]
  assert.equal(last.totalTokens, 28_904)
  assert.equal(last.exact, true)
})

test("F043 replay: result is turn_total (billing sum across calls), distinct from footprint", () => {
  const usages = replay(new ClaudeRuntime())
  const totals = usages.filter((u) => u.scope === "turn_total")

  assert.equal(totals.length, 1)
  // result.usage = 整轮精确求和：in18 + cc7640 + cr49814 + out348 = 57,820。
  // sum-check（探针实证）：足迹口径 18+7640+49814 = 57,472 = call1(28,568)+call2(28,904)。
  assert.equal(totals[0].totalTokens, 57_820)
  // 分离实证：turn_total(57,820) ≠ 末次足迹(28,904)。旧实现把前者 latest-wins 进 seal
  // 判定 → 一轮多调用直接翻倍虚高（07-10 现场 15 调用 989,369 vs 真实 77,238）。
  assert.notEqual(totals[0].totalTokens, 28_904)
})

test("F043 replay: modelWindows carries account-effective contextWindow keyed by full model name", () => {
  const usages = replay(new ClaudeRuntime())
  const total = usages.find((u) => u.scope === "turn_total")
  // key 是完整模型名（claude-haiku-4-5-20251001）——消费方必须遍历/前缀匹配，禁短名索引
  assert.deepEqual(total?.modelWindows, { "claude-haiku-4-5-20251001": 200_000 })
})

test("F043 replay: opus-4-8 account-effective window = 1M (AC3 兜底表依据)", () => {
  const lines = readFileSync(
    path.join(__dirname, "__fixtures__", "f043", "claude-opus48.ndjson"),
    "utf-8",
  )
    .split("\n")
    .filter(Boolean)
  const runtime = new ClaudeRuntime()
  let windows: Record<string, number> | undefined
  for (const line of lines) {
    const parsed = runtime.parseUsage(JSON.parse(line) as Record<string, unknown>)
    if (parsed?.modelWindows) windows = parsed.modelWindows
  }
  assert.deepEqual(windows, { "claude-opus-4-8": 1_000_000 })
})
