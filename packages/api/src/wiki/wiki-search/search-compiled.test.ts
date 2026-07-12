/**
 * F042 AC6 Task 15 · WikiEntityFtsProvider.searchCompiled（命中证据 + snippet excerpt）
 *
 * 覆盖：
 *   1. 中文自然句端到端命中（compileRecallFtsQuery → searchCompiled）——恒空主根因的修复验证
 *   2. evidence 计数/coverage/exactEntityMatch 正确性
 *   3. snippet：命中词在正文深处（>200 char）时 excerpt 必含命中证据（旧 slice(0,200) 病灶）
 *   4. name-only 命中 → excerpt 兜底不崩
 *   5. unsupported compiled → []
 */

import assert from "node:assert/strict"
import { promises as fsAsync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"
import { createDrizzleDb } from "../../db/drizzle-instance"
import * as schema from "../../db/schema"
import { evidenceGate } from "../adaptive-recall/direct-recall-pipeline"
import { compileRecallFtsQuery } from "./fts-query-compiler"
import { WikiEntityFtsProvider } from "./wiki-entity-fts-provider"
import { reindexWikiEntities } from "./wiki-entity-indexer"

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "search-compiled-db-"))
  const dbPath = path.join(dir, "test.sqlite")
  const { raw, close } = createDrizzleDb(dbPath)
  const drizzleDb = drizzleBetter(raw as never, { schema })
  return {
    drizzle: drizzleDb,
    cleanup: () => {
      close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function makeWikiRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "search-compiled-fs-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function writeWikiFile(root: string, relPath: string, body: string): Promise<void> {
  const abs = path.join(root, relPath)
  await fsAsync.mkdir(path.dirname(abs), { recursive: true })
  await fsAsync.writeFile(abs, body, "utf8")
}

describe("searchCompiled · F042 AC6", () => {
  it("中文自然问句端到端命中（旧 sanitize 恒空 query 的修复对照）", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/rules/f042-acceptance-probe.md",
        "守活探针协议：核心规则共四条。探针每 20 分钟探一次 /health，失败即报警；维护模式静默。",
      )
      await writeWikiFile(
        root,
        "wiki/rules/unrelated-topic.md",
        "完全无关的另一篇：讲飞书群绑定与消息路由的实现细节。",
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["rules"] })

      const provider = new WikiEntityFtsProvider(db)
      const compiled = compileRecallFtsQuery("异步验证：探针协议的核心规则有几条？")
      const hits = await provider.searchCompiled(compiled, { topK: 5 })

      assert.ok(hits.length >= 1, "中文自然句必须能召回（恒空修复）")
      assert.equal(hits[0].path, "wiki/rules/f042-acceptance-probe.md")
      const ev = hits[0].evidence
      assert.ok(ev, "searchCompiled 必须带 evidence")
      assert.ok(ev.matchedClauseCount >= 2, `至少 2 clause 命中，得 ${ev.matchedClauseCount}`)
      assert.equal(ev.totalClauseCount, compiled.mustClauses.length + compiled.orClauses.length)
      assert.ok(ev.clauseCoverage > 0 && ev.clauseCoverage <= 1)
      assert.equal(ev.exactEntityMatch, false, "无实体信号时不得虚标 entity match")
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("实体 MUST 命中 → exactEntityMatch=true", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/work/F042-memory-loop.md",
        "F042 记忆消费闭环：direct_turn shadow 召回与采纳度量的实施记录。",
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["work"] })

      const provider = new WikiEntityFtsProvider(db)
      const compiled = compileRecallFtsQuery("F042 召回怎么修")
      const hits = await provider.searchCompiled(compiled, { topK: 5 })

      assert.ok(hits.length >= 1)
      assert.equal(hits[0].evidence?.exactEntityMatch, true)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("命中词在正文深处 → excerpt 是命中窗 snippet 而非开头 200 字（德彪风险点）", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      const filler = "这是一段与查询完全无关的开场白。".repeat(20) // ~320 chars
      await writeWikiFile(
        root,
        "wiki/methods/deep-content.md",
        `${filler}真正的关键内容：熔断预算矛盾的修复方法在这里。`,
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["methods"] })

      const provider = new WikiEntityFtsProvider(db)
      const compiled = compileRecallFtsQuery("熔断预算矛盾怎么处理")
      const hits = await provider.searchCompiled(compiled, { topK: 5 })

      assert.ok(hits.length >= 1)
      assert.match(hits[0].excerpt, /熔断预算/, "excerpt 必须含命中证据，不是无关开头")
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("unsupported compiled → 直接空结果", async () => {
    const { drizzle: db, cleanup } = makeDb()
    try {
      const provider = new WikiEntityFtsProvider(db)
      const hits = await provider.searchCompiled(compileRecallFtsQuery("你好"), { topK: 5 })
      assert.deepEqual(hits, [])
    } finally {
      cleanup()
    }
  })

  it("德彪 AC6-r1 P1-2 对抗：6 篇实体噪声 + 1 目标 → optional-boost 重排目标第一，噪声零 OR 可辨", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      for (let i = 1; i <= 6; i++) {
        await writeWikiFile(
          root,
          `wiki/work/F042-noise-${i}.md`,
          `F042 F042 F042 相关流水账 ${i}：巡检记录与例行同步，F042 例会纪要归档。`,
        )
      }
      await writeWikiFile(
        root,
        "wiki/work/F042-target.md",
        "F042 召回管道正确修复：查询编译器与证据门的实施要点。",
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["work"] })

      const provider = new WikiEntityFtsProvider(db)
      const compiled = compileRecallFtsQuery("F042 召回管道怎么修")
      const hits = await provider.searchCompiled(compiled, { topK: 5 })

      assert.ok(hits.length >= 1)
      assert.equal(hits[0].path, "wiki/work/F042-target.md", "目标必须重排到第一（不被噪声截掉）")
      assert.ok((hits[0].evidence?.matchedOrClauseCount ?? 0) >= 1)
      for (const h of hits.slice(1)) {
        assert.equal(h.evidence?.matchedOrClauseCount, 0, "噪声零 OR——gate 层将淘汰")
      }
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("德彪 AC6-r2 P1 端到端对抗：点名文档（正文无内容词）+ decoy（含内容词）→ gate 只留点名文档", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/concepts/foo-bar.md",
        "被点名的文档：正文讲别的概念，完全不含查询内容词。",
      )
      await writeWikiFile(
        root,
        "wiki/concepts/decoy.md",
        "无关文档：通篇大谈缓存策略，缓存策略的各种细节。",
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      const provider = new WikiEntityFtsProvider(db)
      const compiled = compileRecallFtsQuery("wiki/concepts/foo-bar.md 缓存策略")
      const hits = await provider.searchCompiled(compiled, { topK: 5 })
      const gated = evidenceGate(hits, { pathMustsPresent: compiled.pathMusts.length > 0 })
      assert.deepEqual(
        gated.map((h) => h.path),
        ["wiki/concepts/foo-bar.md"],
        "用户点名的文档必须注入；含内容词的 decoy 不得顶替",
      )
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("德彪 AC6-r3 P1 · 多 path 点名时，每篇匹配自己的 path 并通过 gate", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/a.md", "甲文档正文。")
      await writeWikiFile(root, "wiki/concepts/b.md", "乙文档正文。")
      await writeWikiFile(root, "wiki/concepts/decoy.md", "差异差异差异，无关内容。")
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      const provider = new WikiEntityFtsProvider(db)
      const compiled = compileRecallFtsQuery(
        "对比下 wiki/concepts/a.md 和 wiki/concepts/b.md 的差异",
      )
      assert.deepEqual(compiled.pathMusts, ["wiki/concepts/a.md", "wiki/concepts/b.md"])

      const hits = await provider.searchCompiled(compiled, { topK: 5 })
      const gated = evidenceGate(hits, { pathMustsPresent: true })
      assert.deepEqual(
        gated.map((h) => h.path),
        ["wiki/concepts/a.md", "wiki/concepts/b.md"],
      )
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("德彪 AC6-r2 P2 · lookupByPaths 尊重 includeDrafts/scope/topK 契约", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/shared/dup-tail.md", "concepts 桶里的一篇。")
      await writeWikiFile(root, "wiki/work/shared/dup-tail.md", "work 桶里同尾缀的一篇。")
      await writeWikiFile(root, "wiki/concepts/draft/_auto/pending.md", "draft 区待审。")
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts", "work"] })

      // scope 过滤：同尾缀两桶，scope=concepts 只回 concepts
      const strict = new WikiEntityFtsProvider(db)
      const compiledDup = compileRecallFtsQuery("看下 shared/dup-tail.md")
      assert.deepEqual(compiledDup.pathMusts, ["shared/dup-tail.md"], "fixture 必须进入 path lookup")
      const scoped = await strict.searchCompiled(compiledDup, { topK: 5, scope: "concepts" })
      assert.deepEqual(
        scoped.map((h) => h.path),
        ["wiki/concepts/shared/dup-tail.md"],
      )
      // topK cap：不限 scope 时同尾缀两条，topK=1 只回一条
      const capped = await strict.searchCompiled(compiledDup, { topK: 1 })
      assert.equal(capped.length, 1)
      // includeDrafts：默认查不到 draft path；开启后查得到
      const compiledDraft = compileRecallFtsQuery("看下 concepts/draft/_auto/pending.md")
      const noDraft = await strict.searchCompiled(compiledDraft, { topK: 5 })
      assert.deepEqual(noDraft, [])
      const loose = new WikiEntityFtsProvider(db, { includeDrafts: true })
      const withDraft = await loose.searchCompiled(compiledDraft, { topK: 5 })
      assert.equal(withDraft.length, 1)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("德彪 AC6-r3 P2 · pathHits 与 FTS hits 合并后仍遵守最终 topK", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/named.md", "点名文档正文不含检索词。")
      await writeWikiFile(root, "wiki/concepts/fts-only.md", "缓存策略缓存策略缓存策略。")
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      const provider = new WikiEntityFtsProvider(db)
      const compiled = compileRecallFtsQuery("wiki/concepts/named.md 缓存策略")
      assert.deepEqual(compiled.pathMusts, ["wiki/concepts/named.md"])

      const hits = await provider.searchCompiled(compiled, { topK: 1 })
      assert.equal(hits.length, 1)
      assert.equal(hits[0].path, "wiki/concepts/named.md", "点名 path 保持合并优先级")
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("德彪 AC6-r1 P2-3 · 纯 path 查询走结构化过滤（UNINDEXED 列不 MATCH）", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/concepts/foo-bar.md",
        "一篇正文完全不重复自己路径的文档：讲某个概念。",
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      const provider = new WikiEntityFtsProvider(db)
      const compiled = compileRecallFtsQuery("看下 concepts/foo-bar.md 的内容")
      assert.deepEqual(compiled.pathMusts, ["concepts/foo-bar.md"])
      const hits = await provider.searchCompiled(compiled, { topK: 5 })
      assert.equal(hits.length, 1)
      assert.equal(hits[0].path, "wiki/concepts/foo-bar.md")
      assert.equal(hits[0].evidence?.exactEntityMatch, true)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })
})
