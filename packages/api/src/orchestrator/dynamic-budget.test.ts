import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { computeDynamicLimits } from "./dynamic-budget"

describe("computeDynamicLimits", () => {
  it("returns relaxed limits when fillRatio < 0.3", () => {
    const limits = computeDynamicLimits(0.2)
    assert.equal(limits.sharedHistoryLimit, 60)
    assert.equal(limits.selfHistoryLimit, 30)
    assert.equal(limits.maxContentLength, 4000)
  })

  it("returns moderate limits when fillRatio 0.3-0.5", () => {
    const limits = computeDynamicLimits(0.4)
    assert.equal(limits.sharedHistoryLimit, 40)
    assert.equal(limits.selfHistoryLimit, 20)
    assert.equal(limits.maxContentLength, 3000)
  })

  it("returns default limits when fillRatio 0.5-0.7", () => {
    const limits = computeDynamicLimits(0.6)
    assert.equal(limits.sharedHistoryLimit, 30)
    assert.equal(limits.selfHistoryLimit, 15)
    assert.equal(limits.maxContentLength, 2000)
  })

  it("returns tight limits when fillRatio > 0.7", () => {
    const limits = computeDynamicLimits(0.8)
    assert.equal(limits.sharedHistoryLimit, 15)
    assert.equal(limits.selfHistoryLimit, 8)
    assert.equal(limits.maxContentLength, 1000)
  })

  it("returns default limits for NaN fillRatio", () => {
    const limits = computeDynamicLimits(NaN)
    assert.equal(limits.sharedHistoryLimit, 30)
    assert.equal(limits.selfHistoryLimit, 15)
    assert.equal(limits.maxContentLength, 2000)
  })

  it("returns default limits for negative fillRatio", () => {
    const limits = computeDynamicLimits(-0.1)
    assert.equal(limits.sharedHistoryLimit, 60)
    assert.equal(limits.selfHistoryLimit, 30)
    assert.equal(limits.maxContentLength, 4000)
  })

  it("handles boundary at 0.3 exactly", () => {
    const limits = computeDynamicLimits(0.3)
    assert.equal(limits.sharedHistoryLimit, 40)
  })

  it("handles boundary at 0.7 exactly", () => {
    const limits = computeDynamicLimits(0.7)
    assert.equal(limits.sharedHistoryLimit, 15)
  })
})
