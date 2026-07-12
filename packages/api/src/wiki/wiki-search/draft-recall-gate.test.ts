/**
 * F027 续 · draft 召回准入闸门(德彪审 P2 + 小孙拍选项 1,2026-06-11)
 *
 * 安全不变量:wiki draft(path 含 /draft/)在 promote 前**不进 agent 召回**。
 *   - 实测发现(德彪 P2):reindex 递归索引 draft/_auto/,WikiEntityFtsProvider /
 *     EmbeddedWikiRecordsLoader 无 path 过滤 → draft 被 search_wiki / adaptive recall
 *     召回,promote 形同虚设(只 mv 路径不是准入闸门)。波及已合并 backfill 43 篇。
 *   - 修:两个召回源默认排除 /draft/;promote(mv 到 canonical 路径)后自然进召回。
 *   - KB tab 草稿审批列表走独立 GET /api/wiki/drafts(fs 扫描),不受影响。
 *
 * 闸门口径(德彪 r2 P1 扩):/draft/ 或 /_drafts/(demote 回流)= 未 promote,与
 * promote/demote 判定 isDraftRelativePath 同口径;含 draft/_auto/、draft/_quarantined/、
 * _drafts/ 全覆盖。L4 read_wiki 同闸门(level4-readwiki-backend.test.ts)。
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
import { EmbeddedWikiRecordsLoader } from "../memory-preflight/embedded-records-loader"
import { isDraftRelativePath } from "../promote-audit/promote-wiki-service"
import { WikiEntityFtsProvider, reindexWikiEntities } from "./index"

// 德彪 r4 P2 · isDraftRelativePath 单元测试(直接测函数,不经 fs;闸门口径单一真相源)。
describe("isDraftRelativePath 大小写不敏感(德彪 r3 P1-2 + r4 P2)", () => {
  it("小写 /draft/ 与 /_drafts/ → true", () => {
    assert.equal(isDraftRelativePath("wiki/concepts/draft/_auto/x.md"), true)
    assert.equal(isDraftRelativePath("wiki/concepts/_drafts/x.md"), true)
  })
  it("大写/混合 DRAFT/_DRAFTS/Draft + 反斜杠 → true(Windows fs 大小写不敏感旁路防护)", () => {
    assert.equal(isDraftRelativePath("wiki/concepts/DRAFT/x.md"), true)
    assert.equal(isDraftRelativePath("wiki/concepts/_DRAFTS/x.md"), true)
    assert.equal(isDraftRelativePath("wiki/concepts/Draft/x.md"), true)
    assert.equal(isDraftRelativePath("wiki\\concepts\\DRAFT\\x.md"), true)
  })
  it("canonical 路径 → false(含一字之差的 undrafts/ 不误判)", () => {
    assert.equal(isDraftRelativePath("wiki/concepts/approved.md"), false)
    assert.equal(isDraftRelativePath("wiki/concepts/undrafts/x.md"), false)
  })
})

function makeDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "draft-gate-db-"))
  const { raw, close } = createDrizzleDb(path.join(dir, "t.sqlite"))
  const db = drizzleBetter(raw as never, { schema })
  return { db, cleanup: () => { close(); rmSync(dir, { recursive: true, force: true }) } }
}

function makeWikiRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "draft-gate-fs-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function writeWiki(root: string, rel: string, body: string) {
  const abs = path.join(root, rel)
  await fsAsync.mkdir(path.dirname(abs), { recursive: true })
  await fsAsync.writeFile(abs, body, "utf8")
}

describe("draft 召回准入闸门 · WikiEntityFtsProvider", () => {
  it("默认排除 /draft/:draft 文件不被召回,canonical 命中", async () => {
    const dbh = makeDb()
    const fs = makeWikiRoot()
    try {
      // 多文档都含 zebramarker(query 命中)→ 验证 draft/_drafts 被闸门排除,canonical 留下
      await writeWiki(fs.root, "wiki/concepts/draft/_auto/B014-danger.md",
        "---\ntype: lesson\n---\n# B014 zebramarker enametoolong\nbody\n")
      await writeWiki(fs.root, "wiki/concepts/_drafts/demoted.md",
        "---\ntype: concept\n---\n# demoted zebramarker doc\nbody\n")
      await writeWiki(fs.root, "wiki/concepts/undrafts/legit.md",
        "---\ntype: concept\n---\n# undrafts zebramarker legit\nbody\n")
      await writeWiki(fs.root, "wiki/concepts/approved.md",
        "---\ntype: concept\n---\n# approved zebramarker entry\nbody\n")
      await reindexWikiEntities({ wikiRoot: fs.root, db: dbh.db })

      const provider = new WikiEntityFtsProvider(dbh.db)
      const hits = await provider.search("zebramarker", { topK: 10 })
      const paths = hits.map((h) => h.path)
      assert.ok(!paths.some((p) => p.includes("/draft/")), `draft 不应被召回: ${JSON.stringify(paths)}`)
      // 德彪 r2 P1:demote 回流的 _drafts/ 同样未 promote,必须同闸门
      assert.ok(!paths.some((p) => p.includes("/_drafts/")), `_drafts 不应被召回: ${JSON.stringify(paths)}`)
      // ESCAPE 正确性反证:'_' 是 LIKE 单字符通配,不转义会误杀一字之差的 undrafts/
      assert.ok(paths.some((p) => p === "wiki/concepts/undrafts/legit.md"),
        `undrafts/ 合法路径不得被 '_' 通配误排: ${JSON.stringify(paths)}`)
      assert.ok(paths.some((p) => p === "wiki/concepts/approved.md"), "canonical 应被召回")
    } finally {
      dbh.cleanup(); fs.cleanup()
    }
  })

  it("includeDrafts=true → draft 可被召回(KB 工具/调试逃生舱)", async () => {
    const dbh = makeDb()
    const fs = makeWikiRoot()
    try {
      await writeWiki(fs.root, "wiki/concepts/draft/_auto/B014-danger.md",
        "---\ntype: lesson\n---\n# B014 zebramarker\nbody\n")
      await reindexWikiEntities({ wikiRoot: fs.root, db: dbh.db })

      const provider = new WikiEntityFtsProvider(dbh.db, { includeDrafts: true })
      const hits = await provider.search("zebramarker", { topK: 10 })
      assert.ok(hits.some((h) => h.path.includes("/draft/")), "includeDrafts 时 draft 应可召回")
    } finally {
      dbh.cleanup(); fs.cleanup()
    }
  })

  it("draft/_quarantined/ 也被排除(隔离段更不该召回)", async () => {
    const dbh = makeDb()
    const fs = makeWikiRoot()
    try {
      await writeWiki(fs.root, "wiki/concepts/draft/_quarantined/sus.md",
        "---\ntype: concept\n---\n# quarantined zebramarker\nbody\n")
      await reindexWikiEntities({ wikiRoot: fs.root, db: dbh.db })
      const provider = new WikiEntityFtsProvider(dbh.db)
      const hits = await provider.search("zebramarker", { topK: 10 })
      assert.equal(hits.length, 0, "隔离段不应被召回")
    } finally {
      dbh.cleanup(); fs.cleanup()
    }
  })
})

describe("draft 召回准入闸门 · EmbeddedWikiRecordsLoader", () => {
  function insert(db: ReturnType<typeof makeDb>["db"], p: string, name: string) {
    db.insert(wikiEntityIndex).values({
      path: p, bucket: p.split("/")[1] ?? "concepts", name, body: "body",
      sourceHash: `h-${name}`, mtimeMs: 1, indexedAt: "2026-06-11T00:00:00Z",
    }).run()
  }

  it("load 排除 /draft/ 与 /_drafts/ 行:只装 canonical embedding(语义召回同闸门)", async () => {
    const dbh = makeDb()
    try {
      insert(dbh.db, "wiki/concepts/draft/_auto/d.md", "d")
      insert(dbh.db, "wiki/concepts/_drafts/d2.md", "d2")
      insert(dbh.db, "wiki/concepts/canon.md", "canon")
      const loader = new EmbeddedWikiRecordsLoader({
        db: dbh.db,
        generateEmbedding: async () => [1, 2],
      })
      const { records } = await loader.load()
      const paths = records.map((r) => r.path)
      assert.deepEqual(paths, ["wiki/concepts/canon.md"], `只应装 canonical: ${JSON.stringify(paths)}`)
    } finally {
      dbh.cleanup()
    }
  })
})

// ─── F042 AC3 · 归档区召回排除（_superseded / _rejected 同谓词无条件闸门）──────
//
// 现症（2026-07-10 生产库实测）：wiki_entity_index 有 _rejected|5 行——demote 掉的
// 条目仍可被 search_wiki 搜到（indexer 动态枚举 wiki/ 下所有目录当 bucket，FTS 只滤
// /draft/）。supersede（AC3 新增）走同一顶级归档目录惯例，两目录一个谓词一并收编。

import { isArchivedRelativePath } from "../promote-audit/promote-wiki-service"

describe("F042 AC3 · isArchivedRelativePath（归档区判定单一真相源）", () => {
  it("顶级 _superseded/ 与 _rejected/ → true（大小写/反斜杠同 isDraftRelativePath 口径）", () => {
    assert.equal(isArchivedRelativePath("wiki/_superseded/concepts/old.md"), true)
    assert.equal(isArchivedRelativePath("wiki/_rejected/replaced-x.md"), true)
    assert.equal(isArchivedRelativePath("wiki/_REJECTED/x.md"), true)
    assert.equal(isArchivedRelativePath("wiki\\_superseded\\concepts\\old.md"), true)
    // draft 区内归档（AC-W2 同源收敛）同样匹配——它已被 isSupersededDraftRelativePath
    // 挡 promote，这里挡召回面（双闸互补不冲突）
    assert.equal(isArchivedRelativePath("wiki/concepts/draft/_superseded/old.md"), true)
  })
  it("canonical / 一字之差路径 → false", () => {
    assert.equal(isArchivedRelativePath("wiki/concepts/approved.md"), false)
    assert.equal(isArchivedRelativePath("wiki/concepts/unrejected/x.md"), false)
    assert.equal(isArchivedRelativePath("wiki/superseded-notes.md"), false)
  })
})

describe("F042 AC3 · 归档召回闸门 · WikiEntityFtsProvider", () => {
  it("_superseded/_rejected 无条件排除（includeDrafts=true 也不放行）", async () => {
    const dbh = makeDb()
    const fs = makeWikiRoot()
    try {
      await writeWiki(fs.root, "wiki/_superseded/concepts/old-twin.md",
        "---\ntype: concept\n---\n# superseded zebramarker twin\nbody\n")
      await writeWiki(fs.root, "wiki/_rejected/replaced.md",
        "---\ntype: concept\n---\n# rejected zebramarker page\nbody\n")
      await writeWiki(fs.root, "wiki/concepts/approved.md",
        "---\ntype: concept\n---\n# approved zebramarker entry\nbody\n")
      await reindexWikiEntities({ wikiRoot: fs.root, db: dbh.db })

      const provider = new WikiEntityFtsProvider(dbh.db)
      const hits = await provider.search("zebramarker", { topK: 10 })
      const paths = hits.map((h) => h.path)
      assert.deepEqual(paths, ["wiki/concepts/approved.md"], `归档区不应被召回: ${JSON.stringify(paths)}`)

      const debugProvider = new WikiEntityFtsProvider(dbh.db, { includeDrafts: true })
      const debugHits = await debugProvider.search("zebramarker", { topK: 10 })
      const debugPaths = debugHits.map((h) => h.path)
      assert.ok(!debugPaths.some((p) => isArchivedRelativePath(p)),
        `includeDrafts 逃生舱也不放行归档区: ${JSON.stringify(debugPaths)}`)
    } finally {
      dbh.cleanup(); fs.cleanup()
    }
  })
})

describe("F042 AC3 · 归档召回闸门 · EmbeddedWikiRecordsLoader", () => {
  it("load 排除 _superseded/_rejected 行（语义召回同闸门）", async () => {
    const dbh = makeDb()
    try {
      const insert = (p: string, name: string) => {
        dbh.db.insert(wikiEntityIndex).values({
          path: p, bucket: p.split("/")[1] ?? "concepts", name, body: "body",
          sourceHash: `h-${name}`, mtimeMs: 1, indexedAt: "2026-07-11T00:00:00Z",
        }).run()
      }
      insert("wiki/_superseded/concepts/old.md", "old")
      insert("wiki/_rejected/gone.md", "gone")
      insert("wiki/concepts/canon.md", "canon")
      const loader = new EmbeddedWikiRecordsLoader({
        db: dbh.db,
        generateEmbedding: async () => [1, 2],
      })
      const { records } = await loader.load()
      const paths = records.map((r) => r.path)
      assert.deepEqual(paths, ["wiki/concepts/canon.md"], `归档区不应进 embedded records: ${JSON.stringify(paths)}`)
    } finally {
      dbh.cleanup()
    }
  })
})
