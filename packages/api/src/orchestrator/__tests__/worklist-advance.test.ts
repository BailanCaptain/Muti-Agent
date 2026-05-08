/**
 * F026 Phase 2 Task B · planWorklistAdvance (I2-b)
 *
 * Pure decision function: given a worklist snapshot + a child invocation's
 * completion, decide what the executor should do next within the same
 * routeSerial. No new invocations are produced here — that is the whole
 * point of worklist-advance, and the foundation of R-184 root-fix (I2-a).
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  type WorklistAdvanceInput,
  type WorklistAdvanceResult,
  type WorklistItem,
  planWorklistAdvance,
} from "../worklist-advance"

function mkItems(aliases: string[]): WorklistItem[] {
  return aliases.map((alias, i) => ({
    invocationId: `inv-${i}`,
    alias,
    status: "pending",
  }))
}

function mkInput(overrides: Partial<WorklistAdvanceInput>): WorklistAdvanceInput {
  return {
    routeSerial: "rs-1",
    items: mkItems(["A", "B", "C"]),
    completedIndex: 0,
    childResult: { ok: true, content: "child content" },
    ...overrides,
  }
}

describe("planWorklistAdvance", () => {
  it("advance · next item when completedIndex + 1 in range and child ok with content", () => {
    const result: WorklistAdvanceResult = planWorklistAdvance(mkInput({}))
    assert.equal(result.kind, "advance")
    if (result.kind !== "advance") return
    assert.equal(result.nextIndex, 1)
    assert.equal(result.nextItem.alias, "B")
    assert.equal(result.nextItem.invocationId, "inv-1")
  })

  it("done · completedIndex points at final item and child ok", () => {
    const result = planWorklistAdvance(mkInput({ completedIndex: 2 }))
    assert.equal(result.kind, "done")
    if (result.kind !== "done") return
    assert.equal(result.finalIndex, 2)
  })

  it("halt · child failed — do not advance, do not resurrect", () => {
    const result = planWorklistAdvance(mkInput({ childResult: { ok: false, content: "boom" } }))
    assert.equal(result.kind, "halt")
    if (result.kind !== "halt") return
    assert.equal(result.reason, "child-failed")
  })

  it("halt · child ok but empty content (R-185 guard) — do not advance", () => {
    const result = planWorklistAdvance(mkInput({ childResult: { ok: true, content: "   " } }))
    assert.equal(result.kind, "halt")
    if (result.kind !== "halt") return
    assert.equal(result.reason, "empty-content")
  })

  it("halt · completedIndex out of bounds — defensive stop, no advance", () => {
    const result = planWorklistAdvance(mkInput({ completedIndex: 5 }))
    assert.equal(result.kind, "halt")
    if (result.kind !== "halt") return
    assert.equal(result.reason, "index-oob")
  })

  it("halt · completedIndex negative — defensive stop", () => {
    const result = planWorklistAdvance(mkInput({ completedIndex: -1 }))
    assert.equal(result.kind, "halt")
    if (result.kind !== "halt") return
    assert.equal(result.reason, "index-oob")
  })

  it("halt · empty items list — no work to advance", () => {
    const result = planWorklistAdvance(mkInput({ items: [], completedIndex: 0 }))
    assert.equal(result.kind, "halt")
    if (result.kind !== "halt") return
    assert.equal(result.reason, "index-oob")
  })

  it("pure · does not mutate input items", () => {
    const input = mkInput({})
    const snapshot = JSON.stringify(input.items)
    planWorklistAdvance(input)
    assert.equal(JSON.stringify(input.items), snapshot)
  })
})
