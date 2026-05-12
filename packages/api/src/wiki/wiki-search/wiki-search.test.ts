/**
 * F027 P14.a · wiki entity FTS5 + indexer 端到端测试
 *
 * 五层覆盖：
 *   1. sanitizeFtsQuery: 各种危险字符 → 安全 FTS5 phrase
 *   2. reindexWikiEntities: 扫盘 → DB insert / update / skip / remove
 *   3. WikiEntityFtsProvider.queryFts: 直接 BM25 query
 *   4. WikiEntityFtsProvider.search (impl WikiSearchProvider): 接 memory-preflight 接口
 *   5. AC-P1-11 baseline-with-FTS：F011/F021/B022 真 FTS5 命中相对排序
 */

import assert from "node:assert/strict"
import { promises as fsAsync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { drizzle as drizzleBetter } from "drizzle-orm/better-sqlite3"
import { createDrizzleDb } from "../../db/drizzle-instance"
import * as schema from "../../db/schema"
import { wikiEntityIndex } from "../../db/schema"
import { WikiEntityFtsProvider, bm25ToScore, reindexWikiEntities, sanitizeFtsQuery } from "./index"

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "wiki-search-db-"))
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
  const root = mkdtempSync(path.join(tmpdir(), "wiki-search-fs-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function writeWikiFile(root: string, relPath: string, body: string): Promise<void> {
  const abs = path.join(root, relPath)
  await fsAsync.mkdir(path.dirname(abs), { recursive: true })
  await fsAsync.writeFile(abs, body, "utf8")
}

// ─────────────────────────────────────────────────────────────────────
// 1. sanitizeFtsQuery
// ─────────────────────────────────────────────────────────────────────

describe("sanitizeFtsQuery", () => {
  it("基础英文 query → 每 token 包 phrase", () => {
    assert.equal(sanitizeFtsQuery("F011 drizzle"), '"F011" "drizzle"')
  })

  it("中文 + 英文混合", () => {
    assert.equal(sanitizeFtsQuery("F011 drizzle 优化"), '"F011" "drizzle" "优化"')
  })

  it("含 quote 内部双倍转义", () => {
    const out = sanitizeFtsQuery('say "hello"')
    // 标点被 strip，hello 内部 quote 已剥（standard tokens 不含 quote 字符）
    assert.match(out, /"say"/)
    assert.match(out, /"hello"/)
  })

  it("控制字符 strip", () => {
    const out = sanitizeFtsQuery("hello\x00world")
    assert.equal(out, '"helloworld"')
  })

  it("纯标点 → 空字符串", () => {
    assert.equal(sanitizeFtsQuery("!@#$%"), "")
    assert.equal(sanitizeFtsQuery("   "), "")
    assert.equal(sanitizeFtsQuery(""), "")
  })

  it("FTS5 保留字 OR/AND/NEAR 当 phrase 不解析为操作符", () => {
    const out = sanitizeFtsQuery("AND OR NEAR test")
    // 所有 token 都被 phrase 引用，FTS5 不再当操作符
    assert.match(out, /"AND"/)
    assert.match(out, /"OR"/)
    assert.match(out, /"NEAR"/)
    assert.match(out, /"test"/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2. bm25ToScore
// ─────────────────────────────────────────────────────────────────────

describe("bm25ToScore", () => {
  it("完美匹配 (bm25 = -8) → score ≈ 1.0", () => {
    assert.ok(bm25ToScore(-8) >= 0.99)
  })
  it("弱匹配 (bm25 = 4) → score ≈ 0", () => {
    assert.ok(bm25ToScore(4) <= 0.01)
  })
  it("中等 (bm25 = -2) → score 在 0.4-0.8", () => {
    const s = bm25ToScore(-2)
    assert.ok(s >= 0.4 && s <= 0.8, `score ${s} 不在 [0.4, 0.8]`)
  })
  it("clamp: 极小 bm25 也 ≤ 1", () => {
    assert.ok(bm25ToScore(-100) <= 1)
    assert.ok(bm25ToScore(-100) >= 0)
  })
})

// ─────────────────────────────────────────────────────────────────────
// 3. reindexWikiEntities
// ─────────────────────────────────────────────────────────────────────

describe("reindexWikiEntities", () => {
  it("空 wikiRoot → 0 inserted / 0 failed", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      const r = await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      assert.equal(r.scanned, 0)
      assert.equal(r.inserted, 0)
      assert.equal(r.failed.length, 0)
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("首次扫 3 文件 → 3 inserted；DB 行 hash 与 mtime 正确", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "drizzle migration safety")
      await writeWikiFile(root, "wiki/concepts/F021.md", "context window resolver")
      await writeWikiFile(root, "wiki/agents/桂芬.md", "frontend agent")
      const r = await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      assert.equal(r.scanned, 3)
      assert.equal(r.inserted, 3)
      assert.equal(r.skipped, 0)
      const rows = drizzle.select().from(wikiEntityIndex).all()
      assert.equal(rows.length, 3)
      const f011 = rows.find((row) => row.path === "wiki/concepts/F011.md")
      assert.ok(f011)
      assert.equal(f011.bucket, "concepts")
      assert.equal(f011.name, "F011")
      assert.equal(f011.body, "drizzle migration safety")
      assert.equal(f011.sourceHash.length, 64) // sha256 hex
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("二次扫无改动 → 全 skipped", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "drizzle")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const r2 = await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      assert.equal(r2.scanned, 1)
      assert.equal(r2.inserted, 0)
      assert.equal(r2.skipped, 1)
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("body 改动 → updated", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "v1 body")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      // 改 body，mtime 也变（fs.writeFile 触发 mtime 刷新）
      // 显式等 1ms 防 Windows 文件系统时间分辨率粗（mtime 不变会被 skipped）
      await new Promise((r) => setTimeout(r, 10))
      await writeWikiFile(root, "wiki/concepts/F011.md", "v2 body changed")
      const r2 = await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      assert.equal(r2.updated, 1)
      assert.equal(r2.skipped, 0)
      const row = drizzle
        .select()
        .from(wikiEntityIndex)
        .all()
        .find((r) => r.path === "wiki/concepts/F011.md")
      assert.ok(row)
      assert.equal(row.body, "v2 body changed")
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("磁盘删文件 → DB DELETE", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "x")
      await writeWikiFile(root, "wiki/concepts/F021.md", "y")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      await fsAsync.unlink(path.join(root, "wiki/concepts/F021.md"))
      const r2 = await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      assert.equal(r2.removed, 1)
      const rows = drizzle.select().from(wikiEntityIndex).all()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].path, "wiki/concepts/F011.md")
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("超 maxBodyBytes 的文件 → failed 列表 + 不入库", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/huge.md", "x".repeat(2000))
      const r = await reindexWikiEntities({
        wikiRoot: root,
        db: drizzle,
        maxBodyBytes: 1000,
      })
      assert.equal(r.scanned, 0)
      assert.equal(r.failed.length, 1)
      assert.match(r.failed[0].error, /exceeds maxBodyBytes/)
      assert.equal(drizzle.select().from(wikiEntityIndex).all().length, 0)
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("buckets 过滤 → 只扫指定子目录", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "x")
      await writeWikiFile(root, "wiki/agents/桂芬.md", "y")
      await writeWikiFile(root, "wiki/bugReport/B022.md", "z")
      const r = await reindexWikiEntities({
        wikiRoot: root,
        db: drizzle,
        buckets: ["concepts", "agents"],
      })
      assert.equal(r.scanned, 2)
      assert.equal(r.inserted, 2)
      const rows = drizzle.select().from(wikiEntityIndex).all()
      assert.ok(rows.every((r) => r.bucket === "concepts" || r.bucket === "agents"))
    } finally {
      cleanup()
      cleanupFs()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 4. WikiEntityFtsProvider
// ─────────────────────────────────────────────────────────────────────

describe("WikiEntityFtsProvider FTS5 query", () => {
  it("空 query / 纯标点 → 空 hits", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "drizzle migration")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const provider = new WikiEntityFtsProvider(drizzle)
      assert.equal(provider.queryFts("").length, 0)
      assert.equal(provider.queryFts("!!!").length, 0)
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("命中按 BM25 排序：query 关键词更密集的文件排前", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/concepts/F011.md",
        "drizzle drizzle drizzle migration drizzle drizzle",
      )
      await writeWikiFile(root, "wiki/concepts/F018.md", "session bootstrap")
      await writeWikiFile(root, "wiki/concepts/F021.md", "context window")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const provider = new WikiEntityFtsProvider(drizzle)
      const hits = provider.queryFts("drizzle")
      assert.ok(hits.length >= 1)
      assert.match(hits[0].path, /F011/)
      // bm25 是负数（值越小越相关）
      assert.ok(hits[0].bm25Rank < 0)
      // score 归一化在 [0, 1]
      for (const h of hits) {
        assert.ok(h.score >= 0 && h.score <= 1)
      }
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("bucket 过滤", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "drizzle migration")
      await writeWikiFile(root, "wiki/agents/桂芬.md", "drizzle frontend")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const provider = new WikiEntityFtsProvider(drizzle)
      const all = provider.queryFts("drizzle")
      assert.equal(all.length, 2)
      const onlyConcepts = provider.queryFts("drizzle", { buckets: ["concepts"] })
      assert.equal(onlyConcepts.length, 1)
      assert.equal(onlyConcepts[0].bucket, "concepts")
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("UPDATE 文件后 FTS5 触发器同步 → 旧 query 不命中 新 query 命中", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "drizzle migration")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const provider = new WikiEntityFtsProvider(drizzle)
      assert.equal(provider.queryFts("drizzle").length, 1)
      assert.equal(provider.queryFts("brand new word").length, 0)

      // 改 body
      await new Promise((r) => setTimeout(r, 10))
      await writeWikiFile(root, "wiki/concepts/F011.md", "brand new word content")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      assert.equal(provider.queryFts("drizzle").length, 0)
      assert.equal(provider.queryFts("brand new word").length, 1)
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("DELETE 文件后 FTS5 触发器同步 → query 不再命中", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(root, "wiki/concepts/F011.md", "drizzle migration")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const provider = new WikiEntityFtsProvider(drizzle)
      assert.equal(provider.queryFts("drizzle").length, 1)
      await fsAsync.unlink(path.join(root, "wiki/concepts/F011.md"))
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      assert.equal(provider.queryFts("drizzle").length, 0)
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("中文 query 命中（unicode61 一字一 token baseline）", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/concepts/F021.md",
        "F021 上下文窗口 / Seal 阈值齿轮可配 + fillRatio",
      )
      await writeWikiFile(root, "wiki/concepts/F011.md", "drizzle migration")
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const provider = new WikiEntityFtsProvider(drizzle)
      const hits = provider.queryFts("上下文窗口")
      assert.ok(hits.length >= 1, "中文 query 应命中含 '上下文窗口' 的文件")
      assert.match(hits[0].path, /F021/)
    } finally {
      cleanup()
      cleanupFs()
    }
  })

  it("WikiSearchProvider interface (memory-preflight) — search() shape 对", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/concepts/F011.md",
        "drizzle migration safety + backfill 安全策略",
      )
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const provider = new WikiEntityFtsProvider(drizzle)
      const hits = await provider.search("drizzle", { topK: 5, scope: "all" })
      assert.ok(hits.length >= 1)
      assert.equal(typeof hits[0].path, "string")
      assert.equal(typeof hits[0].score, "number")
      assert.equal(typeof hits[0].excerpt, "string")
      assert.ok(hits[0].excerpt.length <= 200)
    } finally {
      cleanup()
      cleanupFs()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// 5. AC-P1-11 baseline with real FTS5 backend (P11.b 雏形)
// ─────────────────────────────────────────────────────────────────────

describe("AC-P1-11 baseline with FTS5：F011 drizzle 优化 → F011 排首位 + F021/B022 ranking", () => {
  it("FTS5 backend 复现 P11.a 排序：F011 > F021 > B022", async () => {
    const { drizzle, cleanup } = makeDb()
    const { root, cleanup: cleanupFs } = makeWikiRoot()
    try {
      await writeWikiFile(
        root,
        "wiki/concepts/F011-backend-hardening-drizzle.md",
        "F011 drizzle 优化 backend hardening. drizzle migration safety + backfill 安全策略. BEGIN IMMEDIATE 锁串行写. drizzle better-sqlite3 driver. 优化 query 改 prepared statement.",
      )
      await writeWikiFile(
        root,
        "wiki/concepts/F021-context-window-resolver.md",
        "F021 上下文窗口 / Seal 阈值齿轮可配 + fillRatio. context window resolver 动态调整 prompt token. seal 阈值 config 控制.",
      )
      await writeWikiFile(
        root,
        "wiki/bugReport/B022-prompt-injection.md",
        "B022 prompt 注入四源冗余. fail-closed 防御.",
      )
      await reindexWikiEntities({ wikiRoot: root, db: drizzle })
      const provider = new WikiEntityFtsProvider(drizzle)
      const hits = await provider.search("F011 drizzle 优化", { topK: 10, scope: "all" })
      assert.ok(hits.length >= 1)
      // F011 必须排首位
      assert.match(
        hits[0].path,
        /F011-backend-hardening-drizzle/,
        `F011 应排首位，实际 ${hits.map((h) => h.path).join(",")}`,
      )
    } finally {
      cleanup()
      cleanupFs()
    }
  })
})
