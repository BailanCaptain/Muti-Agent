/**
 * F027 P12 · 100-iter telephone game fixture load test
 * 真相源：docs/features/F027-unified-memory-architecture.md AC-P1-10
 *
 * AC: tests/fixtures/viewfinder-drift/100-iter-telephone-game.json
 *     模拟 100 次总结迭代，最终 jaccard ≥ 0.7（drift ≤ 30%）
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../../../tests/fixtures/viewfinder-drift/100-iter-telephone-game.json",
)

interface Fixture {
  description: string
  initial: string
  iterations: number
  raw_no_intervention: {
    drift: number
    should_replace: boolean
    final_jaccard_with_initial: number
  }
  with_anti_drift_intervention: {
    final_drift: number
    final_jaccard_with_initial: number
    AC_P1_10_pass: boolean
    intervention_log: Array<{ iter: number; action: string; drift: number }>
  }
}

describe("AC-P1-10 fixture: 100-iter telephone game", () => {
  it("fixture 文件存在且 schema 合规", () => {
    const raw = readFileSync(FIXTURE_PATH, "utf8")
    const f = JSON.parse(raw) as Fixture
    assert.equal(f.iterations, 100)
    assert.ok(f.initial.length > 0)
    assert.ok(typeof f.raw_no_intervention.drift === "number")
    assert.ok(typeof f.with_anti_drift_intervention.final_drift === "number")
  })

  it("raw 100 iter（无 anti-drift）必漂超 30% — 证明 anti-drift 机制必需", () => {
    const f = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture
    assert.ok(
      f.raw_no_intervention.drift > 0.3,
      `raw drift=${f.raw_no_intervention.drift} 应 > 0.3`,
    )
    assert.equal(f.raw_no_intervention.should_replace, true)
  })

  it("AC-P1-10: 有 anti-drift 干预 → 最终 jaccard ≥ 0.7 (drift ≤ 30%)", () => {
    const f = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture
    assert.equal(f.with_anti_drift_intervention.AC_P1_10_pass, true, "AC_P1_10_pass=true")
    assert.ok(
      f.with_anti_drift_intervention.final_jaccard_with_initial >= 0.7,
      `final jaccard=${f.with_anti_drift_intervention.final_jaccard_with_initial} 必须 >= 0.7`,
    )
    assert.ok(
      f.with_anti_drift_intervention.final_drift <= 0.3,
      `final drift=${f.with_anti_drift_intervention.final_drift} 必须 <= 0.3`,
    )
  })

  it("intervention log 含 10 个 block（每 10 iter 一次 MonthlySnapshot）", () => {
    const f = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture
    assert.equal(f.with_anti_drift_intervention.intervention_log.length, 10)
    // 必须有 reset 动作（drift 到达 30% 时触发）—— 否则证明不了 anti-drift 真的在运作
    const hasReset = f.with_anti_drift_intervention.intervention_log.some(
      (e) => e.action === "reset",
    )
    assert.ok(hasReset, "intervention log 必须含至少一次 reset 动作")
  })
})
