/**
 * F027 Phase 3 P20 · AdaptiveRecallCoordinator tests — Week 2 Day 7-8 a
 *
 * 覆盖：
 *   - disabled 时 passthrough taskMemoryPackHits + reason=disabled + executed=false
 *   - enabled=true 但 executorDeps 缺 → passthrough + reason=deps_missing + warn 一次
 *   - scenario 不在白名单（session_bootstrap / direct_turn 默认）→ reason=scenario_skip
 *   - scenario 命中（wake_up / a2a_handoff）+ executor success → executed + reason=ok + hits 用 executor 的
 *   - executor 抛错 → fail-soft passthrough + reason=executor_error + error 填 + warn 一次
 *   - budget override per-turn（input.budgetOverride 覆盖 config.defaultBudget）
 *   - 自定义 triggerScenarios（如只 wake_up 不 a2a_handoff）
 *   - deriveTriggerFromScenario 映射正确
 *   - getEffectiveBudget 合并 DEFAULT_RECALL_BUDGET + config.defaultBudget
 *   - isEnabled 返回 boot 时的 flag
 *   - createNoopAdaptiveRecallCoordinator 永远 passthrough
 */

import assert from "node:assert/strict"
import test from "node:test"
import { executeAdaptiveRecall } from "../wiki/adaptive-recall/executor"
import { DEFAULT_RECALL_BUDGET } from "../wiki/adaptive-recall/types"
import type { ExecuteInput, ExecuteOutput, ExecutorDeps } from "../wiki/adaptive-recall/types"
import type { RecallHit } from "../wiki/memory-preflight/types"
import {
  AdaptiveRecallCoordinator,
  createNoopAdaptiveRecallCoordinator,
  deriveTriggerFromScenario,
} from "./adaptive-recall-coordinator"

// ─── helpers ────────────────────────────────────────────────────────

function makeHit(path: string, score: number): RecallHit {
  return {
    path,
    score,
    excerpt: `excerpt for ${path}`,
  }
}

function makeExecuteOutput(hits: RecallHit[], extras: Partial<ExecuteOutput> = {}): ExecuteOutput {
  return {
    recallPath: 2,
    recallSatisfied: true,
    hits,
    totalMs: 42,
    critiqueCalls: 1,
    budgetExceeded: false,
    attempts: [{ level: 2, hitsCount: hits.length, satisfied: true, ms: 42, reason: "ok" }],
    ...extras,
  }
}

/** 用最小 ExecutorDeps 占位 — 走 stub executor 时 deps 不会被真调。 */
function makeStubDeps(): ExecutorDeps {
  return {
    critique: { evaluate: async () => ({ satisfied: true, reason: "stub" }) },
    level2: { searchWiki: async () => [] },
    level3: { queryMessages: async () => [] },
    level4: { readWiki: async () => null },
    level5: { escalate: async () => {} },
  }
}

function makeWarnSpy() {
  const calls: Array<{ obj: unknown; msg?: string }> = []
  return {
    spy: { warn: (obj: unknown, msg?: string) => calls.push({ obj, msg }) },
    calls,
  }
}

// ─── tests ──────────────────────────────────────────────────────────

test("Day 7 · Coordinator · disabled (default) → passthrough taskMemoryPackHits", async () => {
  const hits = [makeHit("wiki/a.md", 0.9), makeHit("wiki/b.md", 0.8)]
  const coord = new AdaptiveRecallCoordinator({ enabled: false })
  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "wake_up",
    trigger: "wake_up_history",
    query: "F027 Phase 3",
    taskMemoryPackHits: hits,
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, "disabled")
  assert.deepEqual(r.hits, hits)
  assert.equal(r.output, undefined)
})

test("Day 7 · Coordinator · disabled 时 taskMemoryPackHits 缺省 → hits=[]", async () => {
  const coord = new AdaptiveRecallCoordinator({ enabled: false })
  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "wake_up",
    trigger: "wake_up",
    query: "q",
  })
  assert.equal(r.executed, false)
  assert.deepEqual(r.hits, [])
})

test("Day 7 · Coordinator · enabled 但 executorDeps 缺 → reason=deps_missing + warn 一次", async () => {
  const w = makeWarnSpy()
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    logger: w.spy,
  })
  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "a2a_handoff",
    trigger: "a2a_call",
    query: "q",
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, "deps_missing")
  assert.equal(w.calls.length, 1)
  assert.match(String(w.calls[0].msg), /executorDeps missing/i)
})

test("Day 7 · Coordinator · scenario session_bootstrap 默认不触发 → reason=scenario_skip", async () => {
  const hits = [makeHit("wiki/x.md", 0.7)]
  let executorCalls = 0
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    executor: async () => {
      executorCalls++
      return makeExecuteOutput([])
    },
  })
  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "session_bootstrap",
    trigger: "session_bootstrap",
    query: "q",
    taskMemoryPackHits: hits,
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, "scenario_skip")
  assert.deepEqual(r.hits, hits)
  assert.equal(executorCalls, 0)
})

test("Day 7 · Coordinator · scenario direct_turn 默认不触发", async () => {
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    executor: async () => makeExecuteOutput([]),
  })
  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "direct_turn",
    trigger: "direct_turn",
    query: "q",
  })
  assert.equal(r.reason, "scenario_skip")
})

test("Day 7 · Coordinator · scenario wake_up 触发 + executor success → executed + ok + 用 executor.hits", async () => {
  const passthroughHits = [makeHit("wiki/passthrough.md", 0.6)]
  const executorHits = [
    makeHit("wiki/from-executor-1.md", 0.92),
    makeHit("wiki/from-executor-2.md", 0.88),
  ]
  let observed: ExecuteInput | null = null

  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    executor: async (input) => {
      observed = input
      return makeExecuteOutput(executorHits, { recallPath: 2, recallSatisfied: true })
    },
  })

  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "wake_up",
    trigger: "wake_up_history_keyword",
    query: "F027 Phase 3 wiring",
    taskMemoryPackHits: passthroughHits,
  })

  assert.equal(r.executed, true)
  assert.equal(r.reason, "ok")
  assert.deepEqual(r.hits, executorHits, "executed=true → hits 用 executor 输出，不用 passthrough")
  assert.ok(r.output)
  assert.equal(r.output?.recallPath, 2)
  assert.equal(r.output?.recallSatisfied, true)

  // executor 收到正确入参
  if (observed === null) throw new Error("executor not called")
  const seen: ExecuteInput = observed
  assert.equal(seen.roomId, "R-201")
  assert.equal(seen.alias, "黄仁勋")
  assert.equal(seen.trigger, "wake_up_history_keyword")
  assert.equal(seen.query, "F027 Phase 3 wiring")
  assert.deepEqual(seen.taskMemoryPack, passthroughHits)
})

test("Day 7 · Coordinator · scenario a2a_handoff 触发", async () => {
  let called = false
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    executor: async () => {
      called = true
      return makeExecuteOutput([])
    },
  })
  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "a2a_handoff",
    trigger: "a2a_call",
    query: "q",
  })
  assert.equal(r.executed, true)
  assert.equal(called, true)
})

test("Day 7 · Coordinator · executor 抛错 → fail-soft passthrough + reason=executor_error + warn", async () => {
  const w = makeWarnSpy()
  const passthroughHits = [makeHit("wiki/keep.md", 0.65)]
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    executor: async () => {
      throw new Error("simulated executor crash")
    },
    logger: w.spy,
  })
  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "wake_up",
    trigger: "wake_up",
    query: "q",
    taskMemoryPackHits: passthroughHits,
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, "executor_error")
  assert.deepEqual(r.hits, passthroughHits)
  assert.ok(r.error)
  assert.match(r.error?.message ?? "", /simulated executor crash/)
  assert.equal(w.calls.length, 1, "应 warn 一次（fail-soft 可观测）")
})

test("Day 7 · Coordinator · budget override per-turn 合并到 executor input.budget", async () => {
  let receivedBudget: unknown = null
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    defaultBudget: { maxLevels: 4, maxTotalMs: 8000 },
    executor: async (input) => {
      receivedBudget = input.budget
      return makeExecuteOutput([])
    },
  })

  await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "黄仁勋",
    scenario: "wake_up",
    trigger: "wake_up",
    query: "q",
    budgetOverride: { maxLevels: 2 }, // override config.defaultBudget.maxLevels
  })

  assert.deepEqual(
    receivedBudget,
    { maxLevels: 2, maxTotalMs: 8000 },
    "input.budgetOverride 覆盖 config.defaultBudget 同名字段",
  )
})

test("Day 7 · Coordinator · 自定义 triggerScenarios（只 wake_up 不 a2a_handoff）", async () => {
  let count = 0
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    triggerScenarios: ["wake_up"],
    executorDeps: makeStubDeps(),
    executor: async () => {
      count++
      return makeExecuteOutput([])
    },
  })
  const wake = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "x",
    scenario: "wake_up",
    trigger: "wake_up",
    query: "q",
  })
  assert.equal(wake.executed, true)

  const a2a = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "x",
    scenario: "a2a_handoff",
    trigger: "a2a_call",
    query: "q",
  })
  assert.equal(a2a.executed, false)
  assert.equal(a2a.reason, "scenario_skip")

  assert.equal(count, 1)
})

test("Day 7 · Coordinator · getEffectiveBudget 合并 P13 DEFAULT_RECALL_BUDGET + config.defaultBudget", () => {
  const coord = new AdaptiveRecallCoordinator({
    defaultBudget: { maxLevels: 5, maxTotalMs: 10000 },
  })
  const eff = coord.getEffectiveBudget()
  assert.equal(eff.maxLevels, 5)
  assert.equal(eff.maxTotalMs, 10000)
  // 没覆盖的字段保留 P13 默认值
  assert.equal(eff.maxCritiqueCalls, DEFAULT_RECALL_BUDGET.maxCritiqueCalls)
  assert.equal(eff.queryParallel, DEFAULT_RECALL_BUDGET.queryParallel)
  assert.equal(eff.reuseTaskMemoryPack, DEFAULT_RECALL_BUDGET.reuseTaskMemoryPack)
})

test("Day 7 · Coordinator · isEnabled 反映 boot flag", () => {
  assert.equal(new AdaptiveRecallCoordinator({ enabled: true }).isEnabled(), true)
  assert.equal(new AdaptiveRecallCoordinator({ enabled: false }).isEnabled(), false)
  assert.equal(new AdaptiveRecallCoordinator().isEnabled(), false, "默认 disabled")
})

test("Day 7 · deriveTriggerFromScenario · 映射", () => {
  assert.equal(deriveTriggerFromScenario("wake_up"), "wake_up")
  assert.equal(deriveTriggerFromScenario("a2a_handoff"), "a2a_call")
  assert.equal(deriveTriggerFromScenario("session_bootstrap"), "session_bootstrap")
  assert.equal(deriveTriggerFromScenario("direct_turn"), "direct_turn")
})

test("Day 7 · createNoopAdaptiveRecallCoordinator · 永远 passthrough", async () => {
  const hits = [makeHit("wiki/noop.md", 0.7)]
  const coord = createNoopAdaptiveRecallCoordinator()
  assert.equal(coord.isEnabled(), false)
  const r = await coord.executeIfNeeded({
    roomId: "R-201",
    alias: "x",
    scenario: "wake_up",
    trigger: "wake_up",
    query: "q",
    taskMemoryPackHits: hits,
  })
  assert.equal(r.executed, false)
  assert.equal(r.reason, "disabled")
  assert.deepEqual(r.hits, hits)
})

test("Day 7 · Coordinator · 真实 executor 注入（smoke import 不挂）", () => {
  // 不真调（无 ExecutorDeps），仅验证 import + class new 不挂
  const coord = new AdaptiveRecallCoordinator({
    enabled: false,
    executor: executeAdaptiveRecall,
  })
  assert.ok(coord.isEnabled() === false)
})
