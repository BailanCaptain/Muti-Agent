import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"
import { MetricsService } from "./metrics-service"

describe("MetricsService", () => {
  let metrics: MetricsService

  beforeEach(() => {
    metrics = new MetricsService()
  })

  it("records and retrieves a counter metric", () => {
    metrics.increment("seal_count", { provider: "claude", threadId: "t1" })
    metrics.increment("seal_count", { provider: "claude", threadId: "t1" })
    const count = metrics.getCount("seal_count", { provider: "claude" })
    assert.equal(count, 2)
  })

  it("records and retrieves a gauge metric", () => {
    metrics.gauge("microcompact_tokens_saved", 5000, { threadId: "t1" })
    const last = metrics.getLastGauge("microcompact_tokens_saved", { threadId: "t1" })
    assert.equal(last, 5000)
  })

  it("returns 0 for unrecorded counter", () => {
    const count = metrics.getCount("nonexistent")
    assert.equal(count, 0)
  })

  it("returns null for unrecorded gauge", () => {
    const last = metrics.getLastGauge("nonexistent")
    assert.equal(last, null)
  })

  it("filters by tags", () => {
    metrics.increment("seal_count", { provider: "claude" })
    metrics.increment("seal_count", { provider: "gemini" })
    assert.equal(metrics.getCount("seal_count", { provider: "claude" }), 1)
    assert.equal(metrics.getCount("seal_count", { provider: "gemini" }), 1)
    assert.equal(metrics.getCount("seal_count"), 2)
  })

  it("getSnapshot returns all metrics", () => {
    metrics.increment("seal_count", { provider: "claude" })
    metrics.gauge("microcompact_tokens_saved", 3000)
    const snapshot = metrics.getSnapshot()
    assert.ok(snapshot.counters.length > 0)
    assert.ok(snapshot.gauges.length > 0)
  })
})
