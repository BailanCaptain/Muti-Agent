import test from "node:test"
import assert from "node:assert/strict"
import { SettlementDetector, type SettlementSignals } from "./settlement-detector"

function makeFakeSignals(state: {
  hasActiveGroup?: boolean
  hasQueuedDispatches?: boolean
  hasRunningTurn?: boolean
}): SettlementSignals {
  return {
    hasActiveParallelGroup: () => state.hasActiveGroup ?? false,
    hasQueuedDispatches: () => state.hasQueuedDispatches ?? false,
    hasRunningTurn: () => state.hasRunningTurn ?? false,
  }
}

test("SettlementDetector emits settle after debounce when all signals false", async () => {
  const signals = makeFakeSignals({})
  const detector = new SettlementDetector(signals, { debounceMs: 50 })
  const events: string[] = []
  detector.on("settle", (p: { sessionGroupId: string }) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  assert.equal(events.length, 0, "should not fire immediately")
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(events, ["g1"])
  detector.dispose()
})

test("SettlementDetector cancels timer when signal changes during debounce", async () => {
  const state = { hasRunningTurn: false }
  const signals: SettlementSignals = {
    hasActiveParallelGroup: () => false,
    hasQueuedDispatches: () => false,
    hasRunningTurn: () => state.hasRunningTurn,
  }
  const detector = new SettlementDetector(signals, { debounceMs: 50 })
  const events: string[] = []
  detector.on("settle", (p: { sessionGroupId: string }) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  await new Promise((r) => setTimeout(r, 20))
  state.hasRunningTurn = true
  detector.notifyStateChange("g1")
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(events.length, 0, "must not fire because turn became active")
  detector.dispose()
})

test("SettlementDetector does not fire when any signal still true", async () => {
  const signals = makeFakeSignals({ hasRunningTurn: true })
  const detector = new SettlementDetector(signals, { debounceMs: 30 })
  const events: string[] = []
  detector.on("settle", (p: { sessionGroupId: string }) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(events.length, 0)
  detector.dispose()
})

test("SettlementDetector isSettledNow returns correct sync value", () => {
  let active = true
  const signals: SettlementSignals = {
    hasActiveParallelGroup: () => active,
    hasQueuedDispatches: () => false,
    hasRunningTurn: () => false,
  }
  const detector = new SettlementDetector(signals)
  assert.equal(detector.isSettledNow("g1"), false)
  active = false
  assert.equal(detector.isSettledNow("g1"), true)
  detector.dispose()
})

test("SettlementDetector tracks per-session timers independently", async () => {
  const signals = makeFakeSignals({})
  const detector = new SettlementDetector(signals, { debounceMs: 40 })
  const events: string[] = []
  detector.on("settle", (p: { sessionGroupId: string }) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  await new Promise((r) => setTimeout(r, 20))
  detector.notifyStateChange("g2")
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(events, ["g1"])
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(events, ["g1", "g2"])
  detector.dispose()
})

test("SettlementDetector cancel clears pending timer", async () => {
  const signals = makeFakeSignals({})
  const detector = new SettlementDetector(signals, { debounceMs: 50 })
  const events: string[] = []
  detector.on("settle", (p: { sessionGroupId: string }) => events.push(p.sessionGroupId))

  detector.notifyStateChange("g1")
  detector.cancel("g1")
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(events.length, 0)
  detector.dispose()
})
