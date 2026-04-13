import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { cosineSimilarity, searchByEmbedding, type EmbeddingRecord } from "./embedding-service"

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = [1, 0, 0]
    const b = [1, 0, 0]
    assert.ok(Math.abs(cosineSimilarity(a, b) - 1.0) < 0.001)
  })

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.001)
  })

  it("returns -1 for opposite vectors", () => {
    const a = [1, 0, 0]
    const b = [-1, 0, 0]
    assert.ok(Math.abs(cosineSimilarity(a, b) + 1.0) < 0.001)
  })

  it("handles zero vectors gracefully", () => {
    const a = [0, 0, 0]
    const b = [1, 0, 0]
    assert.equal(cosineSimilarity(a, b), 0)
  })
})

describe("searchByEmbedding", () => {
  const records: EmbeddingRecord[] = [
    { messageId: "m1", threadId: "t1", chunkText: "架构设计讨论", embedding: [1, 0, 0], createdAt: "2026-04-13T09:00:00Z" },
    { messageId: "m2", threadId: "t1", chunkText: "bug 修复", embedding: [0, 1, 0], createdAt: "2026-04-13T10:00:00Z" },
    { messageId: "m3", threadId: "t1", chunkText: "测试编写", embedding: [0, 0, 1], createdAt: "2026-04-13T11:00:00Z" },
    { messageId: "m4", threadId: "t1", chunkText: "另一个架构话题", embedding: [0.9, 0.1, 0], createdAt: "2026-04-13T08:00:00Z" },
  ]

  it("returns top-k most similar records", () => {
    const query = [1, 0, 0]
    const results = searchByEmbedding(query, records, 2)
    assert.equal(results.length, 2)
    assert.equal(results[0].messageId, "m1")
    assert.equal(results[1].messageId, "m4")
  })

  it("applies time decay", () => {
    const query = [1, 0, 0]
    const results = searchByEmbedding(query, records, 4, 168)
    assert.ok(results[0].score >= results[1].score)
  })

  it("excludes messages in exclude set", () => {
    const query = [1, 0, 0]
    const exclude = new Set(["m1"])
    const results = searchByEmbedding(query, records, 2, undefined, exclude)
    assert.ok(!results.some((r) => r.messageId === "m1"))
    assert.equal(results[0].messageId, "m4")
  })

  it("returns empty for empty records", () => {
    const results = searchByEmbedding([1, 0, 0], [], 5)
    assert.equal(results.length, 0)
  })
})
