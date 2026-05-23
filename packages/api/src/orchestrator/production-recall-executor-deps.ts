import { randomUUID } from "node:crypto"

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"

import type * as schema from "../db/schema"
import type { EmbeddingService } from "../services/embedding-service"
import type { MessagesFtsRepository } from "../wiki/wiki-search"

import { createHaikuRunner, createSonnetRunner, type HaikuRunner } from "../runtime/haiku-runner"
import { createRunnerWithFallback } from "../runtime/runner-with-fallback"
import { LlmCritiqueAgent, type ClaudeRunner } from "../wiki/adaptive-recall/critique-agent"
import { FileSystemLevel4Backend } from "../wiki/adaptive-recall/level4-readwiki-backend"
import { MessagesFtsLevel3Backend } from "../wiki/adaptive-recall/level3-messages-backend"
import {
  NoopLevel5Sink,
  type AuditBroadcaster,
  type LeaderContextProvider,
  type MinimalLogger,
} from "../wiki/adaptive-recall/level5-escalate-sink"
import type { ExecutorDeps, Level5Sink } from "../wiki/adaptive-recall/types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

import { HybridSearchProvider } from "../wiki/memory-preflight/hybrid-search-provider"
import { WikiEntityBm25Adapter } from "../wiki/memory-preflight/wiki-entity-bm25-adapter"
import { WikiEntityFtsProvider } from "../wiki/wiki-search/wiki-entity-fts-provider"

import { Level2HybridSearchBackend } from "../wiki/adaptive-recall/level2-hybrid-search-backend"

/**
 * F027 P4 AC-P4-8 · production ExecutorDeps factory.
 *
 * 按 plan v5 §3 Week 1 Day 2-4 装配：
 *   - Day 2 a: critique = LlmCritiqueAgent(createSonnetRunner()) — Sonnet 4.6 (feature.md:155)
 *   - Day 2 b: level2 = Level2HybridSearchBackend(HybridSearchProvider(WikiEntityBm25Adapter, [], embedFn))
 *              [] empty embedded records: Phase 4 hybrid degenerates to BM25-only via fallback
 *              (hybrid-search-provider.ts:97-100); EmbeddedWikiRecord boot load 推 Phase 5/F028
 *   - Day 3 c: level3 = MessagesFtsLevel3Backend(messagesFtsRepo) — Phase 1 P14 ready
 *   - Day 3 d: level4 = FileSystemLevel4Backend({wikiRoot}) — Phase 1 P13 ready
 *   - Day 4 e: level5 = NoopLevel5Sink (Day 3 placeholder) → 升级 ProductionLevel5Sink at Day 4
 *
 * Caller pattern (server.ts Day 4 wire):
 *   const deps = createProductionRecallExecutorDeps({ drizzleDb, wikiRoot, messagesFtsRepo,
 *                                                     embeddingService, broadcaster })
 *   messages.setAdaptiveRecallCoordinator(new AdaptiveRecallCoordinator({
 *     enabled: true, executorDeps: deps, ...
 *   }))
 */

export interface ProductionRecallExecutorDepsOptions {
  drizzleDb: DrizzleDb
  wikiRoot: string
  messagesFtsRepo: MessagesFtsRepository
  embeddingService: EmbeddingService
  /** Audit broadcaster: 可选, 未传 → ProductionLevel5Sink 仅写 DB 不推 realtime. Day 4 wire 时用. */
  broadcaster?: AuditBroadcaster
  /** Level 5 sink: 可选注入 (Day 3 默认 NoopLevel5Sink, Day 4 替换 ProductionLevel5Sink). */
  level5?: Level5Sink
  /** Logger: ProductionLevel5Sink fail-soft 用. */
  logger?: MinimalLogger
  /** Sonnet runner: 测试注入. 默认 createSonnetRunner(). */
  sonnetRunner?: HaikuRunner
  /** Haiku fallback runner: 测试注入. 默认 createHaikuRunner(). codex Week 5 j2 FAIL P4-8(a) 修. */
  haikuFallbackRunner?: HaikuRunner
  /** 禁用 Haiku fallback (测试场景). 默认 false (启用 fallback). */
  disableFallback?: boolean
  /** Critique timeout ms. 默认 30000. */
  critiqueTimeoutMs?: number
}

export function createProductionRecallExecutorDeps(
  opts: ProductionRecallExecutorDepsOptions,
): ExecutorDeps {
  // ─── critique (Day 2 a) — codex Week 5 j2 FAIL P4-8(a) Red→Green: 加 Haiku 4.5 fallback
  // primary Sonnet 4.6 → quota/rate-limit/timeout 失败 → Haiku 4.5 retry
  // (per plan AC-P4-8 a: "fallback 不等价 PASS, 记 BLOCKED" — 见 runner-with-fallback.ts)
  const sonnetRunner = opts.sonnetRunner ?? createSonnetRunner()
  const critiqueRunner: HaikuRunner = opts.disableFallback
    ? sonnetRunner
    : createRunnerWithFallback({
        primary: sonnetRunner,
        fallback: opts.haikuFallbackRunner ?? createHaikuRunner(),
      })
  // HaikuRunner interface = ClaudeRunner structural (return shape same)
  const critique = new LlmCritiqueAgent(critiqueRunner as ClaudeRunner, {
    timeoutMs: opts.critiqueTimeoutMs ?? 30_000,
  })

  // ─── level 2 (Day 2 b) ───────────────────────────────────────────────────
  const wikiEntityFts = new WikiEntityFtsProvider(opts.drizzleDb)
  const bm25Adapter = new WikiEntityBm25Adapter(wikiEntityFts)
  const hybridSearch = new HybridSearchProvider(
    bm25Adapter,
    [], // Phase 4 empty embedded records; degenerate to BM25-only
    (text) => opts.embeddingService.generateEmbedding(text),
  )
  const level2 = new Level2HybridSearchBackend(hybridSearch)

  // ─── level 3 (Day 3 c) — Phase 1 P14 已 ready ─────────────────────────────
  const level3 = new MessagesFtsLevel3Backend(opts.messagesFtsRepo)

  // ─── level 4 (Day 3 d) — Phase 1 P13 已 ready ─────────────────────────────
  const level4 = new FileSystemLevel4Backend({ wikiRoot: opts.wikiRoot })

  // ─── level 5 (Day 3 placeholder → Day 4 ProductionLevel5Sink) ────────────
  // Day 3: NoopLevel5Sink 让 factory 可装配 + boot 测试可跑。
  // Day 4: caller 传 opts.level5 = new ProductionLevel5Sink({wikiEventsRepo, leaderContext, broadcaster}).
  const level5: Level5Sink = opts.level5 ?? new NoopLevel5Sink()

  return { critique, level2, level3, level4, level5 }
}

/**
 * 简单 LeaderContextProvider — Day 3 placeholder + Day 4 复用 (server.ts boot 注入 ProductionLevel5Sink 时).
 *
 * Notes (level5-escalate-sink.ts:62 注释):
 *   - 简单实现：term="999" + UUID fencing token
 *   - Phase 5+: 接 Compiler Leader Lease (compiler-leader-repository) 拿真 leader 信息
 *
 * 为什么 "999" 不是 "1":
 *   wiki_events 表 production trigger reject_stale_leader BEFORE INSERT 会 CAST(NEW.leader_term
 *   AS INTEGER) < compiler_leader.current_term。如果用 "1" 而 production leader 已推到 4/5/N，
 *   全部 escalate.appendPending 被 trigger ABORT 'stale leader_term'，
 *   ProductionLevel5Sink fail-soft swallow → wiki_events 无 recall_escalate row。
 *   "999" 在 Phase 5 接真 Compiler Leader Lease 前保证 escalate 写入永远不被 trigger 拒。
 *   [[feedback-test-schema-faithful-to-prod]] + Day 4 worktree-preview 实测踩坑。
 */
export function createSimpleLeaderContext(): LeaderContextProvider {
  return {
    currentLeaderTerm: () => "999",
    newFencingToken: () => randomUUID(),
  }
}
