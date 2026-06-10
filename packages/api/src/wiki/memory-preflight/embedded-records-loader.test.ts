/**
 * F027 续 · EmbeddedWikiRecordsLoader 测试 — 语义召回转正(boot-load)
 *
 * 覆盖：
 *   1. 空 wiki_entity_index → []（不调 generateEmbedding）
 *   2. N 行 → 每行 embed(name + body 截断)，返 WikiEntityRecord[]（path/body/embedding/sourceHash）
 *   3. generateEmbedding 返 null / 抛错 → 该行跳过（failed 计数），其余行不受影响
 *   4. 二次 load 同 source_hash → 复用缓存不重算（reused 计数）；hash 变 → 重算
 *   5. 行删除 → 结果不含 + 缓存清理（第三次 load 不会复用已删行）
 *   6. HybridSearchProvider.replaceEmbeddedRecords：空 records BM25-only → 热替换后 cosine 融合生效
 */

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"
import { eq } from "drizzle-orm"
import { createDrizzleDb } from "../../db/drizzle-instance"
import * as schema from "../../db/schema"
import { wikiEntityIndex } from "../../db/schema"
import { EmbeddedWikiRecordsLoader } from "./embedded-records-loader"
import { HybridSearchProvider, type BM25CandidateProvider } from "./hybrid-search-provider"
import type { RecallHit, SearchOptions } from "./types"

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "embedded-records-loader-"))
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

function insertEntity(
  db: ReturnType<typeof makeDb>["drizzle"],
  row: { path: string; name: string; body: string; sourceHash: string },
): void {
  db.insert(wikiEntityIndex)
    .values({
      path: row.path,
      bucket: row.path.split("/")[1] ?? "concepts",
      name: row.name,
      body: row.body,
      sourceHash: row.sourceHash,
      mtimeMs: 1,
      indexedAt: "2026-06-10T00:00:00Z",
    })
    .run()
}

/** 确定性 fake embedder：记录调用文本；vec = [len % 7, 1]，"null:" 前缀 → null，"throw:" 前缀 → 抛。 */
function makeEmbedder() {
  const calls: string[] = []
  const fn = async (text: string): Promise<number[] | null> => {
    calls.push(text)
    if (text.startsWith("null:")) return null
    if (text.startsWith("throw:")) throw new Error("embedder boom")
    return [text.length % 7, 1]
  }
  return { fn, calls }
}

describe("EmbeddedWikiRecordsLoader", () => {
  it("空表 → [] 且不调 generateEmbedding", async () => {
    const { drizzle, cleanup } = makeDb()
    try {
      const emb = makeEmbedder()
      const loader = new EmbeddedWikiRecordsLoader({ db: drizzle, generateEmbedding: emb.fn })
      const out = await loader.load()
      assert.deepEqual(out.records, [])
      assert.equal(out.stats.total, 0)
      assert.equal(emb.calls.length, 0)
    } finally {
      cleanup()
    }
  })

  it("N 行 → 每行 embed(name+body)，返 records 带 path/embedding/sourceHash", async () => {
    const { drizzle, cleanup } = makeDb()
    try {
      insertEntity(drizzle, {
        path: "wiki/concepts/F011-backend.md",
        name: "F011-backend",
        body: "drizzle hardening body",
        sourceHash: "h1",
      })
      insertEntity(drizzle, {
        path: "wiki/rooms/R-001/session-summary.md",
        name: "session-summary",
        body: "房间滚动摘要",
        sourceHash: "h2",
      })
      const emb = makeEmbedder()
      const loader = new EmbeddedWikiRecordsLoader({ db: drizzle, generateEmbedding: emb.fn })
      const out = await loader.load()
      assert.equal(out.records.length, 2)
      assert.equal(out.stats.embedded, 2)
      const byPath = new Map(out.records.map((r) => [r.path, r]))
      const r1 = byPath.get("wiki/concepts/F011-backend.md")
      assert.ok(r1)
      assert.equal(r1?.sourceHash, "h1")
      assert.ok((r1?.embedding.length ?? 0) > 0)
      // embed 文本含 name + body（语义信号双源）
      assert.ok(emb.calls.some((c) => c.includes("F011-backend") && c.includes("drizzle hardening")))
    } finally {
      cleanup()
    }
  })

  it("generateEmbedding null/抛错 → 该行跳过 failed 计数，其余行正常", async () => {
    const { drizzle, cleanup } = makeDb()
    try {
      insertEntity(drizzle, { path: "wiki/concepts/a.md", name: "a", body: "null:body", sourceHash: "ha" })
      insertEntity(drizzle, { path: "wiki/concepts/b.md", name: "b", body: "throw:body", sourceHash: "hb" })
      insertEntity(drizzle, { path: "wiki/concepts/c.md", name: "c", body: "fine", sourceHash: "hc" })
      const emb = makeEmbedder()
      // embedText 以 name 开头会破坏 null:/throw: 前缀 → 用 bodyFirst fake：直接拿 body 当信号
      const loader = new EmbeddedWikiRecordsLoader({
        db: drizzle,
        generateEmbedding: async (text) => {
          if (text.includes("null:")) return null
          if (text.includes("throw:")) throw new Error("boom")
          return [1, 2]
        },
      })
      const out = await loader.load()
      assert.equal(out.records.length, 1)
      assert.equal(out.records[0]?.path, "wiki/concepts/c.md")
      assert.equal(out.stats.failed, 2)
    } finally {
      cleanup()
    }
  })

  it("二次 load 同 hash 复用缓存；hash 变重算", async () => {
    const { drizzle, cleanup } = makeDb()
    try {
      insertEntity(drizzle, { path: "wiki/concepts/a.md", name: "a", body: "v1", sourceHash: "h-v1" })
      const emb = makeEmbedder()
      const loader = new EmbeddedWikiRecordsLoader({ db: drizzle, generateEmbedding: emb.fn })
      const first = await loader.load()
      assert.equal(first.stats.embedded, 1)
      const callsAfterFirst = emb.calls.length

      const second = await loader.load()
      assert.equal(second.stats.reused, 1)
      assert.equal(second.stats.embedded, 0)
      assert.equal(emb.calls.length, callsAfterFirst, "同 hash 不应再调 embedder")

      // 内容变更（hash 变）→ 重算
      drizzle
        .update(wikiEntityIndex)
        .set({ body: "v2", sourceHash: "h-v2" })
        .where(eq(wikiEntityIndex.path, "wiki/concepts/a.md"))
        .run()
      const third = await loader.load()
      assert.equal(third.stats.embedded, 1)
      assert.equal(third.records[0]?.sourceHash, "h-v2")
      assert.ok(emb.calls.length > callsAfterFirst, "hash 变必须重算")
    } finally {
      cleanup()
    }
  })

  it("行删除 → 结果不含 + 缓存同步清理", async () => {
    const { drizzle, cleanup } = makeDb()
    try {
      insertEntity(drizzle, { path: "wiki/concepts/a.md", name: "a", body: "av", sourceHash: "ha" })
      insertEntity(drizzle, { path: "wiki/concepts/b.md", name: "b", body: "bv", sourceHash: "hb" })
      const emb = makeEmbedder()
      const loader = new EmbeddedWikiRecordsLoader({ db: drizzle, generateEmbedding: emb.fn })
      await loader.load()

      drizzle.delete(wikiEntityIndex).where(eq(wikiEntityIndex.path, "wiki/concepts/b.md")).run()
      const second = await loader.load()
      assert.equal(second.records.length, 1)
      assert.equal(second.records[0]?.path, "wiki/concepts/a.md")

      // b.md 重新插回（同 hash）→ 缓存已清，必须重算而不是复用幽灵缓存
      const callsBefore = emb.calls.length
      insertEntity(drizzle, { path: "wiki/concepts/b.md", name: "b", body: "bv", sourceHash: "hb" })
      const third = await loader.load()
      assert.equal(third.records.length, 2)
      assert.ok(emb.calls.length > callsBefore, "删除后缓存应清理，重插必须重算")
    } finally {
      cleanup()
    }
  })
})

describe("HybridSearchProvider.replaceEmbeddedRecords", () => {
  function makeBm25(hits: RecallHit[]): BM25CandidateProvider {
    return {
      search: async (_q: string, _o: SearchOptions) => hits,
    }
  }

  it("空 records BM25-only → 热替换后 cosine 融合生效", async () => {
    // BM25 best-first 序（真实 provider 行为）；replace 后 a.md embedding 与 query 同向
    // → cosine=1 拉过 b.md 的 0.3
    const bm25 = makeBm25([
      { path: "wiki/concepts/b.md", score: 0.3, excerpt: "b" },
      { path: "wiki/concepts/a.md", score: 0.2, excerpt: "a" },
    ])
    let embedCalls = 0
    const provider = new HybridSearchProvider(bm25, [], async () => {
      embedCalls++
      return [1, 0]
    })

    const before = await provider.search("q", { topK: 2 })
    assert.equal(embedCalls, 0, "空 records 快路径不算 query embedding")
    assert.equal(before[0]?.score, 0.3)

    provider.replaceEmbeddedRecords([
      { path: "wiki/concepts/a.md", body: "a", embedding: [1, 0], sourceHash: "ha" },
    ])
    const after = await provider.search("q", { topK: 2 })
    assert.ok(embedCalls > 0, "replace 后必须走语义路径")
    // a.md cosine([1,0],[1,0])=1 > b.md 纯 BM25 0.3 → a 升到第一且 score=1
    assert.equal(after[0]?.path, "wiki/concepts/a.md")
    assert.equal(after[0]?.score, 1)
  })
})
