import assert from "node:assert/strict"
import test from "node:test"
import { buildPhase1Header } from "./phase1-header"

test("buildPhase1Header returns a non-empty multi-line string for 3 participants", () => {
  const header = buildPhase1Header(3)
  assert.ok(header.includes("并行独立思考"))
  assert.ok(header.includes("Phase 1"))
  assert.ok(header.includes("3 个 agent"))
})

test("buildPhase1Header states independence rule", () => {
  const header = buildPhase1Header(2)
  assert.ok(header.includes("独立"), "should mention independent thinking")
  assert.ok(header.includes("不预测") || header.includes("互不可见"), "should state non-visibility")
})

test("buildPhase1Header states no-synthesis rule", () => {
  const header = buildPhase1Header(2)
  assert.ok(
    header.includes("不要规划后续阶段") || header.includes("不要替村长"),
    "should forbid planning later phases or playing synthesizer",
  )
})

test("buildPhase1Header mentions not loading full skill", () => {
  const header = buildPhase1Header(3)
  assert.ok(header.includes("不要加载全文"))
})

test("buildPhase1Header singular form for 1 participant still renders", () => {
  // Edge case: single-participant Mode B shouldn't happen, but helper must not crash
  const header = buildPhase1Header(1)
  assert.ok(header.includes("1 个 agent"))
})
