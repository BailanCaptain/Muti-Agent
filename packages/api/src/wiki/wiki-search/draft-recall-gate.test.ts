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
 * 闸门口径:path 含 '/draft/' = 未 promote(与 NightlyHealthCheck / wiki-story isDraftPath
 * 同口径);含 draft/_auto/、draft/_quarantined/ 全覆盖。
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
import { WikiEntityFtsProvider, reindexWikiEntities } from "./index"

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
      // 两文档都含 zebramarker(query 命中)→ 验证 draft 被命中但被闸门排除,canonical 留下
      await writeWiki(fs.root, "wiki/concepts/draft/_auto/B014-danger.md",
        "---\ntype: lesson\n---\n# B014 zebramarker enametoolong\nbody\n")
      await writeWiki(fs.root, "wiki/concepts/approved.md",
        "---\ntype: concept\n---\n# approved zebramarker entry\nbody\n")
      await reindexWikiEntities({ wikiRoot: fs.root, db: dbh.db })

      const provider = new WikiEntityFtsProvider(dbh.db)
      const hits = await provider.search("zebramarker", { topK: 10 })
      const paths = hits.map((h) => h.path)
      assert.ok(!paths.some((p) => p.includes("/draft/")), `draft 不应被召回: ${JSON.stringify(paths)}`)
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

  it("load 排除 /draft/ 行:只装 canonical embedding(语义召回同闸门)", async () => {
    const dbh = makeDb()
    try {
      insert(dbh.db, "wiki/concepts/draft/_auto/d.md", "d")
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
