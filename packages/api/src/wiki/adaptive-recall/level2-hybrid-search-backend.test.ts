import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RecallHit, SearchOptions } from "../memory-preflight/types"
import type { HybridSearchProvider } from "../memory-preflight/hybrid-search-provider"

import { Level2HybridSearchBackend } from "./level2-hybrid-search-backend"

/**
 * F027 P4 AC-P4-8 (b) · Level 2 thin adapter unit tests.
 */

function stubProvider(hits: RecallHit[]): {
  provider: HybridSearchProvider
  calls: Array<{ query: string; opts: SearchOptions }>
} {
  const calls: Array<{ query: string; opts: SearchOptions }> = []
  const provider = {
    async search(query: string, opts: SearchOptions): Promise<RecallHit[]> {
      calls.push({ query, opts })
      return hits
    },
  } as unknown as HybridSearchProvider
  return { provider, calls }
}

describe("Level2HybridSearchBackend", () => {
  it("(1) forwards (query, topK) → provider.search(query, {topK})", async () => {
    const { provider, calls } = stubProvider([
      { path: "wiki/concepts/F011.md", score: 0.82, excerpt: "F011 entity excerpt" },
      { path: "wiki/concepts/F018.md", score: 0.71, excerpt: "F018 entity excerpt" },
    ])
    const backend = new Level2HybridSearchBackend(provider)

    const hits = await backend.searchWiki("real-time", 5)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].query, "real-time")
    assert.deepEqual(calls[0].opts, { topK: 5 })
    assert.equal(hits.length, 2)
    assert.equal(hits[0].path, "wiki/concepts/F011.md")
    assert.equal(hits[0].score, 0.82)
  })

  it("(2) empty result passes through", async () => {
    const { provider } = stubProvider([])
    const backend = new Level2HybridSearchBackend(provider)

    const hits = await backend.searchWiki("nonsense xyz", 3)

    assert.equal(hits.length, 0)
  })

  it("(3) topK=1 forwards as topK:1 (no implicit min/max applied by adapter)", async () => {
    const { provider, calls } = stubProvider([{ path: "wiki/x.md", score: 0.5, excerpt: "x" }])
    const backend = new Level2HybridSearchBackend(provider)

    await backend.searchWiki("q", 1)

    assert.equal(calls[0].opts.topK, 1)
  })
})
