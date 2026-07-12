import assert from "node:assert/strict"
import test from "node:test"

import { parseDirectTurnRecallMode, resolveTriggerScenarios } from "./direct-turn-recall-mode"

test("parseDirectTurnRecallMode: 合法值原样返回", () => {
  assert.equal(parseDirectTurnRecallMode("off"), "off")
  assert.equal(parseDirectTurnRecallMode("shadow"), "shadow")
  assert.equal(parseDirectTurnRecallMode("inject"), "inject")
})

test("parseDirectTurnRecallMode: 缺省/空串/非法值 → shadow；trim+小写归一", () => {
  assert.equal(parseDirectTurnRecallMode(undefined), "shadow")
  assert.equal(parseDirectTurnRecallMode(""), "shadow")
  assert.equal(parseDirectTurnRecallMode("  INJECT "), "inject")
  assert.equal(parseDirectTurnRecallMode("Off"), "off")
  assert.equal(parseDirectTurnRecallMode("banana"), "shadow")
})

test("resolveTriggerScenarios: off → 默认白名单（不含 direct_turn，F027 现状）", () => {
  assert.deepEqual(resolveTriggerScenarios("off"), ["wake_up", "a2a_handoff"])
})

test("resolveTriggerScenarios: shadow/inject → 白名单扩 direct_turn", () => {
  assert.deepEqual(resolveTriggerScenarios("shadow"), ["wake_up", "a2a_handoff", "direct_turn"])
  assert.deepEqual(resolveTriggerScenarios("inject"), ["wake_up", "a2a_handoff", "direct_turn"])
})
