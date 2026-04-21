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
  assert.deepEqual(
    resolveEffectiveOverride({ effort: "high" }, { model: "claude-sonnet-4-6" }),
    { model: "claude-sonnet-4-6", effort: "high" },
  )
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
