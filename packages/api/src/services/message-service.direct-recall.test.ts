/**
 * F027 B1-b · resolveDirectTurnRecall — direct/wake-up 装配支的 Adaptive Recall 接线 helper。
 *
 * 背景（wiring gap 审计 2026-06-05）：自动召回 `executeIfNeeded` 此前仅 A2A 派发支
 * （message-service.ts:2700）有调用点；direct/wake-up 支（assembleDirectTurnPrompt）从不跑
 * coordinator → wake_up 场景 Recall Pack 永不注入。本 helper 给 direct 支补对称接线。
 *
 * 设计（spec V16.5 line 1094「每次 wake-up / handoff / session_bootstrap 自动召回」+
 * coordinator.ts:96「direct_turn 默认不触发」）：
 *   - helper 无条件调 coordinator，scenario 网关交给 coordinator.triggerScenarios：
 *       wake_up → 真召回；direct_turn（普通用户问答）→ scenario_skip → 不召回
 *   - guardian 模式短路（零上下文契约，不注 recall）
 *   - 返回 { recallResult, memoryPreflight }：memoryPreflight 喂 assembleDirectTurnPrompt，
 *     recallResult 给 writePromptAuditSafe 写 recall 字段（Prompt Inspector 可见）
 */

import assert from "node:assert/strict"
import test from "node:test"
import { AdaptiveRecallCoordinator } from "../orchestrator/adaptive-recall-coordinator"
import type { ExecuteOutput, ExecutorDeps } from "../wiki/adaptive-recall/types"
import type { RecallHit, WikiSearchProvider } from "../wiki/memory-preflight/types"
import { resolveColdStartRecall, resolveDirectTurnRecall } from "./message-service"

function makeHit(path: string, score: number): RecallHit {
  return { path, score, excerpt: `excerpt for ${path}` }
}

function makeExecuteOutput(hits: RecallHit[]): ExecuteOutput {
  return {
    recallPath: 2,
    recallSatisfied: true,
    hits,
    totalMs: 1,
    critiqueCalls: 0,
    budgetExceeded: false,
    attempts: [{ level: 2, hitsCount: hits.length, satisfied: true, ms: 1, reason: "ok" }],
  }
}

/** 最小 ExecutorDeps 占位 — 走 stub executor 时不会被真调。 */
function makeStubDeps(): ExecutorDeps {
  return {
    critique: { evaluate: async () => ({ satisfied: true, reason: "stub" }) },
    level2: { searchWiki: async () => [] },
    level3: { queryMessages: async () => [] },
    level4: { readWiki: async () => null },
    level5: { escalate: async () => {} },
  }
}

test("B1-b · wake_up + executor 命中 → memoryPreflight 注入 + recallResult 透传", async () => {
  let called = false
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    executor: async () => {
      called = true
      return makeExecuteOutput([makeHit("wiki/concepts/F027.md", 0.9)])
    },
  })
  const r = await resolveDirectTurnRecall(coord, {
    roomId: "R-201",
    alias: "桂芬",
    scenario: "wake_up",
    query: "诗歌评价 韵律 意境",
  })
  assert.equal(called, true, "wake_up 在白名单内，executor 应被调")
  assert.ok(r.memoryPreflight, "命中应产出 memoryPreflight")
  assert.equal(r.memoryPreflight!.hits.length, 1)
  assert.equal(r.memoryPreflight!.hits[0].score, 0.9)
  assert.equal(r.memoryPreflight!.hits[0].path, "wiki/concepts/F027.md")
  assert.equal(typeof r.memoryPreflight!.hits[0].summary, "string")
  assert.ok(r.memoryPreflight!.hits[0].summary.length > 0)
  assert.ok(r.recallResult, "recallResult 应透传给 audit")
  assert.equal(r.recallResult!.executed, true)
})

test("B1-b · direct_turn（普通用户问答）→ coordinator scenario_skip → 不召回（spec line 96）", async () => {
  let called = false
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    executor: async () => {
      called = true
      return makeExecuteOutput([makeHit("wiki/x.md", 0.9)])
    },
  })
  const r = await resolveDirectTurnRecall(coord, {
    roomId: "R-201",
    alias: "桂芬",
    scenario: "direct_turn",
    query: "继续",
  })
  assert.equal(called, false, "direct_turn 不在白名单，executor 不该被调")
  assert.equal(r.memoryPreflight, null, "不召回 → memoryPreflight=null")
  assert.ok(r.recallResult, "recallResult 仍非空（reason=scenario_skip）")
  assert.equal(r.recallResult!.executed, false)
})

test("B1-b · guardian 模式 → 短路 null，executor 不调（零上下文契约）", async () => {
  let called = false
  const coord = new AdaptiveRecallCoordinator({
    enabled: true,
    executorDeps: makeStubDeps(),
    executor: async () => {
      called = true
      return makeExecuteOutput([makeHit("wiki/x.md", 0.9)])
    },
  })
  const r = await resolveDirectTurnRecall(coord, {
    roomId: "R-201",
    alias: "桂芬",
    scenario: "wake_up",
    query: "x",
    guardianMode: true,
  })
  assert.equal(called, false, "guardian 模式 executor 不该被调")
  assert.equal(r.memoryPreflight, null)
  assert.equal(r.recallResult, null)
})

// ─── B1-b-2 · resolveColdStartRecall（冷启 loadTaskMemoryPack）──────────
//
// 背景：冷启（新 agent 进新 room，nativeSession===null）是北极星「不白板」本体。
// spec V16.5 line 1094/95：session_bootstrap 由 loadTaskMemoryPack（轻量 Pack）覆盖，
// 非 coordinator。但 loadTaskMemoryPack 此前 0 生产 caller → 冷启 Recall Pack 从没注入。
// 本 helper 给冷启补接线：跑 loadTaskMemoryPack → memoryPreflight → [Recall Pack]。

/** WikiSearchProvider stub —— 每 query 返同一组 hits（gate 去重后剩 1）。 */
function makeSearchStub(hits: RecallHit[]): WikiSearchProvider {
  return { search: async () => hits }
}

test("B1-b-2 · 冷启 + 高置信命中 → memoryPreflight 注入（Recall Pack）+ audit 带 topScore", async () => {
  const search = makeSearchStub([makeHit("wiki/concepts/F027.md", 0.95)])
  const r = await resolveColdStartRecall(search, {
    roomId: "R-201",
    alias: "桂芬",
    taskSummary: "F027 统一记忆架构 自动召回 wiring",
  })
  assert.ok(r?.memoryPreflight, "高置信命中应产出 memoryPreflight")
  assert.ok(r!.memoryPreflight!.hits.length >= 1, "至少 1 个高置信 hit 进 prompt.hits")
  assert.equal(r!.memoryPreflight!.hits[0].path, "wiki/concepts/F027.md")
  assert.equal(typeof r!.memoryPreflight!.hits[0].summary, "string")
  // receive 德彪 r1 P2-2：完整 audit 透传（deriveAuditPatch 产物）
  assert.ok(r!.audit, "成功召回必须带完整 preflight audit")
  assert.equal(r!.audit!.topScore, 0.95)
  assert.equal(typeof r!.audit!.recallQueries, "string")
  assert.equal(typeof r!.audit!.recallTotalTokens, "number")
})

test("B1-b-2 receive P2-2 · inspector-only 命中（0.6-0.75）→ 不注入但 audit.topScore 不丢", async () => {
  const search = makeSearchStub([makeHit("wiki/concepts/mid.md", 0.65)])
  const r = await resolveColdStartRecall(search, {
    roomId: "R-201",
    alias: "桂芬",
    taskSummary: "中置信查询",
  })
  assert.ok(r, "search 跑了应返回非 null")
  assert.equal(r!.memoryPreflight, null, "0.65 < 注入 floor → 不注入 [Recall Pack]")
  assert.ok(r!.audit, "audit 仍应携带")
  assert.equal(r!.audit!.topScore, 0.65, "inspector-only 命中的 topScore 不得丢（审计失真）")
})

test("B1-b-2 · search provider 未注入（null）→ null（无 DI 不召回）", async () => {
  const r = await resolveColdStartRecall(null, {
    roomId: "R-201",
    alias: "桂芬",
    taskSummary: "任意",
  })
  assert.equal(r, null)
})

test("B1-b-2 · search backend 整体抛错 → fail-soft（不阻塞冷启 turn，audit 记空召回）", async () => {
  // 注：backend 抛错被 loadTaskMemoryPack **内部** per-query fail-soft 吃掉（返空 hits 不上抛），
  // 所以这里 audit 是「跑了但全空」的诚实记录（topScore=null + results 空），非 null。
  // resolveColdStartRecall 外层 catch 只兜 loadTaskMemoryPack 自身的意外崩溃。
  const search: WikiSearchProvider = {
    search: async () => {
      throw new Error("simulated search backend crash")
    },
  }
  let warned = false
  const r = await resolveColdStartRecall(
    search,
    { roomId: "R-201", alias: "桂芬", taskSummary: "x" },
    { warn: () => { warned = true } },
  )
  assert.ok(r, "fail-soft 返回结构体（attempted）")
  assert.equal(r!.memoryPreflight, null, "backend 挂掉 → 无注入")
  assert.ok(r!.audit, "per-query fail-soft → audit 记空召回（非 null）")
  assert.equal(r!.audit!.topScore, null, "无任何命中 → topScore=null")
  assert.equal(warned, true, "fail-soft 应 warn（不静默退化）")
})
