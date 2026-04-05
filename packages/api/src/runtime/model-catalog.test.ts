import assert from "node:assert/strict"
import test from "node:test"
import { MODEL_CATALOG } from "./model-catalog"

test("catalog contains all three agents with non-empty models", () => {
  for (const agent of ["claude", "codex", "gemini"] as const) {
    const entry = MODEL_CATALOG[agent]
    assert.ok(entry, `${agent} entry must exist`)
    assert.ok(entry.models.length > 0, `${agent} must have at least one model`)
    for (const m of entry.models) {
      assert.ok(m.name.trim(), `${agent} model name must be non-empty`)
      assert.ok(m.label.trim(), `${agent} model label must be non-empty`)
    }
  }
})

test("claude efforts match CLI --help (low/medium/high/max)", () => {
  assert.deepEqual(MODEL_CATALOG.claude.efforts, ["low", "medium", "high", "max"])
})

test("codex efforts match CLI error variant list (none/minimal/low/medium/high/xhigh)", () => {
  assert.deepEqual(MODEL_CATALOG.codex.efforts, [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ])
})

test("gemini has empty efforts (CLI does not support effort flag)", () => {
  assert.deepEqual(MODEL_CATALOG.gemini.efforts, [])
})
