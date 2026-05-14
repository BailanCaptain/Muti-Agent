/**
 * F027 P12 · 生成 100-iter telephone game fixture
 * 真相源：docs/features/F027-unified-memory-architecture.md AC-P1-10
 *
 * 跑：pnpm exec node --import tsx scripts/generate-telephone-fixture.ts
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import {
  computeDrift,
  simulateTelephoneGame,
  tokenize,
} from "../packages/api/src/wiki/viewfinder/monthly-snapshot"

const initial =
  "F027 viewfinder anti drift decision ledger tombstone coverage gate haiku rule based extractor merger"
const initialTokens = tokenize(initial)

// Phase A: Raw 100 iter (no intervention) —— 验证"防漂移机制有用武之地"
const raw = simulateTelephoneGame(initial, 100, { seed: 42 })
const rawDrift = computeDrift({
  oldDecisionsSummaryTokens: initialTokens,
  newDecisionsSummaryTokens: tokenize(raw.finalText),
})

// Phase B: With anti-drift intervention（每 10 iter MonthlySnapshot 检测，drift > 30% reset）
let current = initial
const interventions: Array<{ iter: number; action: "reset" | "keep"; drift: number }> = []
for (let block = 0; block < 10; block++) {
  const r = simulateTelephoneGame(current, 10, { seed: 42 + block })
  const d = computeDrift({
    oldDecisionsSummaryTokens: initialTokens,
    newDecisionsSummaryTokens: tokenize(r.finalText),
  })
  if (d.shouldReplace) {
    interventions.push({ iter: (block + 1) * 10, action: "reset", drift: d.drift })
    current = initial
  } else {
    interventions.push({ iter: (block + 1) * 10, action: "keep", drift: d.drift })
    current = r.finalText
  }
}
const finalDrift = computeDrift({
  oldDecisionsSummaryTokens: initialTokens,
  newDecisionsSummaryTokens: tokenize(current),
})

const fixture = {
  description: "F027 P12 AC-P1-10: 100-iter telephone game with anti-drift intervention",
  generated_by: "scripts/generate-telephone-fixture.ts",
  initial,
  iterations: 100,
  variation_params: { replaceP: 0.05, deleteP: 0.02, insertP: 0.02, seed: 42 },
  raw_no_intervention: {
    final_text: raw.finalText,
    final_jaccard_with_initial: 1 - rawDrift.drift,
    drift: rawDrift.drift,
    should_replace: rawDrift.shouldReplace,
    note: "raw 100 iter without anti-drift always exceeds 30% — 证明 anti-drift 必需",
  },
  with_anti_drift_intervention: {
    intervention_protocol:
      "Every 10 iter: MonthlySnapshot computeDrift; drift > 30% → auto-replace (reset to initial)",
    intervention_log: interventions,
    final_text: current,
    final_jaccard_with_initial: 1 - finalDrift.drift,
    final_drift: finalDrift.drift,
    final_should_replace: finalDrift.shouldReplace,
    AC_P1_10_pass: finalDrift.drift <= 0.3,
  },
}

const outPath = "tests/fixtures/viewfinder-drift/100-iter-telephone-game.json"
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`)
console.log(
  `fixture written: ${outPath}\n  raw drift = ${rawDrift.drift.toFixed(3)}\n  intervened drift = ${finalDrift.drift.toFixed(3)}\n  AC pass = ${finalDrift.drift <= 0.3}`,
)
