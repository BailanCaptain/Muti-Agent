import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { resolveReviewerProvider } from "./reviewer-resolver"

describe("resolveReviewerProvider", () => {
  it("claude → codex for target=reviewer", () => {
    assert.equal(resolveReviewerProvider("claude", "reviewer"), "codex")
  })

  it("codex → claude for target=reviewer", () => {
    assert.equal(resolveReviewerProvider("codex", "reviewer"), "claude")
  })

  it("gemini → codex for target=reviewer", () => {
    assert.equal(resolveReviewerProvider("gemini", "reviewer"), "codex")
  })

  it("returns null for unknown target role", () => {
    assert.equal(resolveReviewerProvider("claude", "stranger"), null)
  })
})
