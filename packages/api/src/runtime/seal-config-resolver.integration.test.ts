import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SEAL_THRESHOLDS_BY_PROVIDER, getContextWindowForModel } from "@multi-agent/shared"
import {
  type RuntimeConfig,
  loadRuntimeConfig,
  saveRuntimeConfig,
} from "./runtime-config"
import { resolveSealThresholds, WARN_GAP_FROM_ACTION } from "./seal-config-resolver"
import { resolveContextWindow } from "./context-window-resolver"

// F021 Phase 6 — AC-28 Fallback 链路集成测试
//
// 覆盖矩阵：6 场景 × 2 字段 (sealPct + contextWindow)，串联完整链路
//   saveRuntimeConfig (global JSON 文件 round-trip)
//   → 模拟 session_groups.runtime_config 整段 JSON round-trip
//   → resolveSealThresholds / resolveContextWindow
//
// 与单测 (seal-config-resolver.test.ts / context-window-resolver.test.ts) 区别：
//   单测：纯函数对象级断言
//   集成：文件 round-trip + sanitize 链路验证 user 增删改场景的真实落地

function freshGlobalPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "f021-p6-int-"))
  const file = path.join(dir, "multi-agent.runtime-config.json")
  return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// 模拟 session_groups.runtime_config 字段 round-trip（Drizzle TEXT 列存 JSON 整段）
function sessionRoundTrip(input: RuntimeConfig | undefined): RuntimeConfig | undefined {
  if (input === undefined) return undefined
  return JSON.parse(JSON.stringify(input)) as RuntimeConfig
}

// 模拟用户在前端调用 "PUT /api/runtime-config" 后落地到磁盘 + 重新 load
function setGlobal(filePath: string, config: RuntimeConfig | undefined): RuntimeConfig {
  if (config === undefined) {
    saveRuntimeConfig({}, filePath)
  } else {
    saveRuntimeConfig(config, filePath)
  }
  return loadRuntimeConfig(filePath)
}

const MODEL = "claude-opus-4-7"
const PROVIDER = "claude"
const FALLBACK_SEAL = SEAL_THRESHOLDS_BY_PROVIDER[PROVIDER]
const FALLBACK_WINDOW = getContextWindowForModel(MODEL) // 1_000_000

test("AC-28 matrix [seal] case 1: both unset → fallback", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, undefined)
    const session = sessionRoundTrip(undefined)
    assert.deepEqual(resolveSealThresholds(PROVIDER, global, session), FALLBACK_SEAL)
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [seal] case 2: global only → global wins", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, { claude: { sealPct: 0.7 } })
    const session = sessionRoundTrip(undefined)
    const r = resolveSealThresholds(PROVIDER, global, session)
    assert.equal(r.action, 0.7)
    assert.ok(Math.abs(r.warn - (0.7 - WARN_GAP_FROM_ACTION)) < 1e-9)
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [seal] case 3: both set → session wins", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, { claude: { sealPct: 0.7 } })
    const session = sessionRoundTrip({ claude: { sealPct: 0.5 } })
    const r = resolveSealThresholds(PROVIDER, global, session)
    assert.equal(r.action, 0.5)
    assert.ok(Math.abs(r.warn - 0.45) < 1e-9)
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [seal] case 4: delete global, keep session → session value", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    setGlobal(gp, { claude: { sealPct: 0.7 } })
    const global = setGlobal(gp, undefined) // 用户删了全局
    const session = sessionRoundTrip({ claude: { sealPct: 0.5 } })
    const r = resolveSealThresholds(PROVIDER, global, session)
    assert.equal(r.action, 0.5)
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [seal] case 5: delete session, keep global → global value", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, { claude: { sealPct: 0.7 } })
    // 用户清掉 session.runtime_config 整段
    const session = sessionRoundTrip({})
    const r = resolveSealThresholds(PROVIDER, global, session)
    assert.equal(r.action, 0.7)
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [seal] case 6: delete both → fallback restored", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    setGlobal(gp, { claude: { sealPct: 0.5 } })
    const global = setGlobal(gp, undefined)
    const session = sessionRoundTrip({})
    assert.deepEqual(resolveSealThresholds(PROVIDER, global, session), FALLBACK_SEAL)
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [window] case 1: both unset → CLI/fallback chain", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, undefined)
    const session = sessionRoundTrip(undefined)
    // 无 CLI 报告 → 走 model fallback
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, undefined, MODEL),
      FALLBACK_WINDOW,
    )
    // 有 CLI 报告 → CLI 赢 fallback
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, 800_000, MODEL),
      800_000,
    )
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [window] case 2: global only → global beats CLI + fallback", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, { claude: { contextWindow: 2_000_000 } })
    const session = sessionRoundTrip(undefined)
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, 800_000, MODEL),
      2_000_000,
    )
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [window] case 3: both set → session wins", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, { claude: { contextWindow: 2_000_000 } })
    const session = sessionRoundTrip({ claude: { contextWindow: 3_000_000 } })
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, 800_000, MODEL),
      3_000_000,
    )
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [window] case 4: delete global, keep session → session value", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    setGlobal(gp, { claude: { contextWindow: 2_000_000 } })
    const global = setGlobal(gp, undefined)
    const session = sessionRoundTrip({ claude: { contextWindow: 3_000_000 } })
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, undefined, MODEL),
      3_000_000,
    )
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [window] case 5: delete session, keep global → global value", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, { claude: { contextWindow: 2_000_000 } })
    const session = sessionRoundTrip({})
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, undefined, MODEL),
      2_000_000,
    )
  } finally {
    cleanup()
  }
})

test("AC-28 matrix [window] case 6: delete both → CLI/fallback restored", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    setGlobal(gp, { claude: { contextWindow: 2_000_000 } })
    const global = setGlobal(gp, undefined)
    const session = sessionRoundTrip({})
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, undefined, MODEL),
      FALLBACK_WINDOW,
    )
  } finally {
    cleanup()
  }
})

test("AC-28 cross-field independence: setting only sealPct does not change window resolution", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, { claude: { sealPct: 0.5 } })
    const session = sessionRoundTrip(undefined)
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, undefined, MODEL),
      FALLBACK_WINDOW,
    )
    assert.equal(resolveSealThresholds(PROVIDER, global, session).action, 0.5)
  } finally {
    cleanup()
  }
})

test("AC-28 cross-field independence: setting only contextWindow does not change seal thresholds", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, { claude: { contextWindow: 2_000_000 } })
    const session = sessionRoundTrip(undefined)
    assert.deepEqual(resolveSealThresholds(PROVIDER, global, session), FALLBACK_SEAL)
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, undefined, MODEL),
      2_000_000,
    )
  } finally {
    cleanup()
  }
})

test("AC-28 round-trip preserves both fields together on disk", () => {
  const { path: gp, cleanup } = freshGlobalPath()
  try {
    const global = setGlobal(gp, {
      claude: { contextWindow: 1_500_000, sealPct: 0.65, model: "claude-opus-4-7" },
    })
    const session = sessionRoundTrip({ claude: { sealPct: 0.45 } })
    // session 只覆盖 sealPct，contextWindow 仍取全局
    assert.equal(
      resolveContextWindow(PROVIDER, global, session, undefined, MODEL),
      1_500_000,
    )
    assert.equal(resolveSealThresholds(PROVIDER, global, session).action, 0.45)
  } finally {
    cleanup()
  }
})
