import assert from "node:assert/strict";
import test from "node:test";
import { GeminiRuntime } from "./gemini-runtime";
import { CodexRuntime } from "./codex-runtime";
import { ClaudeRuntime } from "./claude-runtime";
import { computeSealDecision } from "./cli-orchestrator";
import {
  SEAL_THRESHOLDS_BY_PROVIDER,
  getContextWindowForModel,
  type TokenUsageSnapshot
} from "@multi-agent/shared";

const gemini = new GeminiRuntime();
const codex = new CodexRuntime();
const claude = new ClaudeRuntime();

// ── parseUsage: Gemini ─────────────────────────────────────────────────────

test("gemini parseUsage extracts totalTokens + contextWindow from result.success", () => {
  const usage = gemini.parseUsage({
    type: "result",
    status: "success",
    stats: {
      total_tokens: 650_000,
      input_tokens: 600_000,
      output_tokens: 50_000,
      context_window: 1_048_576
    }
  });
  assert.deepEqual(usage, { totalTokens: 650_000, contextWindow: 1_048_576 });
});

test("gemini parseUsage returns null for non-result events", () => {
  assert.equal(gemini.parseUsage({ type: "tool_use", tool_name: "Read" }), null);
  assert.equal(gemini.parseUsage({ type: "result", status: "error" }), null);
  assert.equal(gemini.parseUsage({ type: "result", status: "success" }), null);
});

test("gemini parseUsage falls back to null contextWindow when CLI omits it", () => {
  const usage = gemini.parseUsage({
    type: "result",
    status: "success",
    stats: { total_tokens: 100_000 }
  });
  assert.deepEqual(usage, { totalTokens: 100_000, contextWindow: null });
});

// ── parseUsage: Codex ──────────────────────────────────────────────────────

test("codex parseUsage sums input + cached from turn.completed", () => {
  const usage = codex.parseUsage({
    type: "turn.completed",
    usage: { input_tokens: 120_000, cached_input_tokens: 30_000, output_tokens: 8_000 }
  });
  assert.deepEqual(usage, { totalTokens: 150_000, contextWindow: null });
});

test("codex parseUsage ignores non-turn.completed events", () => {
  assert.equal(codex.parseUsage({ type: "item.completed" }), null);
  assert.equal(codex.parseUsage({ type: "turn.completed" }), null);
  assert.equal(
    codex.parseUsage({ type: "turn.completed", usage: { output_tokens: 10 } }),
    null,
    "zero input+cached → null (no context-fill info)"
  );
});

// ── parseUsage: Claude ─────────────────────────────────────────────────────

test("claude parseUsage sums input + cache_read + cache_creation from message_start", () => {
  const usage = claude.parseUsage({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 1_000,
        cache_read_input_tokens: 150_000,
        cache_creation_input_tokens: 20_000,
        output_tokens: 0
      }
    }
  });
  assert.deepEqual(usage, { totalTokens: 171_000, contextWindow: null });
});

test("claude parseUsage reads usage from message_delta too", () => {
  const usage = claude.parseUsage({
    type: "message_delta",
    usage: { input_tokens: 5_000, cache_read_input_tokens: 100_000 }
  });
  assert.deepEqual(usage, { totalTokens: 105_000, contextWindow: null });
});

test("claude parseUsage ignores assistant deltas and tool results", () => {
  assert.equal(claude.parseUsage({ type: "content_block_delta" }), null);
  assert.equal(claude.parseUsage({ type: "user" }), null);
});

// ── getContextWindowForModel ───────────────────────────────────────────────

test("getContextWindowForModel matches known model prefixes", () => {
  assert.equal(getContextWindowForModel("gemini-3.1-pro"), 1_048_576);
  assert.equal(getContextWindowForModel("gemini-3-flash"), 1_048_576);
  assert.equal(getContextWindowForModel("claude-opus-4-6"), 200_000);
  assert.equal(getContextWindowForModel("claude-sonnet-4-5-20250929"), 200_000);
  assert.equal(getContextWindowForModel("gpt-5-codex"), 400_000);
  assert.equal(getContextWindowForModel("o3-mini"), 200_000);
});

test("getContextWindowForModel returns null for unknown models", () => {
  assert.equal(getContextWindowForModel("custom-model-xyz"), null);
  assert.equal(getContextWindowForModel(null), null);
  assert.equal(getContextWindowForModel(""), null);
});

// ── computeSealDecision ────────────────────────────────────────────────────

const snapshot = (used: number, window: number): TokenUsageSnapshot => ({
  usedTokens: used,
  windowTokens: window,
  source: "exact"
});

test("computeSealDecision returns null when usage is absent", () => {
  assert.equal(computeSealDecision("gemini", null), null);
});

test("computeSealDecision: gemini seals at 65%", () => {
  const { action } = SEAL_THRESHOLDS_BY_PROVIDER.gemini;
  // 700k / 1M = 0.7 > 0.65 action threshold → seal
  const decision = computeSealDecision("gemini", snapshot(700_000, 1_000_000));
  assert.equal(decision?.shouldSeal, true);
  assert.equal(decision?.reason, "threshold");
  assert.ok((decision?.fillRatio ?? 0) >= action);
});

test("computeSealDecision: gemini warns at 55-65%", () => {
  // 600k / 1M = 0.6, between warn=0.55 and action=0.65
  const decision = computeSealDecision("gemini", snapshot(600_000, 1_000_000));
  assert.equal(decision?.shouldSeal, false);
  assert.equal(decision?.reason, "warn");
});

test("computeSealDecision: gemini stays silent below warn threshold", () => {
  // 400k / 1M = 0.4, below warn=0.55
  const decision = computeSealDecision("gemini", snapshot(400_000, 1_000_000));
  assert.equal(decision?.shouldSeal, false);
  assert.equal(decision?.reason, null);
});

test("computeSealDecision: claude uses 80/90 thresholds (more lenient than gemini)", () => {
  // 140k / 200k = 0.7 → claude stays silent (below 0.8), but gemini would seal
  const claudeDecision = computeSealDecision("claude", snapshot(140_000, 200_000));
  assert.equal(claudeDecision?.reason, null);
  assert.equal(claudeDecision?.shouldSeal, false);

  // 185k / 200k = 0.925 → claude seals
  const sealDecision = computeSealDecision("claude", snapshot(185_000, 200_000));
  assert.equal(sealDecision?.shouldSeal, true);
});

test("computeSealDecision: codex uses 75/85 thresholds", () => {
  // 80k / 100k = 0.80, between warn=0.75 and action=0.85
  const decision = computeSealDecision("codex", snapshot(80_000, 100_000));
  assert.equal(decision?.shouldSeal, false);
  assert.equal(decision?.reason, "warn");

  // 90k / 100k = 0.90 → seal
  const sealDecision = computeSealDecision("codex", snapshot(90_000, 100_000));
  assert.equal(sealDecision?.shouldSeal, true);
});

test("computeSealDecision: fillRatio is clamped at 1.0 even when used exceeds window", () => {
  // Over-budget reporting shouldn't blow up — just clamp and seal.
  const decision = computeSealDecision("gemini", snapshot(2_000_000, 1_000_000));
  assert.equal(decision?.fillRatio, 1.0);
  assert.equal(decision?.shouldSeal, true);
});
