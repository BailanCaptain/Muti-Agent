import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { detectFBloat } from "./fbloat-detector"

describe("detectFBloat", () => {
  it("detects bloat when tokens drop > 40%", () => {
    const result = detectFBloat(100000, 50000)
    assert.equal(result.detected, true)
    assert.ok(result.dropRatio > 0.4)
  })

  it("does not detect bloat when drop is < 40%", () => {
    const result = detectFBloat(100000, 70000)
    assert.equal(result.detected, false)
  })

  it("does not detect bloat when tokens increase", () => {
    const result = detectFBloat(50000, 100000)
    assert.equal(result.detected, false)
  })

  it("handles zero prevTokens", () => {
    const result = detectFBloat(0, 50000)
    assert.equal(result.detected, false)
  })

  it("handles equal tokens", () => {
    const result = detectFBloat(100000, 100000)
    assert.equal(result.detected, false)
  })

  it("detects exact 40% drop boundary", () => {
    const result = detectFBloat(100000, 60000)
    assert.equal(result.detected, false)
  })

  it("detects just over 40% drop", () => {
    const result = detectFBloat(100000, 59999)
    assert.equal(result.detected, true)
  })
})
