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
import type { RecallHit } from "../wiki/memory-preflight/types"
import { resolveDirectTurnRecall } from "./message-service"

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
