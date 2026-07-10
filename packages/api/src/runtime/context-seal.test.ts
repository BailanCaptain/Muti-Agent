import assert from "node:assert/strict"
import test from "node:test"
import {
  SEAL_THRESHOLDS_BY_PROVIDER,
  type TokenUsageSnapshot,
  getContextWindowForModel,
} from "@multi-agent/shared"
import { ClaudeRuntime } from "./claude-runtime"
import { computeSealDecision } from "./cli-orchestrator"
import { CodexRuntime } from "./codex-runtime"
import { GeminiRuntime } from "./gemini-runtime"

const gemini = new GeminiRuntime()
const codex = new CodexRuntime()
const claude = new ClaudeRuntime()

// ── parseUsage: Gemini ─────────────────────────────────────────────────────
// F043 AC0 实测（v0.49.0 bundle 源码分析，未活测——地区墙）：stats.total_tokens 是
// SessionMetrics 累计值非当前足迹，且 stream stats 无 context_window 输出字段。
// 因此 gemini 快照恒 exact:false，seal 判定另有 provider fail-open 硬闸（见下方
// computeSealDecision 段）。context_window 解析保留作前向兼容。

test("gemini parseUsage yields approx context scope (cumulative total_tokens, AC0 未活测)", () => {
  const usage = gemini.parseUsage({
    type: "result",
    status: "success",
    stats: { total_tokens: 100_000 },
  })
  assert.deepEqual(usage, {
    scope: "context",
    totalTokens: 100_000,
    contextWindow: null,
    exact: false,
  })
})

test("gemini parseUsage forward-compat: context_window used verbatim when CLI ever emits it", () => {
  const usage = gemini.parseUsage({
    type: "result",
    status: "success",
    stats: { total_tokens: 650_000, context_window: 1_048_576 },
  })
  assert.equal(usage?.contextWindow, 1_048_576)
  assert.equal(usage?.exact, false)
})

test("gemini parseUsage returns null for non-result events", () => {
  assert.equal(gemini.parseUsage({ type: "tool_use", tool_name: "Read" }), null)
  assert.equal(gemini.parseUsage({ type: "result", status: "error" }), null)
  assert.equal(gemini.parseUsage({ type: "result", status: "success" }), null)
})

// ── parseUsage: Codex ──────────────────────────────────────────────────────
// F043 AC0 实测（0.144.1 探针 + rollout 对账）：turn.completed.usage 就是
// total_token_usage（session 级累计），且 cached_input_tokens ⊆ input_tokens ——
// 二者相加 = 双计缓存（旧实现 9.35× 虚高实锤）。流内只能拿到这个退化估计：
// input_tokens 单值、exact:false，仍喂 seal（否则 rollout 回读失败时 codex 裸奔）。
// 真足迹走 resolveUsage rollout 回读（见 codex-rollout-usage.test.ts）。

test("codex parseUsage: input_tokens only, no cached double-count, approx context", () => {
  const usage = codex.parseUsage({
    type: "turn.completed",
    usage: { input_tokens: 39_727, cached_input_tokens: 37_120, output_tokens: 213 },
  })
  assert.deepEqual(usage, {
    scope: "context",
    totalTokens: 39_727,
    contextWindow: null,
    exact: false,
  })
})

test("codex parseUsage ignores non-turn.completed events", () => {
  assert.equal(codex.parseUsage({ type: "item.completed" }), null)
  assert.equal(codex.parseUsage({ type: "turn.completed" }), null)
  assert.equal(
    codex.parseUsage({ type: "turn.completed", usage: { output_tokens: 10 } }),
    null,
    "zero input → null (no context-fill info)",
  )
})

// ── parseUsage: Claude ─────────────────────────────────────────────────────
// F043 AC0 实测（2.1.206 探针 claude-multicall.ndjson）：message_start.usage 是该次
// API 调用的真实上下文足迹（input+cache_read+cache_creation，output 不占调用起点窗口）；
// result.usage 是整轮所有调用的累计求和（cache_read 每调用重复计），只配当计费统计。
// 旧实现三处同一口径 + result 恒最后 latest-wins → 989k/200k=100% 假封存的病根。

test("claude message_start yields context-scope footprint (in+cache_read+cache_creation)", () => {
  const usage = claude.parseUsage({
    type: "message_start",
    message: {
      model: "claude-haiku-4-5-20251001",
      usage: {
        input_tokens: 1_000,
        cache_read_input_tokens: 150_000,
        cache_creation_input_tokens: 20_000,
        output_tokens: 500,
      },
    },
  })
  assert.deepEqual(usage, {
    scope: "context",
    totalTokens: 171_000,
    contextWindow: null,
    exact: true,
    detail: {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 150_000,
      cacheCreationTokens: 20_000,
    },
  })
})

test("claude message_delta is context-scope fallback with same footprint semantics", () => {
  const usage = claude.parseUsage({
    type: "message_delta",
    usage: { input_tokens: 5_000, cache_read_input_tokens: 100_000, output_tokens: 300 },
  })
  assert.equal(usage?.scope, "context")
  assert.equal(usage?.totalTokens, 105_000, "output 不计入足迹")
  assert.equal(usage?.exact, true)
})

test("claude result yields turn_total scope (cumulative billing) + modelWindows, never context", () => {
  const usage = claude.parseUsage({
    type: "result",
    usage: {
      input_tokens: 18,
      cache_creation_input_tokens: 7_640,
      cache_read_input_tokens: 49_814,
      output_tokens: 348,
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 18,
        outputTokens: 348,
        cacheReadInputTokens: 49_814,
        cacheCreationInputTokens: 7_640,
        costUSD: 0.022,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
  })
  assert.equal(usage?.scope, "turn_total")
  assert.equal(usage?.totalTokens, 57_820, "turn_total 含 output（整轮计费口径）")
  assert.deepEqual(usage?.modelWindows, { "claude-haiku-4-5-20251001": 200_000 })
  assert.deepEqual(usage?.detail, {
    inputTokens: 18,
    outputTokens: 348,
    cacheReadTokens: 49_814,
    cacheCreationTokens: 7_640,
  })
})

test("claude result without modelUsage still parses (older CLI tolerance)", () => {
  const usage = claude.parseUsage({
    type: "result",
    usage: { input_tokens: 100, output_tokens: 50 },
  })
  assert.equal(usage?.scope, "turn_total")
  assert.equal(usage?.modelWindows, undefined)
})

test("claude parseUsage ignores assistant deltas and tool results", () => {
  assert.equal(claude.parseUsage({ type: "content_block_delta" }), null)
  assert.equal(claude.parseUsage({ type: "user" }), null)
})

// ── getContextWindowForModel ───────────────────────────────────────────────

test("getContextWindowForModel matches known model prefixes", () => {
  assert.equal(getContextWindowForModel("gemini-3.1-pro-preview"), 1_048_576)
  assert.equal(getContextWindowForModel("gemini-3-flash-preview"), 1_048_576)
  assert.equal(getContextWindowForModel("claude-opus-4-6"), 200_000)
  assert.equal(getContextWindowForModel("claude-sonnet-4-5-20250929"), 200_000)
  // F043 AC0 翻正：旧表 gpt-5.5→1M 是脑补值；Codex CLI rollout 自报 258,400（07-06 实测）
  assert.equal(getContextWindowForModel("gpt-5.5"), 258_400)
  assert.equal(getContextWindowForModel("gpt-5-codex"), 400_000)
  assert.equal(getContextWindowForModel("o3-mini"), 200_000)
})

// F043 AC0/AC3：新增映射全部来自实测（.agents/acceptance/F043/probes/PROBE-NOTES.md）。
// codex 窗口随 CLI 换代漂移（两测两值），兜底表只是 rollout 回读失败时的快照。
test("getContextWindowForModel: F043 measured additions", () => {
  // opus-4-8 账户生效窗口 = 1M（claude-opus48.ndjson modelUsage.contextWindow 实证）
  assert.equal(getContextWindowForModel("claude-opus-4-8"), 1_000_000)
  assert.equal(getContextWindowForModel("claude-opus-4-8-20260115"), 1_000_000)
  // gemini-2.5 家族此前无条目 → snapshot 永不生成（桂芬既无封存保护也无显示）
  assert.equal(getContextWindowForModel("gemini-2.5-pro"), 1_048_576)
  assert.equal(getContextWindowForModel("gemini-2.5-flash"), 1_048_576)
  // gpt-5.6-sol = 07-10 rollout model_context_window 自报 353,400
  assert.equal(getContextWindowForModel("gpt-5.6-sol"), 353_400)
})

test("getContextWindowForModel returns null for unknown models", () => {
  assert.equal(getContextWindowForModel("custom-model-xyz"), null)
  assert.equal(getContextWindowForModel(null), null)
  assert.equal(getContextWindowForModel(""), null)
})

// B016: Claude Opus 4.7 default context window is 1M (no [1m] suffix required).
// Without this mapping, fillRatio is computed against 200K and seal fires ~5× early.
test("getContextWindowForModel: Claude Opus 4.7 default maps to 1M", () => {
  // Opus 4.7 默认 1M，不需要 [1m] 后缀
  assert.equal(getContextWindowForModel("claude-opus-4-7"), 1_000_000)
  assert.equal(getContextWindowForModel("claude-opus-4-7[1m]"), 1_000_000)
  assert.equal(getContextWindowForModel("CLAUDE-OPUS-4-7"), 1_000_000)
  // 其他 Claude 4.x 维持 200K 不变
  assert.equal(getContextWindowForModel("claude-opus-4-6"), 200_000)
  assert.equal(getContextWindowForModel("claude-sonnet-4-6"), 200_000)
  assert.equal(getContextWindowForModel("claude-haiku-4-5-20251001"), 200_000)
})

// ── computeSealDecision ────────────────────────────────────────────────────

const snapshot = (used: number, window: number): TokenUsageSnapshot => ({
  usedTokens: used,
  windowTokens: window,
  source: "exact",
})

test("computeSealDecision returns null when usage is absent", () => {
  assert.equal(computeSealDecision("gemini", null), null)
})

test("F043 AC3: gemini action threshold downgrades to warn — fail-open, never auto-seals", () => {
  const { action } = SEAL_THRESHOLDS_BY_PROVIDER.gemini
  // 850k / 1M = 0.85 > 0.80 action 阈值。gemini usedTokens 仍是 CLI 累计口径（未修净）
  // 且地区墙无活测 → approx 数据不触发硬动作（对标 clowder F062）。解封条件 = 活测口径。
  const decision = computeSealDecision("gemini", snapshot(850_000, 1_000_000))
  assert.equal(decision?.shouldSeal, false)
  assert.equal(decision?.reason, "warn")
  assert.ok((decision?.fillRatio ?? 0) >= action, "fillRatio 照实上报，只是不封")
})

test("F043 AC3: gemini fail-open holds even with user-resolved custom thresholds", () => {
  // 数据质量问题与阈值来源无关：自定义阈值也不该让累计口径触发封存
  const decision = computeSealDecision("gemini", snapshot(600_000, 1_000_000), {
    warn: 0.4,
    action: 0.5,
  })
  assert.equal(decision?.shouldSeal, false)
  assert.equal(decision?.reason, "warn")
})

test("computeSealDecision: gemini warns between warn/action (F004: 70-80%)", () => {
  // 750k / 1M = 0.75, between warn=0.70 and action=0.80
  const decision = computeSealDecision("gemini", snapshot(750_000, 1_000_000))
  assert.equal(decision?.shouldSeal, false)
  assert.equal(decision?.reason, "warn")
})

test("computeSealDecision: gemini stays silent below warn threshold (F004: <70%)", () => {
  // 600k / 1M = 0.6, below warn=0.70
  const decision = computeSealDecision("gemini", snapshot(600_000, 1_000_000))
  assert.equal(decision?.shouldSeal, false)
  assert.equal(decision?.reason, null)
})

test("computeSealDecision: claude uses 80/90 thresholds (more lenient than gemini)", () => {
  // 140k / 200k = 0.7 → claude stays silent (below 0.8), but gemini would seal
  const claudeDecision = computeSealDecision("claude", snapshot(140_000, 200_000))
  assert.equal(claudeDecision?.reason, null)
  assert.equal(claudeDecision?.shouldSeal, false)

  // 185k / 200k = 0.925 → claude seals
  const sealDecision = computeSealDecision("claude", snapshot(185_000, 200_000))
  assert.equal(sealDecision?.shouldSeal, true)
})

test("computeSealDecision: codex uses 75/85 thresholds", () => {
  // 80k / 100k = 0.80, between warn=0.75 and action=0.85
  const decision = computeSealDecision("codex", snapshot(80_000, 100_000))
  assert.equal(decision?.shouldSeal, false)
  assert.equal(decision?.reason, "warn")

  // 90k / 100k = 0.90 → seal
  const sealDecision = computeSealDecision("codex", snapshot(90_000, 100_000))
  assert.equal(sealDecision?.shouldSeal, true)
})

test("computeSealDecision: fillRatio is clamped at 1.0 even when used exceeds window", () => {
  // Over-budget reporting shouldn't blow up — just clamp and seal.
  // F043: provider 换 claude（gemini 已 fail-open 不再走 seal 路径）
  const decision = computeSealDecision("claude", snapshot(400_000, 200_000))
  assert.equal(decision?.fillRatio, 1.0)
  assert.equal(decision?.shouldSeal, true)
})

// ── F021 Phase 6: computeSealDecision 接受 user-resolved thresholds ──────────

test("F021 P6 computeSealDecision: custom thresholds (action=0.5) seals at 50% fillRatio", () => {
  // 用户在齿轮里把 claude action 阈值调到 50%，warn 自动 = 45%
  // 110k / 200k = 0.55 > 0.5 → 提早 seal
  const decision = computeSealDecision("claude", snapshot(110_000, 200_000), {
    warn: 0.45,
    action: 0.5,
  })
  assert.equal(decision?.shouldSeal, true)
  assert.equal(decision?.reason, "threshold")
})

test("F021 P6 computeSealDecision: custom thresholds — warn 区间", () => {
  // action=0.5, warn=0.45；fillRatio=0.47 → warn (不 seal 但提示)
  const decision = computeSealDecision("claude", snapshot(94_000, 200_000), {
    warn: 0.45,
    action: 0.5,
  })
  assert.equal(decision?.shouldSeal, false)
  assert.equal(decision?.reason, "warn")
})

test("F021 P6 computeSealDecision: custom thresholds — below warn 静默", () => {
  // action=0.5, warn=0.45；fillRatio=0.4 → null
  const decision = computeSealDecision("claude", snapshot(80_000, 200_000), {
    warn: 0.45,
    action: 0.5,
  })
  assert.equal(decision?.shouldSeal, false)
  assert.equal(decision?.reason, null)
})

test("F021 P6 computeSealDecision: thresholds undefined keeps fallback to SEAL_THRESHOLDS_BY_PROVIDER", () => {
  // 不传 thresholds，行为完全等同二参版本（向后兼容）
  const decision = computeSealDecision("claude", snapshot(180_000, 200_000))
  // claude action=0.9, fillRatio=0.9 → seal
  assert.equal(decision?.shouldSeal, true)
  assert.equal(decision?.reason, "threshold")
})
