import assert from "node:assert/strict"
import test from "node:test"
import { resolveContextWindow } from "./context-window-resolver"
import type { RuntimeConfig } from "./runtime-config"

// F021 Phase 6: resolveContextWindow 三层取值
//   会话覆盖 → 全局覆盖 → CLI 报告 → 代码 fallback (getContextWindowForModel)
// CLI 报告 = turn.completed 等事件里 contextWindowSize 字段；
// 我们让 user override 比 CLI 报告还优先，因为 user override 是明确的"模型升级了"意图，
// CLI 报告可能基于过时映射。

test("F021 P6 window-resolver: returns null when nothing set and unknown model", () => {
  assert.equal(
    resolveContextWindow(
      "claude",
      undefined,
      undefined,
      undefined, // cliReportedWindow
      "unknown-model-xyz",
    ),
    null,
  )
})

test("F021 P6 window-resolver: code fallback by model when no overrides + no cli report", () => {
  assert.equal(
    resolveContextWindow("claude", undefined, undefined, undefined, "claude-opus-4-7"),
    1_000_000,
  )
})

test("F021 P6 window-resolver: cli reported wins over fallback when no user override", () => {
  // 模型 prefix 表给 200k，但 CLI 实测报告 500k → 用 CLI
  assert.equal(
    resolveContextWindow("claude", undefined, undefined, 500_000, "claude-sonnet-4-6"),
    500_000,
  )
})

test("F021 P6 window-resolver: global override wins over cli report and fallback", () => {
  const global: RuntimeConfig = { claude: { contextWindow: 2_000_000 } }
  assert.equal(
    resolveContextWindow("claude", global, undefined, 500_000, "claude-sonnet-4-6"),
    2_000_000,
  )
})

test("F021 P6 window-resolver: session override beats global", () => {
  const global: RuntimeConfig = { claude: { contextWindow: 2_000_000 } }
  const session: RuntimeConfig = { claude: { contextWindow: 3_000_000 } }
  assert.equal(
    resolveContextWindow("claude", global, session, 500_000, "claude-opus-4-7"),
    3_000_000,
  )
})

test("F021 P6 window-resolver: per-provider isolation — claude override does not affect codex", () => {
  const global: RuntimeConfig = { claude: { contextWindow: 2_000_000 } }
  // codex 没设 → 走 cli or fallback
  assert.equal(resolveContextWindow("codex", global, undefined, undefined, "gpt-5"), 400_000)
  assert.equal(
    resolveContextWindow("codex", global, undefined, 800_000, "gpt-5"),
    800_000,
  )
})

test("F021 P6 window-resolver: sealPct override on same entry does NOT pollute window resolution", () => {
  // 用户只设了 sealPct（contextWindow 没设）→ window 仍走 cli/fallback
  const global: RuntimeConfig = { claude: { sealPct: 0.5 } }
  assert.equal(
    resolveContextWindow("claude", global, undefined, undefined, "claude-opus-4-7"),
    1_000_000,
  )
})
