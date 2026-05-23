import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RecallHit, SearchOptions } from "./types"
import type { WikiEntityFtsProvider } from "../wiki-search/wiki-entity-fts-provider"

import { WikiEntityBm25Adapter } from "./wiki-entity-bm25-adapter"

/**
 * F027 P4 AC-P4-8 b · WikiEntityBm25Adapter unit tests.
 */

function stubProvider(hits: RecallHit[]): {
  provider: WikiEntityFtsProvider
  calls: Array<{ query: string; opts: SearchOptions }>
} {
  const calls: Array<{ query: string; opts: SearchOptions }> = []
  const provider = {
    async search(query: string, opts: SearchOptions): Promise<RecallHit[]> {
      calls.push({ query, opts })
      return hits
    },
  } as unknown as WikiEntityFtsProvider
  return { provider, calls }
}

describe("WikiEntityBm25Adapter", () => {
  it("(1) forwards search(query, opts) verbatim → WikiEntityFtsProvider", async () => {
    const { provider, calls } = stubProvider([
      { path: "wiki/concepts/F011.md", score: 0.82, excerpt: "F011 entity excerpt" },
    ])
    const adapter = new WikiEntityBm25Adapter(provider)

    const hits = await adapter.search("real-time", { topK: 5, scope: "concepts" })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].query, "real-time")
    assert.deepEqual(calls[0].opts, { topK: 5, scope: "concepts" })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].path, "wiki/concepts/F011.md")
  })

  it("(2) empty result passes through", async () => {
    const { provider } = stubProvider([])
    const adapter = new WikiEntityBm25Adapter(provider)

    const hits = await adapter.search("nonsense", { topK: 3 })

    assert.equal(hits.length, 0)
  })

  it("(3) no scope option forwards correctly (default 'all' handled by provider)", async () => {
    const { provider, calls } = stubProvider([{ path: "wiki/x.md", score: 0.5, excerpt: "x" }])
    const adapter = new WikiEntityBm25Adapter(provider)

    await adapter.search("q", { topK: 10 })

    assert.equal(calls[0].opts.topK, 10)
    assert.equal(calls[0].opts.scope, undefined)
  })
})
