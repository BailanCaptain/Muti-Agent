import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { loadRuntimeConfig, resolveEffectiveOverride, saveRuntimeConfig } from "./runtime-config"

function tmpConfigPath() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ma-runtime-config-"))
  return { configPath: path.join(dir, "cfg.json"), dir }
}

test("loadRuntimeConfig returns empty object when file missing", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    assert.deepEqual(loadRuntimeConfig(configPath), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("saveRuntimeConfig → loadRuntimeConfig round-trips three agents", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    saveRuntimeConfig(
      {
        claude: { model: "claude-opus-4-6", effort: "high" },
        codex: { model: "gpt-5.4", effort: "medium" },
        gemini: { model: "gemini-3.1-pro-preview" },
      },
      configPath,
    )
    const loaded = loadRuntimeConfig(configPath)
    assert.deepEqual(loaded, {
      claude: { model: "claude-opus-4-6", effort: "high" },
      codex: { model: "gpt-5.4", effort: "medium" },
      gemini: { model: "gemini-3.1-pro-preview" },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadRuntimeConfig tolerates corrupt JSON and returns empty", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    writeFileSync(configPath, "{not valid json", "utf8")
    assert.deepEqual(loadRuntimeConfig(configPath), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("sanitize drops empty strings, unknown agents, and non-object entries", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        claude: { model: "", effort: "  " },
        codex: { model: "gpt-5", effort: "" },
        gemini: "not-an-object",
        bogus: { model: "ignored" },
      }),
      "utf8",
    )
    const loaded = loadRuntimeConfig(configPath)
    assert.deepEqual(loaded, { codex: { model: "gpt-5" } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F021 P1: resolveEffectiveOverride merges session over global at field granularity", () => {
  // session only has effort, global only has model → merge, don't pick object
  assert.deepEqual(resolveEffectiveOverride({ effort: "high" }, { model: "claude-sonnet-4-6" }), {
    model: "claude-sonnet-4-6",
    effort: "high",
  })
})

test("F021 P1: resolveEffectiveOverride session field wins when both set", () => {
  assert.deepEqual(
    resolveEffectiveOverride(
      { model: "claude-opus-4-7" },
      { model: "claude-sonnet-4-6", effort: "medium" },
    ),
    { model: "claude-opus-4-7", effort: "medium" },
  )
})

test("F021 P1: resolveEffectiveOverride returns undefined when neither set", () => {
  assert.equal(resolveEffectiveOverride(undefined, undefined), undefined)
  assert.equal(resolveEffectiveOverride({}, {}), undefined)
  assert.equal(resolveEffectiveOverride({}, undefined), undefined)
})

test("F036 P0#2: resolveEffectiveOverride drops bogus effort when agent passed (注入前白名单)", () => {
  // session effort 越界 + 传 agent → effort 丢弃（回落 CLI 默认），防 bogus 注入崩子进程；model 留
  assert.deepEqual(
    resolveEffectiveOverride({ effort: "bogus" }, { model: "claude-opus-4-7" }, "claude"),
    { model: "claude-opus-4-7" },
  )
  // claude 不含 minimal（codex 专属）→ 丢，无 model → undefined
  assert.equal(resolveEffectiveOverride({ effort: "minimal" }, undefined, "claude"), undefined)
  // gemini efforts=[] → 任何 effort 丢
  assert.equal(resolveEffectiveOverride({ effort: "high" }, undefined, "gemini"), undefined)
})

test("F036 P0#2: resolveEffectiveOverride keeps valid effort per agent catalog", () => {
  // claude 含 xhigh（F036 实测 CLI 2.1.177 补 catalog）
  assert.deepEqual(resolveEffectiveOverride({ effort: "xhigh" }, undefined, "claude"), {
    effort: "xhigh",
  })
  // codex 含 minimal
  assert.deepEqual(resolveEffectiveOverride({ effort: "minimal" }, undefined, "codex"), {
    effort: "minimal",
  })
})

test("F036 P0#2: resolveEffectiveOverride without agent keeps effort (向后兼容)", () => {
  // 不传 agent → 不校验（历史行为），effort 原样保留
  assert.deepEqual(resolveEffectiveOverride({ effort: "bogus" }, undefined), { effort: "bogus" })
})

test("F036 P0#2: saveRuntimeConfig drops bogus agent effort, keeps valid (catalog 白名单)", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    saveRuntimeConfig(
      { claude: { model: "claude-opus-4-7", effort: "bogus" }, codex: { effort: "xhigh" } },
      configPath,
    )
    const loaded = loadRuntimeConfig(configPath)
    // claude.effort=bogus 丢（model 留）；codex.effort=xhigh 留
    assert.deepEqual(loaded, {
      claude: { model: "claude-opus-4-7" },
      codex: { effort: "xhigh" },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("saveRuntimeConfig trims whitespace on write", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    saveRuntimeConfig({ claude: { model: "  claude-opus-4-6  ", effort: "high" } }, configPath)
    const loaded = loadRuntimeConfig(configPath)
    assert.deepEqual(loaded, { claude: { model: "claude-opus-4-6", effort: "high" } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// F021 Phase 6: AgentOverride 扩 contextWindow + sealPct
//   contextWindow: 整数 > 0
//   sealPct: 0.3 ≤ x ≤ 1.0（warn 自动 = action - 0.05，UI 只暴露 action）

test("F021 P6: sanitize accepts contextWindow as positive integer", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    writeFileSync(configPath, JSON.stringify({ claude: { contextWindow: 1_000_000 } }), "utf8")
    assert.deepEqual(loadRuntimeConfig(configPath), { claude: { contextWindow: 1_000_000 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F021 P6: sanitize floors fractional contextWindow", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    writeFileSync(configPath, JSON.stringify({ codex: { contextWindow: 999_999.7 } }), "utf8")
    assert.deepEqual(loadRuntimeConfig(configPath), { codex: { contextWindow: 999_999 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F021 P6: sanitize rejects contextWindow <= 0 and non-finite", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        claude: { contextWindow: 0 },
        codex: { contextWindow: -1 },
        gemini: { contextWindow: "1000000" },
      }),
      "utf8",
    )
    assert.deepEqual(loadRuntimeConfig(configPath), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F021 P6: sanitize accepts sealPct in [0.3, 1.0]", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        claude: { sealPct: 0.3 },
        codex: { sealPct: 0.65 },
        gemini: { sealPct: 1.0 },
      }),
      "utf8",
    )
    assert.deepEqual(loadRuntimeConfig(configPath), {
      claude: { sealPct: 0.3 },
      codex: { sealPct: 0.65 },
      gemini: { sealPct: 1.0 },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F021 P6: sanitize rejects sealPct out of [0.3, 1.0]", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        claude: { sealPct: 0.29 },
        codex: { sealPct: 1.01 },
        gemini: { sealPct: "0.5" },
      }),
      "utf8",
    )
    assert.deepEqual(loadRuntimeConfig(configPath), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F021 P6: sanitize preserves sibling fields when only one P6 field set", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    saveRuntimeConfig(
      {
        claude: { model: "claude-opus-4-7", contextWindow: 2_000_000 },
        codex: { effort: "high", sealPct: 0.5 },
      },
      configPath,
    )
    assert.deepEqual(loadRuntimeConfig(configPath), {
      claude: { model: "claude-opus-4-7", contextWindow: 2_000_000 },
      codex: { effort: "high", sealPct: 0.5 },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("F021 P6: sanitize keeps entry when only contextWindow or sealPct present (no model/effort)", () => {
  const { configPath, dir } = tmpConfigPath()
  try {
    writeFileSync(
      configPath,
      JSON.stringify({ claude: { contextWindow: 500_000 }, codex: { sealPct: 0.7 } }),
      "utf8",
    )
    assert.deepEqual(loadRuntimeConfig(configPath), {
      claude: { contextWindow: 500_000 },
      codex: { sealPct: 0.7 },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
