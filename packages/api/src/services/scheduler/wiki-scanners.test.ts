/**
 * F027 v3 G2 · wiki-scanners 单测
 *
 * 覆盖 5 个 scanner:
 *   1. scanWikiEntitiesFs — fs walk + frontmatter 解析 + WikiEntity 形 shape
 *   2. scanWikiDraftsFs   — 只取 /draft/ 路径 + title/created_at 抽取
 *   3. scanDriftTriggersDb — wiki_events lessons 7d + a2a_calls failed 7d → DriftTrigger
 *   4. scanRoomViewfindersForSnapshot — DB session_groups + fs viewfinder.md 读
 *   5. scanAgentSessionsFs — rooms/<id>/agent-sessions/<alias>/S-NNNN.md 抓 year + digest
 *
 * 真相源:
 *   - wiki-scanners.ts 各 export
 *   - scheduler-bootstrap.ts G2 wire（boot 注入 wikiRoot 后这些就 active）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../../db/schema"
import { NightlyHealthCheck } from "./nightly-health-check"
import {
  parseFrontmatter,
  scanAgentSessionsFs,
  scanDriftTriggersDb,
  scanRoomViewfindersForSnapshot,
  scanWikiDraftsFs,
  scanWikiEntitiesFs,
} from "./wiki-scanners"

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ── fs 临时目录工具 ────────────────────────────────────────────────────

function makeTmpWiki(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "f027-g2-wiki-"))
}

function writeMd(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, "utf-8")
}

// ── parseFrontmatter ───────────────────────────────────────────────────

test("G2 · parseFrontmatter: 三段 yaml + body 切分正确", () => {
  const raw = `---
title: My Concept
sources: [foo.md, bar.md]
reviewing: true
created_at: 2026-05-28T00:00:00Z
---
Body content here
Multi line ok.`
  const { frontmatter, body } = parseFrontmatter(raw)
  assert.equal(frontmatter.title, "My Concept")
  assert.deepEqual(frontmatter.sources, ["foo.md", "bar.md"])
  assert.equal(frontmatter.reviewing, true)
  assert.equal(frontmatter.created_at, "2026-05-28T00:00:00Z")
  assert.ok(body.includes("Body content here"))
})

test("G2 · parseFrontmatter: 无 frontmatter → body=raw, frontmatter={}", () => {
  const raw = "No frontmatter here\nJust body"
  const { frontmatter, body } = parseFrontmatter(raw)
  assert.deepEqual(frontmatter, {})
  assert.equal(body, raw)
})

// 德彪 chunk-B-r1 P1: yaml.stringify 写出的 YAML block array（生产 ingest-preview
// stringifyYaml 落盘形式）必须解析成数组——原 parser 只认 inline `[a, b]`，block 风格
// 被读成空字符串 → deadSupersedes 静默失效。
test("德彪 P1 · parseFrontmatter: YAML block array → 数组（生产 stringifyYaml 形式）", () => {
  const raw = `---
canonical_owner_path: wiki/concepts/new.md
supersedes:
  - wiki/concepts/gone.md
  - wiki/concepts/alive.md
---
body`
  const { frontmatter } = parseFrontmatter(raw)
  assert.deepEqual(frontmatter.supersedes, [
    "wiki/concepts/gone.md",
    "wiki/concepts/alive.md",
  ])
})

test("德彪 P1 · parseFrontmatter: block array 带引号 item + 后续 scalar key 不被吞", () => {
  const raw = `---
supersedes:
  - "wiki/a.md"
  - 'wiki/b.md'
title: After Block
---
body`
  const { frontmatter } = parseFrontmatter(raw)
  assert.deepEqual(frontmatter.supersedes, ["wiki/a.md", "wiki/b.md"])
  assert.equal(frontmatter.title, "After Block", "block array 后的 scalar key 仍解析")
})

test("德彪 P1 · parseFrontmatter: 空值 key 无后续 '- ' 项 → 保持空字符串（不误判数组）", () => {
  const raw = `---
title:
sources: [a.md]
---
body`
  const { frontmatter } = parseFrontmatter(raw)
  assert.equal(frontmatter.title, "")
  assert.deepEqual(frontmatter.sources, ["a.md"])
})

// 德彪 chunk-B-r1 P1: scanner → NHC 生产链路集成——真实文件 block-array supersedes
// 死链必须被 deadSupersedes 抓（原来只有手写 inline-array stub 覆盖，漏生产扫描链路）。
test("德彪 P1 · scanWikiEntitiesFs → NHC deadSupersedes 抓 block-array supersedes 死链", async () => {
  const root = makeTmpWiki()
  writeMd(
    root,
    "concepts/new.md",
    `---
canonical_owner_path: wiki/concepts/new.md
sources: [seed.md]
supersedes:
  - wiki/concepts/gone.md
  - wiki/concepts/alive.md
---
[[wiki/concepts/new]]
`,
  )
  writeMd(
    root,
    "concepts/alive.md",
    `---
canonical_owner_path: wiki/concepts/alive.md
sources: [seed.md]
---
[[wiki/concepts/alive]]
`,
  )
  const entities = await scanWikiEntitiesFs(root)()
  const check = new NightlyHealthCheck({ scanEntities: async () => entities })
  const report = await check.run()
  const ds = report.deadSupersedes.find((d) => d.path === "wiki/concepts/new.md")
  assert.ok(ds, "new.md 的 supersedes 死链必须被 deadSupersedes 抓到")
  assert.deepEqual(ds?.missing, ["wiki/concepts/gone.md"], "只 gone.md 死，alive.md 存在")
})

// ── scanWikiEntitiesFs ─────────────────────────────────────────────────

test("G2 · scanWikiEntitiesFs: 递归扫 *.md + frontmatter 解析 + path 前缀 wiki/", async () => {
  const root = makeTmpWiki()
  writeMd(
    root,
    "concepts/rag.md",
    `---
sources: [paper.md]
canonical_owner_path: wiki/concepts/rag.md
---
RAG body`,
  )
  writeMd(
    root,
    "rooms/R-001/viewfinder.md",
    `---
viewfinder_id: vf-001
---
## Decisions
- F027 落地`,
  )
  writeMd(root, "not-md.txt", "ignored")

  const scanner = scanWikiEntitiesFs(root)
  const entities = await scanner()
  assert.equal(entities.length, 2)
  const paths = entities.map((e) => e.path).sort()
  assert.deepEqual(paths, ["wiki/concepts/rag.md", "wiki/rooms/R-001/viewfinder.md"])
  const rag = entities.find((e) => e.path.includes("rag.md"))!
  assert.deepEqual(rag.frontmatter.sources, ["paper.md"])
  assert.equal(rag.frontmatter.canonical_owner_path, "wiki/concepts/rag.md")
  assert.ok(rag.body.includes("RAG body"))
})

test("G2 · scanWikiEntitiesFs: wikiRoot 不存在 → 空数组（不抛）", async () => {
  const scanner = scanWikiEntitiesFs(path.join(os.tmpdir(), "f027-g2-not-exist-" + Date.now()))
  const entities = await scanner()
  assert.deepEqual(entities, [])
})

// ── scanWikiDraftsFs ──────────────────────────────────────────────────

test("G2 · scanWikiDraftsFs: 只取 /draft/ 路径 + title/created_at 抽取", async () => {
  const root = makeTmpWiki()
  writeMd(
    root,
    "concepts/draft/2026-05-28-foo.md",
    `---
title: Foo Draft
created_at: 2026-05-28T01:00:00Z
---
draft body`,
  )
  writeMd(
    root,
    "concepts/draft/_auto/auto-bar.md",
    `---
title: Auto Bar
---
auto body`,
  )
  writeMd(
    root,
    "concepts/published.md",
    "published, no /draft/",
  )

  const scanner = scanWikiDraftsFs(root)
  const drafts = await scanner()
  assert.equal(drafts.length, 2)
  const foo = drafts.find((d) => d.path.includes("2026-05-28-foo"))!
  assert.equal(foo.title, "Foo Draft")
  assert.equal(foo.createdAt, "2026-05-28T01:00:00Z")
  // path 含 wiki/ 前缀供 classifyDraftPath 判定
  assert.ok(foo.path.startsWith("wiki/"))
})

// ── scanDriftTriggersDb ───────────────────────────────────────────────

function makeTmpDb(): { db: DrizzleDb; raw: Database.Database } {
  const sqlite = new Database(":memory:")
  sqlite.exec(`
    CREATE TABLE wiki_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      alias TEXT NOT NULL,
      action TEXT NOT NULL,
      path TEXT NOT NULL,
      base_hash TEXT,
      content_hash TEXT,
      attempted_hash TEXT,
      diff_summary TEXT,
      source_message_ids TEXT,
      promotion_target TEXT,
      reason TEXT,
      fencing_token TEXT NOT NULL,
      leader_term TEXT NOT NULL,
      result TEXT NOT NULL,
      error TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      result_manifest_version TEXT,
      reserved_1 TEXT,
      reserved_2 TEXT
    );
    CREATE TABLE a2a_calls (
      call_id TEXT PRIMARY KEY,
      parent_call_id TEXT,
      root_call_id TEXT NOT NULL,
      issuer_id TEXT NOT NULL,
      convener_id TEXT NOT NULL,
      on_behalf_of TEXT,
      reply_to TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      join_set_id TEXT,
      status TEXT NOT NULL,
      envelope_version TEXT NOT NULL DEFAULT 'v1',
      session_group_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE session_groups (
      id TEXT PRIMARY KEY,
      room_id TEXT UNIQUE,
      title TEXT NOT NULL,
      sop_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reserved_1 TEXT,
      reserved_2 TEXT
    );
  `)
  const db = drizzle(sqlite) as unknown as DrizzleDb
  return { db, raw: sqlite }
}

test("G2 · scanDriftTriggersDb: 近 7d lessons 写入 → new_lesson trigger", async () => {
  const { db, raw } = makeTmpDb()
  try {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
    raw
      .prepare(
        "INSERT INTO wiki_events (ts, alias, action, path, fencing_token, leader_term, result, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(yesterday, "范德彪", "write", "wiki/lessons/LL-031.md", "tok1", "term1", "ok", "committed")
    raw
      .prepare(
        "INSERT INTO wiki_events (ts, alias, action, path, fencing_token, leader_term, result, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(tenDaysAgo, "桂芬", "write", "wiki/lessons/LL-old.md", "tok2", "term1", "ok", "committed")
    raw
      .prepare(
        "INSERT INTO wiki_events (ts, alias, action, path, fencing_token, leader_term, result, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(yesterday, "黄仁勋", "write", "wiki/concepts/foo.md", "tok3", "term1", "ok", "committed")
    const scanner = scanDriftTriggersDb(db)
    const triggers = await scanner()
    const newLessons = triggers.filter((t) => t.kind === "new_lesson")
    assert.equal(newLessons.length, 1, "只 1 个近 7d lessons 写入")
    assert.equal(newLessons[0].ref, "LL-031")
  } finally {
    raw.close()
  }
})

test("G2 · scanDriftTriggersDb: 近 7d a2a_calls failed → handoff_failure trigger", async () => {
  const { db, raw } = makeTmpDb()
  try {
    const recent = new Date(Date.now() - 3600 * 1000).toISOString()
    raw
      .prepare(
        "INSERT INTO a2a_calls (call_id, root_call_id, issuer_id, convener_id, reply_to, deadline_at, status, session_group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("call-001", "call-001", "范德彪", "黄仁勋", "x", recent, "failed", "sg-1", recent, recent)
    raw
      .prepare(
        "INSERT INTO a2a_calls (call_id, root_call_id, issuer_id, convener_id, reply_to, deadline_at, status, session_group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("call-002", "call-002", "桂芬", "黄仁勋", "x", recent, "done", "sg-1", recent, recent)
    const scanner = scanDriftTriggersDb(db)
    const triggers = await scanner()
    const failures = triggers.filter((t) => t.kind === "handoff_failure")
    assert.equal(failures.length, 1)
    assert.equal(failures[0].ref, "call-001")
  } finally {
    raw.close()
  }
})

// ── scanRoomViewfindersForSnapshot ────────────────────────────────────

test("G2 · scanRoomViewfindersForSnapshot: 扫活跃 room + 读 viewfinder.md → MVP recompile=current", async () => {
  const { db, raw } = makeTmpDb()
  const wikiRoot = makeTmpWiki()
  try {
    const now = new Date().toISOString()
    raw
      .prepare(
        "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("sg-1", "R-001", "Room 1", now, now)
    raw
      .prepare(
        "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("sg-2", "R-002", "Room 2", now, now)
    writeMd(wikiRoot, "rooms/R-001/viewfinder.md", "## Decisions\n- F027 落地")
    // R-002 故意没 viewfinder.md → 应跳过

    const scanner = scanRoomViewfindersForSnapshot(db, wikiRoot)
    const snapshots = await scanner()
    assert.equal(snapshots.length, 1, "只有 R-001 有 viewfinder.md")
    assert.equal(snapshots[0].roomId, "R-001")
    // MVP: recompiledViewfinder === currentViewfinder
    assert.equal(snapshots[0].currentViewfinder, snapshots[0].recompiledViewfinder)
    assert.ok(snapshots[0].currentViewfinder.includes("F027 落地"))
  } finally {
    raw.close()
  }
})

// ── scanAgentSessionsFs ───────────────────────────────────────────────

// ── G2 r2 (codex review FAIL fix) · wikiRoot 约定锁 ──────────────────

test("G2 r2 · server.ts bootSchedulerRuntime wikiRoot 必须用 roomCompileWikiRoot 不是 namespace 外层（codex P2 wiring lock）", () => {
  // Codex G2 r2 review CONDITIONAL_PASS finding: "scanner lock test 不直接锁 server.ts wiring，
  // 后续 server.ts 传错值不会被 wiki-scanners.test.ts 单独拦住"。
  //
  // 此 static source assertion 锁住 server.ts bootSchedulerRuntime 块的 wikiRoot 字段值必须是
  // `roomCompileWikiRoot`（已计算好的 `<wikiServicesRoot>/wiki/` markdown 实际根）或显式 join wiki。
  // 防止未来 caller 改回 `process.env.WIKI_ROOT || cwd/.runtime/wiki/` 这种 namespace 外层错误。
  //
  // 失败示例:
  //   bootSchedulerRuntime({
  //     ...
  //     wikiRoot: process.env.WIKI_ROOT || path.join(process.cwd(), ".runtime", "wiki"),  // ❌ 会扫不到真文件
  //   })
  // 正确示例:
  //   bootSchedulerRuntime({
  //     ...
  //     wikiRoot: roomCompileWikiRoot,  // ✅ 已含 wiki/ 多一层
  //   })
  const serverPath = path.join(
    process.cwd(),
    "packages",
    "api",
    "src",
    "server.ts",
  )
  const src = fs.readFileSync(serverPath, "utf-8")
  // 匹配 bootSchedulerRuntime({...wikiRoot: X...}) 块（multi-line + 注释 + JSDoc）
  const match = src.match(/bootSchedulerRuntime\(\{[\s\S]*?\n\s*wikiRoot:\s*([^,\n]+)/)
  assert.ok(
    match,
    "server.ts 必须有 bootSchedulerRuntime({...wikiRoot: X...}) 调用 (G2 wire 接通)",
  )
  const value = match![1].trim()
  // 必须是 roomCompileWikiRoot 或显式 join wiki/（即多加一层 wiki 对齐真实文件结构）
  // 不可以是 process.env.WIKI_ROOT || path.join(..., ".runtime", "wiki") 这种 namespace 外层
  const isRoomCompileRoot = value === "roomCompileWikiRoot"
  const hasExplicitWikiJoin = /["']wiki["']/.test(value)
  assert.ok(
    isRoomCompileRoot || hasExplicitWikiJoin,
    `server.ts bootSchedulerRuntime wikiRoot 必须用 roomCompileWikiRoot (或显式 join "wiki" 多一层)，` +
      "不能传 namespace 外层（如 process.env.WIKI_ROOT || .runtime/wiki/）；" +
      `否则 5 个 cron job 全扫不到真文件 (codex G2 review FAIL P1)。实际值: ${value}`,
  )
})

test("G2 r2 · wikiRoot 约定 = markdown 实际根（server.ts:911 roomCompileWikiRoot 口径，不是 namespace 外层）", async () => {
  // 模拟真实 production fs 结构: `<base>/wiki/rooms/<id>/viewfinder.md`
  // server.ts 必须传 wikiRoot = `<base>/wiki`（不是 `<base>`），scanner 才能扫到文件。
  // 之前 G2 v1 传错值 (`<base>`) → scanner 全扫不到真文件 (codex review FAIL P1)。
  // 此测试 lock 修复：caller 给 wikiRoot=`<base>/wiki` 时 scanner 找到 viewfinder.md。
  const base = makeTmpWiki()
  // base 模拟 `.runtime/wiki`，真实文件在 `base/wiki/rooms/R-001/viewfinder.md`
  // (注意双 wiki 嵌套 — 与 .runtime/wiki/wiki/ 真实约定一致)
  writeMd(base, "wiki/rooms/R-001/viewfinder.md", "## Decisions\n- F027 G2 r2 路径修")
  writeMd(base, "wiki/rooms/R-002/viewfinder.md", "R-002 viewfinder body")
  writeMd(base, "wiki/concepts/draft/foo.md", "draft body")

  // 错误传值: wikiRoot = base → scanner 扫不到 (因为它走 base/rooms/... 不存在)
  const wrongWikiRoot = base
  const wrongScanner = scanWikiEntitiesFs(wrongWikiRoot)
  const wrongEntities = await wrongScanner()
  // 走 wrong path 时，walkMdFiles 仍能递归到 base/wiki/... 子树，但 entity.path
  // 前缀会变 "wiki/wiki/..." (双 wiki) — 破坏 NightlyHealthCheck 路径约定
  for (const e of wrongEntities) {
    assert.ok(
      e.path.startsWith("wiki/wiki/"),
      `wrong 传值时 path 应有 wiki/wiki/ 双前缀 (破坏路径约定，证明 server.ts 不能传 namespace 外层)；实际: ${e.path}`,
    )
  }

  // 正确传值: wikiRoot = base/wiki → scanner path 单 wiki/ 前缀
  const correctWikiRoot = path.join(base, "wiki")
  const correctScanner = scanWikiEntitiesFs(correctWikiRoot)
  const correctEntities = await correctScanner()
  assert.equal(correctEntities.length, 3, "应扫到 R-001 + R-002 viewfinder + draft/foo")
  for (const e of correctEntities) {
    assert.ok(
      e.path.startsWith("wiki/") && !e.path.startsWith("wiki/wiki/"),
      `正确传值时 path 应单 wiki/ 前缀；实际: ${e.path}`,
    )
  }

  // MonthlySnapshot 路径同口径 (DB scanned rooms 与文件路径 join)
  const { db, raw } = makeTmpDb()
  try {
    const now = new Date().toISOString()
    raw
      .prepare(
        "INSERT INTO session_groups (id, room_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("sg-1", "R-001", "Room 1", now, now)
    const snapshotScanner = scanRoomViewfindersForSnapshot(db, correctWikiRoot)
    const snapshots = await snapshotScanner()
    assert.equal(snapshots.length, 1, "正确 wikiRoot 应扫到 R-001 viewfinder")
    assert.ok(snapshots[0].currentViewfinder.includes("F027 G2 r2 路径修"))

    const wrongSnapshotScanner = scanRoomViewfindersForSnapshot(db, wrongWikiRoot)
    const wrongSnapshots = await wrongSnapshotScanner()
    assert.equal(
      wrongSnapshots.length,
      0,
      "wrong wikiRoot 应扫不到任何 viewfinder (path mismatch)",
    )
  } finally {
    raw.close()
  }
})

test("G2 · scanAgentSessionsFs: rooms/<id>/agent-sessions/<alias>/S-NNNN.md 抓 year + digest", async () => {
  const root = makeTmpWiki()
  writeMd(
    root,
    "rooms/R-001/agent-sessions/范德彪/S-0001.md",
    `---
created_at: 2025-06-15T00:00:00Z
---
session digest body`,
  )
  writeMd(
    root,
    "rooms/R-001/agent-sessions/范德彪/S-0002.md",
    `---
created_at: 2026-02-20T00:00:00Z
---
2026 session`,
  )
  writeMd(root, "rooms/R-001/viewfinder.md", "not a session")
  writeMd(root, "rooms/R-001/agent-sessions/范德彪/random.md", "not S-NNNN form")

  const scanner = scanAgentSessionsFs(root)
  const sessions = await scanner()
  assert.equal(sessions.length, 2)
  const sorted = sessions.sort((a, b) => a.year - b.year)
  assert.equal(sorted[0].year, 2025)
  assert.equal(sorted[0].roomId, "R-001")
  assert.equal(sorted[0].alias, "范德彪")
  assert.ok(sorted[0].digest.includes("session digest body"))
  assert.equal(sorted[1].year, 2026)
})
