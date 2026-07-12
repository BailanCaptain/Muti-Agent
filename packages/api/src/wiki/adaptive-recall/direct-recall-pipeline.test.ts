/**
 * F042 AC6 Task 16 · direct 快链管道（ADR-005）
 *
 * 覆盖：
 *   1. L2 命中过 gate → path2 / satisfied / critiqueCalls=0
 *   2. L2 噪声（单 clause 偶合）被 gate 拒 → 降 L3 → L3 命中 → path3
 *   3. 两级全 miss → 正常 miss：satisfied=false / hits=[] / 无 escalateReason（不进 L5）
 *   4. unsupported query → 不调任何 backend，直接 miss
 *   5. deadline：L2 耗尽预算 → 不调 L3，budgetExceeded=true
 *   6. backend 抛错 → fail-soft 空结果继续（不 unhandled throw）
 *   7. exactEntityMatch 直通 gate
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RecallHit, RecallHitEvidence } from "../memory-preflight/types"
import { compileRecallFtsQuery } from "../wiki-search/fts-query-compiler"
import { evidenceGate, executeDirectRecall } from "./direct-recall-pipeline"

function hit(path: string, ev: Partial<RecallHitEvidence>): RecallHit {
  return {
    path,
    score: 1,
    excerpt: "…",
    evidence: {
      matchedClauseCount: 0,
      totalClauseCount: 10,
      clauseCoverage: 0,
      matchedOrClauseCount: 0,
      exactEntityMatch: false,
      exactPathMatch: false,
      ...ev,
    },
  }
}

const QUERY = "异步验证：探针协议的核心规则有几条？"

describe("evidenceGate（德彪 AC6-r1 P1-2 语义）", () => {
  it("存在 OR-evidenced 候选时零 OR 候选一律淘汰（实体噪声不得直通）", () => {
    const target = hit("target.md", {
      matchedClauseCount: 3,
      matchedOrClauseCount: 2,
      clauseCoverage: 0.3,
      exactEntityMatch: true,
    })
    const entityNoise = hit("noise.md", {
      matchedClauseCount: 1,
      matchedOrClauseCount: 0,
      clauseCoverage: 0.1,
      exactEntityMatch: true,
    })
    const passed = evidenceGate([entityNoise, target])
    assert.deepEqual(
      passed.map((h) => h.path),
      ["target.md"],
    )
  })

  it("德彪 AC6-r2 P1 · 点名场景：path 命中不参与 OR 竞争，decoy 不得顶替", () => {
    const named = hit("wiki/concepts/foo-bar.md", {
      matchedClauseCount: 0,
      matchedOrClauseCount: 0,
      clauseCoverage: 0,
      exactEntityMatch: true,
      exactPathMatch: true,
    })
    const decoy = hit("wiki/concepts/decoy.md", {
      matchedClauseCount: 2,
      matchedOrClauseCount: 2,
      clauseCoverage: 0.5,
    })
    const passed = evidenceGate([decoy, named], { pathMustsPresent: true })
    assert.deepEqual(
      passed.map((h) => h.path),
      ["wiki/concepts/foo-bar.md"],
      "只留点名文档；含内容词的无关 decoy 不得注入",
    )
  })

  it("德彪 AC6-r2 P1 · 点名文档不存在 → 如实空（不退化为普通 gate）", () => {
    const decoy = hit("wiki/concepts/decoy.md", {
      matchedClauseCount: 3,
      matchedOrClauseCount: 3,
      clauseCoverage: 0.5,
    })
    assert.deepEqual(evidenceGate([decoy], { pathMustsPresent: true }), [])
  })

  it("全场无 OR 候选 → 受限 must-only fallback 放行实体命中", () => {
    const entityOnly = hit("f042.md", {
      matchedClauseCount: 1,
      matchedOrClauseCount: 0,
      clauseCoverage: 0.1,
      exactEntityMatch: true,
    })
    const passed = evidenceGate([entityOnly])
    assert.equal(passed.length, 1)
  })

  it("非实体：≥2 clause 且 coverage 达标通过；单 clause 拒；无 evidence 拒", () => {
    const strong = hit("a.md", {
      matchedClauseCount: 4,
      matchedOrClauseCount: 4,
      clauseCoverage: 0.4,
    })
    const noise = hit("c.md", {
      matchedClauseCount: 1,
      matchedOrClauseCount: 1,
      clauseCoverage: 0.1,
    })
    const lowCov = hit("d.md", {
      matchedClauseCount: 2,
      matchedOrClauseCount: 2,
      clauseCoverage: 0.05,
    })
    const bare: RecallHit = { path: "e.md", score: 1, excerpt: "…" }
    const passed = evidenceGate([strong, noise, lowCov, bare])
    assert.deepEqual(
      passed.map((h) => h.path),
      ["a.md"],
    )
  })
})

describe("executeDirectRecall", () => {
  it("L2 命中过 gate → path2 satisfied，critiqueCalls=0，L3 不被调", async () => {
    let l3Calls = 0
    const out = await executeDirectRecall(
      { query: QUERY, roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => [
          hit("wiki/rules/probe.md", {
            matchedClauseCount: 5,
            matchedOrClauseCount: 5,
            clauseCoverage: 0.5,
          }),
        ],
        searchMessages: async () => {
          l3Calls++
          return []
        },
      },
    )
    assert.equal(out.recallPath, 2)
    assert.equal(out.recallSatisfied, true)
    assert.equal(out.hits.length, 1)
    assert.equal(out.critiqueCalls, 0)
    assert.equal(out.escalateReason, undefined)
    assert.equal(l3Calls, 0)
    assert.equal(out.attempts.length, 1)
    assert.equal(out.attempts[0].level, 2)
  })

  it("L2 噪声被 gate 拒 → L3 命中 → path3（attempts 记两级）", async () => {
    const out = await executeDirectRecall(
      { query: QUERY, roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => [
          hit("wiki/noise.md", {
            matchedClauseCount: 1,
            matchedOrClauseCount: 1,
            clauseCoverage: 0.1,
          }),
        ],
        searchMessages: async () => [
          hit("messages/r1/m9", {
            matchedClauseCount: 3,
            matchedOrClauseCount: 3,
            clauseCoverage: 0.3,
          }),
        ],
      },
    )
    assert.equal(out.recallPath, 3)
    assert.equal(out.recallSatisfied, true)
    assert.equal(out.hits[0].path, "messages/r1/m9")
    assert.equal(out.attempts.length, 2)
    // L2 attempt 如实记录原始召回数与 gate 结论
    assert.equal(out.attempts[0].satisfied, false)
    assert.equal(out.attempts[0].hitsCount, 1)
  })

  it("两级全 miss → 正常 miss：无 escalateReason、hits=[]（ADR-005 不进 L5）", async () => {
    const out = await executeDirectRecall(
      { query: QUERY, roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => [],
        searchMessages: async () => [],
      },
    )
    assert.equal(out.recallPath, 3)
    assert.equal(out.recallSatisfied, false)
    assert.deepEqual(out.hits, [])
    assert.equal(out.critiqueCalls, 0)
    assert.equal(out.escalateReason, undefined)
    assert.equal(out.budgetExceeded, false)
  })

  it("unsupported query（纯短碎片）→ 零 backend 调用直接 miss", async () => {
    let calls = 0
    const out = await executeDirectRecall(
      { query: "你好", roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => {
          calls++
          return []
        },
        searchMessages: async () => {
          calls++
          return []
        },
      },
    )
    assert.equal(calls, 0)
    assert.equal(out.recallSatisfied, false)
    assert.equal(out.attempts.length, 0)
    assert.equal(out.escalateReason, undefined)
  })

  it("deadline 耗尽 → 不再调 L3，budgetExceeded=true（预算覆盖 backend 本身）", async () => {
    let t = 0
    let l3Calls = 0
    const out = await executeDirectRecall(
      { query: QUERY, roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => {
          t += 600 // L2 backend 本身耗掉 600ms > 500ms deadline
          return []
        },
        searchMessages: async () => {
          l3Calls++
          return []
        },
        now: () => t,
      },
      { deadlineMs: 500 },
    )
    assert.equal(l3Calls, 0)
    assert.equal(out.budgetExceeded, true)
    assert.equal(out.recallSatisfied, false)
    assert.equal(out.escalateReason, undefined)
  })

  it("德彪 AC6-r1 P1-1 · 超时后的 gated 命中一律丢弃（fail-open=不注入过期结果）", async () => {
    let t = 0
    const out = await executeDirectRecall(
      { query: QUERY, roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => {
          t += 80 // backend 80ms > 20ms deadline，但返回了 gated 命中
          return [
            hit("wiki/rules/probe.md", {
              matchedClauseCount: 5,
              matchedOrClauseCount: 5,
              clauseCoverage: 0.5,
            }),
          ]
        },
        searchMessages: async () => [],
        now: () => t,
      },
      { deadlineMs: 20 },
    )
    assert.equal(out.recallSatisfied, false, "超时结果不得 satisfied")
    assert.deepEqual([...out.hits], [], "超时结果必须丢弃")
    assert.equal(out.budgetExceeded, true)
    assert.equal(out.escalateReason, undefined)
    // 德彪 AC6-r2 P2 · 丢弃事实必须进审计 trail（否则只见 gate_passed 看不到没被采用）
    const last = out.attempts[out.attempts.length - 1]
    assert.equal(last.satisfied, false)
    assert.match(last.reason, /deadline_exceeded.*discarded/)
  })

  it("德彪 AC6-r2 P1 配套 · pathMusts 非空且 L2 无 path 命中 → 不调 L3 直接 miss", async () => {
    let l3Calls = 0
    const out = await executeDirectRecall(
      { query: "看下 concepts/foo-bar.md 的内容", roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => [], // 点名文档不存在
        searchMessages: async () => {
          l3Calls++
          return []
        },
      },
    )
    assert.equal(l3Calls, 0, "消息没有 wiki path，L3 物理上不可能命中点名文档")
    assert.equal(out.recallSatisfied, false)
    assert.equal(out.escalateReason, undefined)
  })

  it("backend 抛错 → fail-soft 视为空结果继续 L3（attempt reason 记录）", async () => {
    const out = await executeDirectRecall(
      { query: QUERY, roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => {
          throw new Error("sqlite locked")
        },
        searchMessages: async () => [
          hit("messages/r1/m1", {
            matchedClauseCount: 2,
            matchedOrClauseCount: 2,
            clauseCoverage: 0.3,
          }),
        ],
      },
    )
    assert.equal(out.recallPath, 3)
    assert.equal(out.recallSatisfied, true)
    assert.match(out.attempts[0].reason, /backend_error/)
  })

  it("compile 一次贯穿两级：L3 收到的是同一 matchExpr（fake 断言入参）", async () => {
    const compiled = compileRecallFtsQuery(QUERY)
    let l3Expr = ""
    await executeDirectRecall(
      { query: QUERY, roomId: "r1", trigger: "direct_turn" },
      {
        searchWiki: async () => [],
        searchMessages: async (c) => {
          l3Expr = c.matchExpr
          return []
        },
      },
    )
    assert.equal(l3Expr, compiled.matchExpr)
  })
})
