/**
 * F042 AC6 Task 17 · 快链接线专项
 *
 * 覆盖：
 *   1. coordinator directDeps 优先于 executorDeps（旧 executor 零调用——同步链去 LLM）
 *   2. directDeps 管道抛错 → fail-soft passthrough（不击穿消息主链）
 *   3. resolveDirectTurnRecall 注入 gate：executed 且 !recallSatisfied → 不组装 Recall Pack
 *   4. createDirectRecallDeps 工厂：wiki 侧真 DB 端到端 + messages 侧空库冒烟
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync, promises as fsAsync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"

import { createDrizzleDb } from "../db/drizzle-instance"
import * as schema from "../db/schema"
import { resolveDirectTurnRecall } from "../services/message-service"
import type { RecallHit } from "../wiki/memory-preflight/types"
import { compileRecallFtsQuery } from "../wiki/wiki-search/fts-query-compiler"
import { MessagesFtsRepository } from "../wiki/wiki-search/messages-fts-repository"
import { reindexWikiEntities } from "../wiki/wiki-search/wiki-entity-indexer"
import { AdaptiveRecallCoordinator } from "./adaptive-recall-coordinator"
import { createDirectRecallDeps } from "./production-recall-executor-deps"

function gatedHit(p: string): RecallHit {
  return {
    path: p,
    score: 1,
    excerpt: "…",
    evidence: {
      matchedClauseCount: 3,
      totalClauseCount: 6,
      clauseCoverage: 0.5,
      matchedOrClauseCount: 3,
      exactEntityMatch: false,
      exactPathMatch: false,
    },
  }
}

describe("coordinator directDeps 快链（Task 17）", () => {
  it("directDeps 存在 → 走快链；旧 executor 零调用（ADR-005 同步链去 LLM）", async () => {
    let oldExecutorCalls = 0
    const coordinator = new AdaptiveRecallCoordinator({
      enabled: true,
      triggerScenarios: ["direct_turn"],
      directDeps: {
        searchWiki: async () => [gatedHit("wiki/rules/probe.md")],
        searchMessages: async () => [],
      },
      // 类型上仍可传 executor —— 断言它被短路
      executor: (async () => {
        oldExecutorCalls++
        throw new Error("must not be called")
      }) as never,
      executorDeps: {} as never,
    })
    const res = await coordinator.executeIfNeeded({
      roomId: "r1",
      alias: "黄仁勋",
      scenario: "direct_turn",
      trigger: "direct_turn",
      query: "探针协议的核心规则有几条？",
    })
    assert.equal(oldExecutorCalls, 0)
    assert.equal(res.executed, true)
    assert.equal(res.reason, "ok")
    assert.equal(res.output?.recallPath, 2)
    assert.equal(res.output?.critiqueCalls, 0)
    assert.equal(res.hits.length, 1)
  })

  it("快链抛错 → fail-soft passthrough（executor_error，不击穿主链）", async () => {
    const coordinator = new AdaptiveRecallCoordinator({
      enabled: true,
      triggerScenarios: ["direct_turn"],
      directDeps: {
        searchWiki: async () => {
          throw new TypeError("boom")
        },
        searchMessages: async () => {
          throw new TypeError("boom")
        },
      },
    })
    // pipeline 内部 backend fail-soft —— 两级全错也回正常 miss（不是 coordinator error）
    const res = await coordinator.executeIfNeeded({
      roomId: "r1",
      alias: "黄仁勋",
      scenario: "direct_turn",
      trigger: "direct_turn",
      query: "探针协议的核心规则有几条？",
    })
    assert.equal(res.executed, true)
    assert.equal(res.output?.recallSatisfied, false)
    assert.deepEqual([...res.hits], [])
  })
})

describe("resolveDirectTurnRecall 注入 gate（德彪 1.3）", () => {
  it("executed 且 recallSatisfied=false（miss/gate 全拒）→ memoryPreflight=null", async () => {
    const fake = {
      executeIfNeeded: async () => ({
        executed: true,
        reason: "ok" as const,
        hits: [] as RecallHit[],
        output: {
          recallPath: 3 as const,
          recallSatisfied: false,
          hits: [],
          totalMs: 5,
          critiqueCalls: 0,
          budgetExceeded: false,
          attempts: [],
        },
      }),
    }
    const { memoryPreflight } = await resolveDirectTurnRecall(fake as never, {
      roomId: "r1",
      alias: "黄仁勋",
      scenario: "direct_turn",
      query: "无关话题",
    })
    assert.equal(memoryPreflight, null)
  })

  it("executed 且 recallSatisfied=true → 组装 Recall Pack", async () => {
    const fake = {
      executeIfNeeded: async () => ({
        executed: true,
        reason: "ok" as const,
        hits: [gatedHit("wiki/rules/probe.md")],
        output: {
          recallPath: 2 as const,
          recallSatisfied: true,
          hits: [gatedHit("wiki/rules/probe.md")],
          totalMs: 5,
          critiqueCalls: 0,
          budgetExceeded: false,
          attempts: [],
        },
      }),
    }
    const { memoryPreflight } = await resolveDirectTurnRecall(fake as never, {
      roomId: "r1",
      alias: "黄仁勋",
      scenario: "direct_turn",
      query: "探针协议",
    })
    assert.ok(memoryPreflight)
    assert.equal(memoryPreflight.hits.length, 1)
  })
})

describe("createDirectRecallDeps 工厂（真 DB 冒烟）", () => {
  it("wiki 侧端到端命中带 evidence；messages 侧空库返 []", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "direct-deps-db-"))
    const wikiRoot = mkdtempSync(path.join(tmpdir(), "direct-deps-fs-"))
    const { raw, close } = createDrizzleDb(path.join(dir, "t.sqlite"))
    const db = drizzleBetter(raw as never, { schema })
    try {
      const abs = path.join(wikiRoot, "wiki/rules/f042-probe.md")
      await fsAsync.mkdir(path.dirname(abs), { recursive: true })
      await fsAsync.writeFile(abs, "守活探针协议：核心规则共四条，维护模式静默。", "utf8")
      await reindexWikiEntities({ wikiRoot, db, buckets: ["rules"] })

      const deps = createDirectRecallDeps({
        drizzleDb: db,
        messagesFtsRepo: new MessagesFtsRepository(db),
      })
      const compiled = compileRecallFtsQuery("探针协议的核心规则有几条？")
      const wikiHits = await deps.searchWiki(compiled, 5)
      assert.ok(wikiHits.length >= 1)
      assert.ok(wikiHits[0].evidence)
      assert.ok(wikiHits[0].evidence.matchedClauseCount >= 2)

      const msgHits = await deps.searchMessages(compiled, "R-001", 5)
      assert.deepEqual(msgHits, [])
    } finally {
      close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(wikiRoot, { recursive: true, force: true })
    }
  })
})
