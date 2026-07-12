import assert from "node:assert/strict"
import test from "node:test"

import type { RecallStatsWindow } from "../../routes/phase3/recall-stats"
import { ShadowWindowNotifier } from "./shadow-window-notifier"

function makeStats(overrides: Partial<RecallStatsWindow> = {}): RecallStatsWindow {
  return {
    window: 50,
    totalRecalls: 0,
    hitRate: 0,
    adoptionRate: null,
    annotatedCount: 0,
    adoptedCount: 0,
    topEntries: [],
    oldestAt: null,
    newestAt: null,
    ...overrides,
  }
}

function makeAppState() {
  const store = new Map<string, string>()
  return {
    get: (k: string) => store.get(k) ?? null,
    set: (k: string, v: string) => {
      store.set(k, v)
    },
    store,
  }
}

function makeNotifier(stats: RecallStatsWindow, appState = makeAppState()) {
  const notifier = new ShadowWindowNotifier({
    stats: { getStats: () => stats },
    appState,
  })
  return { notifier, appState }
}

test("窗口未满（49 次）且未过 14 天 → 不发", () => {
  const { notifier } = makeNotifier(
    makeStats({ totalRecalls: 49, oldestAt: new Date().toISOString() }),
  )
  assert.equal(notifier.check(), null)
})

test("第 50 次 → 小结候选（含命中率/采纳率/Top 条目/建议）；markSent 后不再发", () => {
  const stats = makeStats({
    totalRecalls: 50,
    hitRate: 0.72,
    adoptionRate: 0.65,
    annotatedCount: 36,
    adoptedCount: 23,
    topEntries: [
      { path: "wiki/concepts/F031.md", count: 12 },
      { path: "wiki/methods/preview.md", count: 8 },
    ],
    oldestAt: "2026-07-01T00:00:00Z",
    newestAt: "2026-07-11T00:00:00Z",
  })
  const { notifier, appState } = makeNotifier(stats)
  const c = notifier.check()
  assert.ok(c)
  assert.equal(c.kind, "shadow_summary")
  assert.ok(c.content.includes("50"), "含召回次数")
  assert.ok(c.content.includes("72"), "含命中率百分数")
  assert.ok(c.content.includes("65"), "含采纳率百分数")
  assert.ok(c.content.includes("F031"), "含 Top 条目")
  assert.ok(c.content.includes("inject"), "采纳率 ≥60% → 建议放开注入")

  assert.equal(appState.get("f042_shadow_summary_sent"), null, "check 不置位（两阶段）")
  notifier.markSent("shadow_summary")
  assert.ok(appState.get("f042_shadow_summary_sent"), "markSent 置位")
  // 置位后不再出小结；本 fixture 标注 36 ≥ 30 → 顺位轮到 rerank 提示（级联属设计内）
  assert.equal(notifier.check()?.kind, "rerank_hint")
})

test("采纳率 <60% → 建议继续 shadow", () => {
  const { notifier } = makeNotifier(
    makeStats({ totalRecalls: 50, hitRate: 0.4, adoptionRate: 0.3, annotatedCount: 20 }),
  )
  const c = notifier.check()
  assert.ok(c)
  assert.ok(c.content.includes("shadow"), "低采纳率 → 建议继续影子")
  assert.ok(!c.content.includes("建议放开"), "不建议放开注入")
})

test("14 天先到且样本 ≥20 → 小结候选（F042 AC6 德彪 2.5：时间分支带最小样本下限）", () => {
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString()
  const { notifier } = makeNotifier(
    makeStats({ totalRecalls: 25, hitRate: 0.5, oldestAt: fifteenDaysAgo }),
  )
  const c = notifier.check()
  assert.ok(c)
  assert.equal(c.kind, "shadow_summary")
})

test("14 天先到但样本 <20 → 不发（小样本撑不起命中率/采纳率结论）", () => {
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString()
  const { notifier } = makeNotifier(
    makeStats({ totalRecalls: 12, hitRate: 0.5, oldestAt: fifteenDaysAgo }),
  )
  assert.equal(notifier.check(), null)
})

test("零数据（totalRecalls=0）→ 14 天路径也不发（没东西可总结）", () => {
  const { notifier } = makeNotifier(makeStats({ totalRecalls: 0, oldestAt: null }))
  assert.equal(notifier.check(), null)
})

test("小结已发 + 标注攒满 30 → rerank 提示（独立标志，一次性）", () => {
  const stats = makeStats({ totalRecalls: 80, hitRate: 0.7, adoptionRate: 0.6, annotatedCount: 31 })
  const { notifier, appState } = makeNotifier(stats)
  notifier.markSent("shadow_summary")
  const c = notifier.check()
  assert.ok(c)
  assert.equal(c.kind, "rerank_hint")
  assert.ok(c.content.includes("rerank"), "提示可拍 rerank 立项")
  assert.ok(c.content.includes("31"), "含标注数")
  notifier.markSent("rerank_hint")
  assert.equal(notifier.check(), null, "两标志齐 → 永久静默")
  assert.ok(appState.get("f042_rerank_hint_sent"))
})

test("小结未发时 rerank 不抢跑（同 turn 只出一张卡，小结优先）", () => {
  const stats = makeStats({ totalRecalls: 50, hitRate: 0.7, adoptionRate: 0.6, annotatedCount: 40 })
  const { notifier } = makeNotifier(stats)
  const c = notifier.check()
  assert.ok(c)
  assert.equal(c.kind, "shadow_summary")
})

test("stats 抛错 → check 返回 null（fail-soft 不炸主链）", () => {
  const notifier = new ShadowWindowNotifier({
    stats: {
      getStats: () => {
        throw new Error("db locked")
      },
    },
    appState: makeAppState(),
  })
  assert.equal(notifier.check(), null)
})
