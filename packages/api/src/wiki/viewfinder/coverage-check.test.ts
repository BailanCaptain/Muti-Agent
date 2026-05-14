/**
 * F027 P12 · Coverage Check 测试
 * 真相源：docs/plans/V16.5-final.md chap 11 行 1238-1253 + 范-r2 Q-2
 *
 * 覆盖：
 *   - broad=0 → status=unknown reason=no_broad_candidates
 *   - broad < minBroad → status=unknown
 *   - coverage >= passThreshold → status=pass
 *   - coverage < passThreshold → status=warn + unresolved 列表
 *   - renderCoverageWarning 拼 warning markdown
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { computeCoverage, renderCoverageWarning } from "./coverage-check"
import type { BroadCandidate, ExtractorRun } from "./types"

function cand(id: string, content = "go"): BroadCandidate {
  return {
    messageId: id,
    authorAlias: "小孙",
    createdAt: "t",
    content,
    matchedKeyword: "commit:go",
    prevAssistantContent: null,
    prevAssistantId: null,
  }
}

function run(opts: {
  broad: number
  decisions: number
  nonDecisions: number
  unresolved: number
}): ExtractorRun {
  const broadCandidates: BroadCandidate[] = Array.from({ length: opts.broad }, (_, i) =>
    cand(`u-${i}`),
  )
  const resolvedDecisions: ExtractorRun["resolvedDecisions"] = Array.from(
    { length: opts.decisions },
    (_, i) => ({
      candidate: broadCandidates[i],
      judgment: { isDecision: true, type: "commit", content: "x" },
    }),
  )
  const resolvedNonDecisions: ExtractorRun["resolvedNonDecisions"] = Array.from(
    { length: opts.nonDecisions },
    (_, i) => ({
      candidate: broadCandidates[opts.decisions + i],
      reason: "non-decision",
    }),
  )
  const unresolved: ExtractorRun["unresolved"] = Array.from(
    { length: opts.unresolved },
    (_, i) => ({
      candidate: broadCandidates[opts.decisions + opts.nonDecisions + i],
      error: "haiku-failed",
    }),
  )
  return { broadCandidates, resolvedDecisions, resolvedNonDecisions, unresolved }
}

describe("computeCoverage", () => {
  it("broad=0 → status=unknown reason=no_broad_candidates", () => {
    const r = computeCoverage(run({ broad: 0, decisions: 0, nonDecisions: 0, unresolved: 0 }))
    assert.equal(r.status, "unknown")
    assert.equal(r.reason, "no_broad_candidates")
    assert.equal(r.coverage, null)
    assert.deepEqual(r.unresolvedMessageIds, [])
  })

  it("broad < minBroad → status=unknown 不下结论", () => {
    const r = computeCoverage(run({ broad: 2, decisions: 2, nonDecisions: 0, unresolved: 0 }), {
      minBroad: 3,
    })
    assert.equal(r.status, "unknown")
    assert.match(r.reason, /broad=2 < minBroad=3/)
    assert.equal(r.coverage, 1.0, "coverage 算出来但 status=unknown 因分母太小")
  })

  it("coverage >= passThreshold (默认 0.95) → status=pass", () => {
    // 10 broad / 10 resolved (10 decisions + 0 non) → 100%
    const r = computeCoverage(run({ broad: 10, decisions: 10, nonDecisions: 0, unresolved: 0 }))
    assert.equal(r.status, "pass")
    assert.equal(r.coverage, 1.0)
  })

  it("coverage < passThreshold → status=warn + 列出 unresolved", () => {
    // 10 broad / 8 resolved (5 decisions + 3 non) / 2 unresolved → 80% < 95%
    const r = computeCoverage(run({ broad: 10, decisions: 5, nonDecisions: 3, unresolved: 2 }))
    assert.equal(r.status, "warn")
    assert.ok(r.coverage !== null && r.coverage === 0.8)
    assert.equal(r.unresolved, 2)
    assert.equal(r.unresolvedMessageIds.length, 2)
  })

  it("R-201 真实场景：14 broad / 12 resolved / 2 unresolved → 86% warn", () => {
    const r = computeCoverage(run({ broad: 14, decisions: 8, nonDecisions: 4, unresolved: 2 }))
    assert.equal(r.status, "warn")
    assert.ok(r.coverage !== null)
    assert.ok(r.coverage >= 0.85 && r.coverage < 0.95, `coverage=${r.coverage}`)
  })

  it("自定义 passThreshold=0.8 → 80% 命中 pass", () => {
    const r = computeCoverage(run({ broad: 10, decisions: 5, nonDecisions: 3, unresolved: 2 }), {
      passThreshold: 0.8,
    })
    assert.equal(r.status, "pass")
  })

  it("non-decision 也算 resolved（范-r2 关键解法）", () => {
    // 5 broad / 0 decisions / 5 显式 non-decision → coverage 100%
    const r = computeCoverage(run({ broad: 5, decisions: 0, nonDecisions: 5, unresolved: 0 }))
    assert.equal(r.status, "pass")
    assert.equal(r.coverage, 1.0)
  })
})

describe("renderCoverageWarning", () => {
  it("status=pass → 空字符串", () => {
    const r = computeCoverage(run({ broad: 10, decisions: 10, nonDecisions: 0, unresolved: 0 }))
    const warning = renderCoverageWarning(r, "R-201", new Map())
    assert.equal(warning, "")
  })

  it("status=warn + unresolved → markdown 列表 + 手动确认提示", () => {
    const r = computeCoverage(run({ broad: 10, decisions: 5, nonDecisions: 3, unresolved: 2 }))
    const excerptMap = new Map([
      ["u-8", "@黄仁勋 go"],
      ["u-9", "@黄仁勋 A"],
    ])
    const warning = renderCoverageWarning(r, "R-201", excerptMap)
    assert.match(warning, /⚠️ Coverage warn/)
    assert.match(warning, /Unresolved candidates/)
    assert.match(warning, /msg u-8.*"@黄仁勋 go"/)
    assert.match(warning, /msg u-9.*"@黄仁勋 A"/)
    assert.match(warning, /POST \/api\/rooms\/R-201\/decisions/)
  })

  it("excerpt 缺失 → fallback '(excerpt unavailable)'", () => {
    const r = computeCoverage(run({ broad: 5, decisions: 1, nonDecisions: 0, unresolved: 4 }))
    const warning = renderCoverageWarning(r, "R-201", new Map())
    assert.match(warning, /excerpt unavailable/)
  })

  it("status=unknown 也渲染 warning（broad=0 时无 unresolved 列表）", () => {
    const r = computeCoverage(run({ broad: 0, decisions: 0, nonDecisions: 0, unresolved: 0 }))
    const warning = renderCoverageWarning(r, "R-201", new Map())
    assert.match(warning, /⚠️ Coverage unknown/)
    assert.match(warning, /no_broad_candidates/)
  })
})
