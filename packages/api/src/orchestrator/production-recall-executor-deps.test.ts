import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { HaikuRunner } from "../runtime/haiku-runner"
import { LlmCritiqueAgent } from "../wiki/adaptive-recall/critique-agent"
import { Level2HybridSearchBackend } from "../wiki/adaptive-recall/level2-hybrid-search-backend"
import { MessagesFtsLevel3Backend } from "../wiki/adaptive-recall/level3-messages-backend"
import { FileSystemLevel4Backend } from "../wiki/adaptive-recall/level4-readwiki-backend"
import { NoopLevel5Sink } from "../wiki/adaptive-recall/level5-escalate-sink"

import {
  createProductionRecallExecutorDeps,
  createSimpleLeaderContext,
} from "./production-recall-executor-deps"

/**
 * F027 P4 AC-P4-8 (Day 3 packaging) · production ExecutorDeps factory unit tests.
 *
 * 验:
 *   (1) factory 返回 critique/level2/level3/level4/level5 全 5 字段，类型一致
 *   (2) sonnetRunner / level5 / logger / critiqueTimeoutMs 可注入 (测试用)
 *   (3) level5 默认 NoopLevel5Sink (Day 3 placeholder), 可由 opts.level5 覆盖
 *   (4) createSimpleLeaderContext: term="1" + 每次 newFencingToken 唯一
 */

function fakeRunner(): HaikuRunner {
  return {
    async runPrompt() {
      return { ok: true, text: "{}", durationMs: 10 }
    },
  }
}

function fakeEmbeddingService(): { generateEmbedding: (t: string) => Promise<number[] | null> } {
  return {
    async generateEmbedding() {
      return null
    },
  }
}

describe("createProductionRecallExecutorDeps", () => {
  it("(1) returns all 5 executor deps with correct classes", () => {
    const deps = createProductionRecallExecutorDeps({
      drizzleDb: {} as never,
      wikiRoot: "/tmp/wiki",
      messagesFtsRepo: {} as never,
      embeddingService: fakeEmbeddingService() as never,
      sonnetRunner: fakeRunner(),
    })

    assert.ok(deps.critique instanceof LlmCritiqueAgent)
    assert.ok(deps.level2 instanceof Level2HybridSearchBackend)
    assert.ok(deps.level3 instanceof MessagesFtsLevel3Backend)
    assert.ok(deps.level4 instanceof FileSystemLevel4Backend)
    assert.ok(deps.level5 instanceof NoopLevel5Sink, "Day 3 default level5 should be NoopLevel5Sink")
  })

  it("(2) sonnetRunner injection works (test can stub)", () => {
    const stubRunner = fakeRunner()
    const deps = createProductionRecallExecutorDeps({
      drizzleDb: {} as never,
      wikiRoot: "/tmp/wiki",
      messagesFtsRepo: {} as never,
      embeddingService: fakeEmbeddingService() as never,
      sonnetRunner: stubRunner,
    })

    // critique constructed without error (using fake runner instead of real CLI)
    assert.ok(deps.critique)
  })

  it("(3) opts.level5 override works (Day 4 wire: replace with ProductionLevel5Sink)", () => {
    let broadcasted = 0
    const customSink = {
      escalate: async () => {
        broadcasted++
      },
    }
    const deps = createProductionRecallExecutorDeps({
      drizzleDb: {} as never,
      wikiRoot: "/tmp/wiki",
      messagesFtsRepo: {} as never,
      embeddingService: fakeEmbeddingService() as never,
      sonnetRunner: fakeRunner(),
      level5: customSink,
    })

    assert.equal(deps.level5, customSink, "should use injected level5")
    assert.notEqual(deps.level5 instanceof NoopLevel5Sink, true)
  })
})

describe("createSimpleLeaderContext", () => {
  it("(4) returns const term='1' + unique fencing tokens", () => {
    const ctx = createSimpleLeaderContext()

    assert.equal(ctx.currentLeaderTerm(), "1")
    assert.equal(ctx.currentLeaderTerm(), "1") // stable

    const t1 = ctx.newFencingToken()
    const t2 = ctx.newFencingToken()
    assert.notEqual(t1, t2, "fencing tokens should be unique")
    assert.match(t1, /^[0-9a-f-]+$/i, "UUID format")
  })
})

