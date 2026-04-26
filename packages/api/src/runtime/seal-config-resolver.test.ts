import assert from "node:assert/strict"
import test from "node:test"
import { resolveSealThresholds, WARN_GAP_FROM_ACTION } from "./seal-config-resolver"
import { SEAL_THRESHOLDS_BY_PROVIDER } from "@multi-agent/shared"
import type { RuntimeConfig } from "./runtime-config"

// F021 Phase 6: resolveSealThresholds 三层取值
//   会话覆盖 → 全局默认 → 代码 fallback (SEAL_THRESHOLDS_BY_PROVIDER)
// 覆盖路径：返回的 warn 自动 = action - WARN_GAP_FROM_ACTION (0.05)
// fallback 路径：直接返回代码 fallback 原表（保留现状不破坏现有行为）

test("F021 P6 seal-resolver: returns code fallback when both global + session unset", () => {
  assert.deepEqual(
    resolveSealThresholds("claude", {}, {}),
    SEAL_THRESHOLDS_BY_PROVIDER.claude,
  )
  assert.deepEqual(
    resolveSealThresholds("codex", undefined, undefined),
    SEAL_THRESHOLDS_BY_PROVIDER.codex,
  )
  assert.deepEqual(
    resolveSealThresholds("gemini", undefined, {}),
    SEAL_THRESHOLDS_BY_PROVIDER.gemini,
  )
})

test("F021 P6 seal-resolver: global override sets action; warn = action - 0.05", () => {
  const global: RuntimeConfig = { claude: { sealPct: 0.7 } }
  const result = resolveSealThresholds("claude", global, {})
  assert.equal(result.action, 0.7)
  assert.ok(Math.abs(result.warn - (0.7 - WARN_GAP_FROM_ACTION)) < 1e-9, `warn=${result.warn}`)
})

test("F021 P6 seal-resolver: session override beats global", () => {
  const global: RuntimeConfig = { claude: { sealPct: 0.7 } }
  const session: RuntimeConfig = { claude: { sealPct: 0.5 } }
  const result = resolveSealThresholds("claude", global, session)
  assert.equal(result.action, 0.5)
  assert.ok(Math.abs(result.warn - 0.45) < 1e-9, `warn=${result.warn}`)
})

test("F021 P6 seal-resolver: session-only (no global) wins over fallback", () => {
  const session: RuntimeConfig = { codex: { sealPct: 0.6 } }
  const result = resolveSealThresholds("codex", {}, session)
  assert.equal(result.action, 0.6)
})

test("F021 P6 seal-resolver: warn clamped to >= 0 (action just above gap)", () => {
  const global: RuntimeConfig = { claude: { sealPct: 0.3 } }
  const result = resolveSealThresholds("claude", global, {})
  assert.equal(result.action, 0.3)
  assert.ok(Math.abs(result.warn - 0.25) < 1e-9, `warn=${result.warn}`)
})

test("F021 P6 seal-resolver: per-provider isolation — claude override does not affect codex", () => {
  const global: RuntimeConfig = { claude: { sealPct: 0.5 } }
  // codex 没设，仍走 fallback
  assert.deepEqual(
    resolveSealThresholds("codex", global, {}),
    SEAL_THRESHOLDS_BY_PROVIDER.codex,
  )
  // claude 走 override
  assert.equal(resolveSealThresholds("claude", global, {}).action, 0.5)
})

test("F021 P6 seal-resolver: contextWindow override on the same entry does NOT affect seal thresholds", () => {
  const global: RuntimeConfig = { claude: { contextWindow: 2_000_000 } }
  // sealPct 没设，仍走 fallback —— 字段独立
  assert.deepEqual(
    resolveSealThresholds("claude", global, {}),
    SEAL_THRESHOLDS_BY_PROVIDER.claude,
  )
})
