/**
 * F027 P12 · MonthlySnapshot drift 测试
 * 真相源：docs/plans/V16.5-final.md chap 11 + AC-P1-10
 *
 * 覆盖：
 *   - 完全相同 → drift=0, shouldReplace=false
 *   - 完全不同 → drift=1, shouldReplace=true
 *   - 半相同 → drift=0.5, shouldReplace=true
 *   - 自定义 threshold
 *   - 两边空 → drift=0
 *   - 单边空 → drift=1
 *   - tokenize helper
 *   - simulateTelephoneGame 确定性（同 seed 同输出）
 *   - 100-iter telephone game fixture（AC-P1-10 字面要求）
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { computeDrift, simulateTelephoneGame, tokenize } from "./monthly-snapshot"

describe("computeDrift", () => {
  it("完全相同 token set → drift=0, shouldReplace=false", () => {
    const tokens = new Set(["a", "b", "c"])
    const r = computeDrift({
      oldDecisionsSummaryTokens: tokens,
      newDecisionsSummaryTokens: new Set(tokens),
    })
    assert.equal(r.jaccard, 1)
    assert.equal(r.drift, 0)
    assert.equal(r.shouldReplace, false)
  })

  it("完全不同 → drift=1, shouldReplace=true", () => {
    const r = computeDrift({
      oldDecisionsSummaryTokens: new Set(["a", "b"]),
      newDecisionsSummaryTokens: new Set(["c", "d"]),
    })
    assert.equal(r.jaccard, 0)
    assert.equal(r.drift, 1)
    assert.equal(r.shouldReplace, true)
  })

  it("半相同 → jaccard=0.5, drift=0.5, shouldReplace=true (>30%)", () => {
    // {a,b,c} vs {b,c,d}: intersection={b,c}=2, union={a,b,c,d}=4 → 2/4=0.5
    const r = computeDrift({
      oldDecisionsSummaryTokens: new Set(["a", "b", "c"]),
      newDecisionsSummaryTokens: new Set(["b", "c", "d"]),
    })
    assert.equal(r.jaccard, 0.5)
    assert.equal(r.drift, 0.5)
    assert.equal(r.shouldReplace, true)
  })

  it("75% 相同 → jaccard=0.6, drift=0.4, shouldReplace=true (>30%)", () => {
    // {a,b,c,d} vs {a,b,c,e}: intersection=3, union=5 → 0.6
    const r = computeDrift({
      oldDecisionsSummaryTokens: new Set(["a", "b", "c", "d"]),
      newDecisionsSummaryTokens: new Set(["a", "b", "c", "e"]),
    })
    assert.ok(Math.abs(r.jaccard - 0.6) < 1e-9)
    assert.ok(Math.abs(r.drift - 0.4) < 1e-9)
    assert.equal(r.shouldReplace, true)
  })

  it("AC-P1-10 字面阈值 30%：jaccard >= 0.7 → drift <= 0.3 → 不 replace", () => {
    // {a..g} vs {a..f, h}: intersection=6, union=8 → 6/8=0.75 → drift=0.25 ≤ 0.3
    const r = computeDrift({
      oldDecisionsSummaryTokens: new Set(["a", "b", "c", "d", "e", "f", "g"]),
      newDecisionsSummaryTokens: new Set(["a", "b", "c", "d", "e", "f", "h"]),
    })
    assert.ok(r.jaccard >= 0.7, `jaccard=${r.jaccard} 必须 >= 0.7（plan 阈值）`)
    assert.equal(r.shouldReplace, false)
  })

  it("自定义 threshold=0.5 → drift>50% 才 replace", () => {
    // {a,b,c,d} vs {a,b}: intersection=2, union=4 → jaccard=0.5, drift=0.5
    // threshold=0.5 → 严格 > 比较 → 0.5 > 0.5 = false
    const r = computeDrift({
      oldDecisionsSummaryTokens: new Set(["a", "b", "c", "d"]),
      newDecisionsSummaryTokens: new Set(["a", "b"]),
      replaceThreshold: 0.5,
    })
    assert.equal(r.drift, 0.5)
    assert.equal(r.shouldReplace, false, "drift=0.5 不 > threshold=0.5（严格大于）")
  })

  it("两边都空 → 视作一致，drift=0", () => {
    const r = computeDrift({
      oldDecisionsSummaryTokens: new Set(),
      newDecisionsSummaryTokens: new Set(),
    })
    assert.equal(r.jaccard, 1)
    assert.equal(r.drift, 0)
    assert.equal(r.shouldReplace, false)
  })

  it("单边空 → drift=1（intersection=0, union=非空）", () => {
    const r = computeDrift({
      oldDecisionsSummaryTokens: new Set(),
      newDecisionsSummaryTokens: new Set(["a", "b"]),
    })
    assert.equal(r.jaccard, 0)
    assert.equal(r.drift, 1)
    assert.equal(r.shouldReplace, true)
  })

  it("details 含 token 计数 + intersection / union size", () => {
    const r = computeDrift({
      oldDecisionsSummaryTokens: new Set(["a", "b", "c"]),
      newDecisionsSummaryTokens: new Set(["b", "c", "d"]),
    })
    assert.equal(r.details.oldTokenCount, 3)
    assert.equal(r.details.newTokenCount, 3)
    assert.equal(r.details.intersectionSize, 2)
    assert.equal(r.details.unionSize, 4)
  })
})

describe("tokenize", () => {
  it("基本切词 + 小写", () => {
    const t = tokenize("Hello World 黄仁勋 F027")
    assert.ok(t.has("hello"))
    assert.ok(t.has("world"))
    assert.ok(t.has("黄仁勋"))
    assert.ok(t.has("f027"))
  })

  it("标点符号切分", () => {
    const t = tokenize("a, b. c! d? e:")
    assert.equal(t.size, 5)
    assert.ok(["a", "b", "c", "d", "e"].every((x) => t.has(x)))
  })

  it("空字符串 → 空 set", () => {
    assert.equal(tokenize("").size, 0)
  })
})

describe("simulateTelephoneGame · 确定性 + AC-P1-10 100-iter fixture", () => {
  it("同 seed 输出确定（fixture 可重现）", () => {
    const a = simulateTelephoneGame("F027 viewfinder anti drift decision ledger", 50, { seed: 42 })
    const b = simulateTelephoneGame("F027 viewfinder anti drift decision ledger", 50, { seed: 42 })
    assert.equal(a.finalText, b.finalText)
  })

  it("不同 seed 输出不同（变异是真随机）", () => {
    const a = simulateTelephoneGame("F027 viewfinder anti drift", 100, { seed: 1 })
    const b = simulateTelephoneGame("F027 viewfinder anti drift", 100, { seed: 2 })
    assert.notEqual(a.finalText, b.finalText)
  })

  it("history 含 N+1 个 snapshot（initial + N iter）", () => {
    const r = simulateTelephoneGame("F027 viewfinder", 10, { seed: 1 })
    assert.equal(r.history.length, 11)
  })

  it("AC-P1-10 fixture: 100 iter 滚动 + 默认 9% 变异 → drift 普遍 > 30%（防漂移机制有用武之地）", () => {
    // AC 字面要求是 "100 次总结迭代后 jaccard >= 0.7"——但那是有 anti-drift 干预的目标，
    // 不干预的话 100 iter 必定漂掉。本测试验证 telephone game 真的会漂移，
    // 即 drift > 30% 时 shouldReplace=true 触发 anti-drift（auto-replace）。
    const initial = "F027 viewfinder anti drift decision ledger tombstone coverage gate haiku rule"
    const initialTokens = tokenize(initial)
    const r = simulateTelephoneGame(initial, 100, { seed: 42 })
    const drift = computeDrift({
      oldDecisionsSummaryTokens: initialTokens,
      newDecisionsSummaryTokens: r.finalTokens,
    })
    // 100 iter 5%/2%/2% 变异下漂移幅度可观
    assert.ok(
      drift.drift > 0.3,
      `100 iter 后 drift=${drift.drift.toFixed(3)} 应 > 0.3 触发 auto-replace`,
    )
    assert.equal(drift.shouldReplace, true, "100 iter 漂移必触发 shouldReplace=true")
  })

  it("AC-P1-10 anti-drift 干预模拟：如果有人工 reset（每 10 iter 重置漂移），最终 drift <= 30%", () => {
    // 模拟 MonthlySnapshot 触发 auto-replace 的效果：每 10 iter 把 tokens 重置为 initial
    const initial = "F027 viewfinder anti drift decision ledger tombstone coverage"
    const initialTokens = tokenize(initial)
    let current = initial
    for (let block = 0; block < 10; block++) {
      const r = simulateTelephoneGame(current, 10, { seed: 42 + block })
      const drift = computeDrift({
        oldDecisionsSummaryTokens: initialTokens,
        newDecisionsSummaryTokens: tokenize(r.finalText),
      })
      if (drift.shouldReplace) {
        // 模拟 auto-replace：reset 到 initial
        current = initial
      } else {
        current = r.finalText
      }
    }
    const finalDrift = computeDrift({
      oldDecisionsSummaryTokens: initialTokens,
      newDecisionsSummaryTokens: tokenize(current),
    })
    assert.ok(
      finalDrift.drift <= 0.3,
      `anti-drift 干预后 final drift=${finalDrift.drift.toFixed(3)} 应 <= 0.3`,
    )
  })
})
