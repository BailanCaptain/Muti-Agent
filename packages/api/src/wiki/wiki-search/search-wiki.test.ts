/**
 * F027 P15 · BM25 weighted + LLM rerank + SearchWikiProvider 端到端测试
 *
 * 覆盖：
 *   1. WikiEntityFtsProvider 加权 BM25（name 5x body）— 同 query 命中 name 应排前
 *   2. WikiEntityFtsProvider 自定义权重 — caller 传 ftsWeights 覆盖默认
 *   3. WikiEntityFtsProvider 兼容路径（无权重时退默认）
 *   4. NoopReranker 透传不改顺序 / 不改 score / 不砍 hit
 *   5. SearchWikiProvider overscan + rerank + 截 topK
 *   6. SearchWikiProvider 自定义 reranker（fixture reorder / drop）
 *   7. SearchWikiProvider 空召回 / 边界 topK
 */

import assert from "node:assert/strict"
import { promises as fsAsync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"
import { createDrizzleDb } from "../../db/drizzle-instance"
import * as schema from "../../db/schema"
import type { RecallHit } from "../memory-preflight/types"
import { NoopReranker } from "./llm-reranker"
import type { LLMReranker } from "./llm-reranker"
import { SearchWikiProvider } from "./search-wiki-provider"
import { WikiEntityFtsProvider } from "./wiki-entity-fts-provider"
import { reindexWikiEntities } from "./wiki-entity-indexer"

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "search-wiki-db-"))
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
  const root = mkdtempSync(path.join(tmpdir(), "search-wiki-fs-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function writeWikiFile(root: string, relPath: string, body: string): Promise<void> {
  const abs = path.join(root, relPath)
  await fsAsync.mkdir(path.dirname(abs), { recursive: true })
  await fsAsync.writeFile(abs, body, "utf8")
}

// ─────────────────────────────────────────────────────────────────────
// 1. WikiEntityFtsProvider 加权 BM25
// ─────────────────────────────────────────────────────────────────────

describe("WikiEntityFtsProvider weighted BM25 (P15)", () => {
  it("默认 name 5x：1 次 name 命中胜 1 次 body 命中（4-arg bm25 fix）", async () => {
    // 范-自检 P15 ：SQLite FTS5 bm25() 列权重按 schema 全部列顺序映射（含 UNINDEXED），
    // 之前只传 2 个 weight 被前 2 个 UNINDEXED 列吃掉，name/body 退默认 1.0 → weight
    // 完全不生效。本测试验证 4-arg 修复（bm25(table, 0.0, 0.0, name_w, body_w)）
    // 后默认 (5, 1) 真让 name 命中胜出。
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/concepts/drizzle-orm-guide.md",
        "Generic SQL ORM guide content without the magic word here.",
      )
      await writeWikiFile(
        root,
        "wiki/concepts/sql-libraries.md",
        "drizzle is one option among many SQL libraries.",
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      // 默认 nameWeight=5, bodyWeight=1
      const provider = new WikiEntityFtsProvider(db)
      const hits = provider.queryFts("drizzle", { topK: 5 })
      assert.equal(hits.length, 2)
      assert.equal(hits[0].path, "wiki/concepts/drizzle-orm-guide.md")
      assert.equal(hits[1].path, "wiki/concepts/sql-libraries.md")
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("weight 改变 BM25 raw rank（同 fixture 不同 weight → 不同 rank）", async () => {
    // 注：BM25 内部含 IDF + length normalization，列权重不是简单 score 乘法。
    // 本测试验证"权重真传到 SQL 影响 rank"，不验证某个具体排序结果（那受
    // tf/dl/avgdl 多因素影响，不是 caller 该期望的硬规则）。
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/concepts/drizzle-orm-guide.md",
        "Generic SQL ORM guide content without the magic word here.",
      )
      await writeWikiFile(
        root,
        "wiki/concepts/sql-libraries.md",
        "drizzle is one option among many SQL libraries.",
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      const equalProvider = new WikiEntityFtsProvider(db, { nameWeight: 1.0, bodyWeight: 1.0 })
      const namePreferProvider = new WikiEntityFtsProvider(db, {
        nameWeight: 10.0,
        bodyWeight: 1.0,
      })

      const equalHits = equalProvider.queryFts("drizzle", { topK: 5 })
      const namePreferHits = namePreferProvider.queryFts("drizzle", { topK: 5 })

      assert.equal(equalHits.length, 2)
      assert.equal(namePreferHits.length, 2)

      // weight 真起作用：drizzle-orm-guide.md（name 命中）的 raw rank 在 nameWeight=10
      // 时与 weight=1 时不一样（排序可能变 / score 一定不同）
      const equalRankByPath = new Map(equalHits.map((h) => [h.path, h.bm25Rank]))
      const preferRankByPath = new Map(namePreferHits.map((h) => [h.path, h.bm25Rank]))

      const guidePath = "wiki/concepts/drizzle-orm-guide.md"
      const equalGuideRank = equalRankByPath.get(guidePath) ?? 0
      const preferGuideRank = preferRankByPath.get(guidePath) ?? 0

      // 两次 raw bm25 rank 必须不等（证明 weight 真生效，不是默认 fallback）
      assert.notEqual(equalGuideRank, preferGuideRank)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("自定义 ftsWeights：body 权重高于 name 时排序翻转", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/drizzle-orm-guide.md", "Generic SQL guide content.")
      await writeWikiFile(
        root,
        "wiki/concepts/sql-libraries.md",
        "drizzle drizzle drizzle drizzle drizzle for SQLite.",
      )
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      // 反转权重：body 5x, name 1x — body 多 drizzle 的文件应排前
      const provider = new WikiEntityFtsProvider(db, { nameWeight: 1.0, bodyWeight: 5.0 })
      const hits = provider.queryFts("drizzle", { topK: 5 })
      assert.equal(hits.length, 2)
      assert.equal(hits[0].path, "wiki/concepts/sql-libraries.md")
      assert.equal(hits[1].path, "wiki/concepts/drizzle-orm-guide.md")
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("无穷大 / NaN 权重 fallback 默认 5.0/1.0", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/drizzle.md", "anything")
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      // NaN 应 fallback；不应 throw（fallback 内 toFixed 用 5.00/1.00）
      const provider = new WikiEntityFtsProvider(db, { nameWeight: NaN, bodyWeight: NaN })
      const hits = provider.queryFts("drizzle", { topK: 5 })
      assert.equal(hits.length, 1)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. NoopReranker
// ─────────────────────────────────────────────────────────────────────

describe("NoopReranker (P15 Phase 1 stub)", () => {
  it("透传：顺序 / score / count 全不变", async () => {
    const reranker = new NoopReranker()
    const hits: RecallHit[] = [
      { path: "a.md", score: 0.9, excerpt: "a" },
      { path: "b.md", score: 0.5, excerpt: "b" },
      { path: "c.md", score: 0.3, excerpt: "c" },
    ]
    const out = await reranker.rerank("test query", hits)
    assert.equal(out.length, 3)
    assert.equal(out[0].path, "a.md")
    assert.equal(out[1].path, "b.md")
    assert.equal(out[2].path, "c.md")
    assert.equal(out[0].score, 0.9)
  })

  it("空 hits 也透传不抛", async () => {
    const reranker = new NoopReranker()
    const out = await reranker.rerank("test", [])
    assert.equal(out.length, 0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. SearchWikiProvider
// ─────────────────────────────────────────────────────────────────────

describe("SearchWikiProvider (P15)", () => {
  it("BM25 overscan + Noop rerank + 截 topK", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      // 建 5 个含 drizzle 的文件（让 overscan 真有空间）
      for (let i = 0; i < 5; i++) {
        await writeWikiFile(
          root,
          `wiki/concepts/drizzle-${i}.md`,
          `drizzle file ${i} content with drizzle keyword`,
        )
      }
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      const fts = new WikiEntityFtsProvider(db)
      const provider = new SearchWikiProvider(fts) // 默认 NoopReranker
      const hits = await provider.search("drizzle", { topK: 3 })
      assert.equal(hits.length, 3)
      assert.ok(hits.every((h) => h.path.startsWith("wiki/concepts/drizzle-")))
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("自定义 reranker：可改顺序", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/a-drizzle.md", "drizzle content A")
      await writeWikiFile(root, "wiki/concepts/b-drizzle.md", "drizzle content B")
      await writeWikiFile(root, "wiki/concepts/c-drizzle.md", "drizzle content C")
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      // Reranker 把顺序反过来（用于验证 reranker 真的被调用）
      const reverser: LLMReranker = {
        async rerank(_q, hits) {
          return [...hits].reverse()
        },
      }
      const fts = new WikiEntityFtsProvider(db)
      const provider = new SearchWikiProvider(fts, reverser)

      // 不带 reranker 拿原顺序
      const baseline = await new SearchWikiProvider(fts).search("drizzle", { topK: 3 })
      // 带 reranker 拿翻转后顺序
      const reranked = await provider.search("drizzle", { topK: 3 })

      assert.equal(baseline.length, 3)
      assert.equal(reranked.length, 3)
      assert.equal(reranked[0].path, baseline[2].path)
      assert.equal(reranked[2].path, baseline[0].path)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("自定义 reranker：可砍 hit", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      for (let i = 0; i < 5; i++) {
        await writeWikiFile(root, `wiki/concepts/drizzle-${i}.md`, "drizzle keep or drop")
      }
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      // Reranker 只留前 2 个（模拟 LLM 判断剩下 3 个不相关）
      const filterer: LLMReranker = {
        async rerank(_q, hits) {
          return hits.slice(0, 2)
        },
      }
      const fts = new WikiEntityFtsProvider(db)
      const provider = new SearchWikiProvider(fts, filterer)
      const hits = await provider.search("drizzle", { topK: 5 })
      // caller 请求 topK=5，但 reranker 只留 2 → 应返回 2（不是 5）
      assert.equal(hits.length, 2)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("空召回（query 无命中）返 []", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/foo.md", "foo content")
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      const provider = new SearchWikiProvider(new WikiEntityFtsProvider(db))
      const hits = await provider.search("nonexistent-keyword-xyz", { topK: 5 })
      assert.equal(hits.length, 0)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("overscan 上限 maxOverscan 不爆炸", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      // 30 个文件
      for (let i = 0; i < 30; i++) {
        await writeWikiFile(root, `wiki/concepts/drizzle-${i}.md`, "drizzle entry")
      }
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      // maxOverscan=15，caller 请求 topK=10 → 内部 BM25 overscan 截到 15（不爆 30）
      const provider = new SearchWikiProvider(new WikiEntityFtsProvider(db), undefined, {
        maxOverscan: 15,
      })
      const hits = await provider.search("drizzle", { topK: 10 })
      // 最终 topK=10 由 caller 决定，rerank 透传后截 10
      assert.equal(hits.length, 10)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })

  it("topK=1 也有 minOverscan buffer（不退化为 1）", async () => {
    const { drizzle: db, cleanup } = makeDb()
    const { root, cleanup: cleanupRoot } = makeWikiRoot()
    try {
      for (let i = 0; i < 5; i++) {
        await writeWikiFile(root, `wiki/concepts/drizzle-${i}.md`, "drizzle file")
      }
      await reindexWikiEntities({ wikiRoot: root, db, buckets: ["concepts"] })

      // Reranker 看 hits.length 验证 overscan 起作用：topK=1 默认 overscan = max(1, 1*2+10) = 12
      let seenLen = 0
      const inspector: LLMReranker = {
        async rerank(_q, hits) {
          seenLen = hits.length
          return hits
        },
      }
      const provider = new SearchWikiProvider(new WikiEntityFtsProvider(db), inspector)
      const hits = await provider.search("drizzle", { topK: 1 })
      assert.equal(hits.length, 1)
      // overscan 起作用：reranker 看到 5 个（全部 drizzle 文件），不只 1
      assert.equal(seenLen, 5)
    } finally {
      cleanup()
      cleanupRoot()
    }
  })
})
