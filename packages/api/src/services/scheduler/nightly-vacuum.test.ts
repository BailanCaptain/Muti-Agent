/**
 * F027 P19.9 · NightlyVacuum 测试 — AC-P2-11
 *
 * 覆盖：
 *   - 空 DB → {0,0,0}
 *   - 全部 events < 30 天 → 不 archive
 *   - events ≥ 30 天 → archive jsonl + snapshot jsonl
 *   - snapshot 按 path 去重（多 events 同 path 取 last，committed only）
 *   - 多月分组 → 按 year/month 切 archive 文件
 *   - **AC-P2-11 核心：run() 前后 sqlite_master diff = ∅ + wiki_events 行数不变**
 *     （Iron Laws 1 + plan §13 — archive 是复制不是 move）
 *   - snapshot 只含 committed（pending / aborted 不进 snapshot）
 *   - archive 含全部老事件（不论 state）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { sql } from "drizzle-orm"
import { NightlyVacuum } from "./nightly-vacuum"

function safeTempDir(prefix: string) {
  const runtimeDir = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(runtimeDir, { recursive: true })
  return fs.mkdtempSync(path.join(runtimeDir, prefix))
}
function safeCleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

async function build() {
  const { createDrizzleDb } = await import("../../db/drizzle-instance")
  const tempDir = safeTempDir("nightly-vacuum-")
  const dbPath = path.join(tempDir, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  return {
    db,
    tempDir,
    cleanup: () => {
      close()
      safeCleanup(tempDir)
    },
  }
}

let eventSeq = 0
function insertEvent(
  db: Awaited<ReturnType<typeof build>>["db"],
  opts: {
    ts: string
    path: string
    state?: "pending" | "committed" | "aborted"
    alias?: string
    contentHash?: string
  },
) {
  eventSeq += 1
  db.run(
    sql`INSERT INTO wiki_events (
        ts, alias, action, path, content_hash, attempted_hash,
        fencing_token, leader_term, result, state
      ) VALUES (
        ${opts.ts}, ${opts.alias ?? "A"}, 'write', ${opts.path},
        ${opts.contentHash ?? `sha256:${eventSeq}`}, 'sha256:x',
        ${String(eventSeq)}, '0', 'ok', ${opts.state ?? "committed"}
      )`,
  )
}

function snapshotSqliteMaster(db: Awaited<ReturnType<typeof build>>["db"]): string {
  const rows = db.all<{ sql: string | null; name: string; type: string }>(
    sql`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`,
  )
  return JSON.stringify(rows)
}

function countWikiEvents(db: Awaited<ReturnType<typeof build>>["db"]): number {
  const row = db.get<{ c: number }>(sql`SELECT COUNT(*) AS c FROM wiki_events`)
  return row?.c ?? 0
}

function readJsonl(absPath: string): unknown[] {
  if (!fs.existsSync(absPath)) return []
  return fs
    .readFileSync(absPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

const NOW = new Date("2026-06-15T00:00:00.000Z")
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString()
}

test("NightlyVacuum · 空 DB → {0,0,0}", async () => {
  const { db, cleanup } = await build()
  try {
    const vacuum = new NightlyVacuum({ db, clock: () => NOW })
    const result = vacuum.run()
    assert.deepEqual(
      { s: result.scannedEvents, a: result.archivedEvents, sn: result.snapshotEntries },
      { s: 0, a: 0, sn: 0 },
    )
    assert.equal(result.archiveFiles.length, 0)
    assert.equal(result.snapshotFiles.length, 0)
  } finally {
    cleanup()
  }
})

test("NightlyVacuum · 全部 events < 30 天 → 不 archive", async () => {
  const { db, tempDir, cleanup } = await build()
  try {
    insertEvent(db, { ts: daysAgo(5), path: "wiki/a.md" })
    insertEvent(db, { ts: daysAgo(29), path: "wiki/b.md" })
    const vacuum = new NightlyVacuum({ db, rootDir: tempDir, clock: () => NOW })
    const result = vacuum.run()
    assert.equal(result.scannedEvents, 0, "29 天 < 30 天阈值，不 archive")
  } finally {
    cleanup()
  }
})

test("NightlyVacuum · events ≥ 30 天 → archive + snapshot jsonl", async () => {
  const { db, tempDir, cleanup } = await build()
  try {
    insertEvent(db, { ts: daysAgo(40), path: "wiki/old-1.md", contentHash: "sha256:c1" })
    insertEvent(db, { ts: daysAgo(35), path: "wiki/old-2.md", contentHash: "sha256:c2" })
    insertEvent(db, { ts: daysAgo(5), path: "wiki/recent.md" }) // 不该被 archive

    const vacuum = new NightlyVacuum({ db, rootDir: tempDir, clock: () => NOW })
    const result = vacuum.run()

    assert.equal(result.scannedEvents, 2)
    assert.equal(result.archivedEvents, 2)
    assert.equal(result.snapshotEntries, 2)
    assert.equal(result.archiveFiles.length, 1, "40+35 天都在 2026-05 月 → 1 archive 文件")
    assert.equal(result.snapshotFiles.length, 1)

    // 验证 archive jsonl 内容
    const archiveAbs = path.join(tempDir, result.archiveFiles[0])
    const archived = readJsonl(archiveAbs)
    assert.equal(archived.length, 2)

    // 验证 snapshot jsonl 内容
    const snapshotAbs = path.join(tempDir, result.snapshotFiles[0])
    const snapshot = readJsonl(snapshotAbs) as Array<{ path: string; lastContentHash: string }>
    assert.equal(snapshot.length, 2)
    const byCh = new Map(snapshot.map((s) => [s.path, s.lastContentHash]))
    assert.equal(byCh.get("wiki/old-1.md"), "sha256:c1")
    assert.equal(byCh.get("wiki/old-2.md"), "sha256:c2")
  } finally {
    cleanup()
  }
})

test("NightlyVacuum · snapshot 按 path 去重 — 同月多 events 同 path 取 last", async () => {
  const { db, tempDir, cleanup } = await build()
  try {
    // 同 path 3 个老 event 全在 2026-05 月内（snapshot 按月切文件 — 同月去重）
    insertEvent(db, { ts: "2026-05-06T00:00:00.000Z", path: "wiki/evolving.md", contentHash: "sha256:v1" })
    insertEvent(db, { ts: "2026-05-11T00:00:00.000Z", path: "wiki/evolving.md", contentHash: "sha256:v2" })
    insertEvent(db, { ts: "2026-05-15T00:00:00.000Z", path: "wiki/evolving.md", contentHash: "sha256:v3" })

    const vacuum = new NightlyVacuum({ db, rootDir: tempDir, clock: () => NOW })
    const result = vacuum.run()

    assert.equal(result.scannedEvents, 3, "archive 含全部 3 个事件")
    assert.equal(result.snapshotEntries, 1, "snapshot 同 path 去重 → 1 条")

    const snapshot = readJsonl(path.join(tempDir, result.snapshotFiles[0])) as Array<{
      path: string
      lastContentHash: string
    }>
    assert.equal(snapshot.length, 1)
    assert.equal(snapshot[0].lastContentHash, "sha256:v3", "取最后一个 content_hash")
  } finally {
    cleanup()
  }
})

test("NightlyVacuum · snapshot 只含 committed（pending / aborted 不进 snapshot）", async () => {
  const { db, tempDir, cleanup } = await build()
  try {
    insertEvent(db, { ts: daysAgo(40), path: "wiki/committed.md", state: "committed" })
    insertEvent(db, { ts: daysAgo(40), path: "wiki/pending.md", state: "pending" })
    insertEvent(db, { ts: daysAgo(40), path: "wiki/aborted.md", state: "aborted" })

    const vacuum = new NightlyVacuum({ db, rootDir: tempDir, clock: () => NOW })
    const result = vacuum.run()

    assert.equal(result.scannedEvents, 3, "archive 含全部 3 个（不论 state）")
    assert.equal(result.snapshotEntries, 1, "snapshot 仅 committed 1 个")

    const snapshot = readJsonl(path.join(tempDir, result.snapshotFiles[0])) as Array<{
      path: string
    }>
    assert.deepEqual(
      snapshot.map((s) => s.path),
      ["wiki/committed.md"],
    )
  } finally {
    cleanup()
  }
})

test("NightlyVacuum · 多月分组 → 按 year/month 切 archive 文件", async () => {
  const { db, tempDir, cleanup } = await build()
  try {
    // 用绝对 ts 跨 2 个月
    insertEvent(db, { ts: "2026-03-10T00:00:00.000Z", path: "wiki/march.md" })
    insertEvent(db, { ts: "2026-04-10T00:00:00.000Z", path: "wiki/april.md" })

    const vacuum = new NightlyVacuum({ db, rootDir: tempDir, clock: () => NOW })
    const result = vacuum.run()

    assert.equal(result.scannedEvents, 2)
    assert.equal(result.archiveFiles.length, 2, "3 月 + 4 月 → 2 个 archive 文件")
    // 验证路径含 year/month
    assert.ok(result.archiveFiles.some((f) => f.includes("2026/03.jsonl")))
    assert.ok(result.archiveFiles.some((f) => f.includes("2026/04.jsonl")))
  } finally {
    cleanup()
  }
})

// ── AC-P2-11 核心：DB 完全不变 ────────────────────────────────────────

test("NightlyVacuum · AC-P2-11: run() 前后 sqlite_master diff = ∅ + 行数不变", async () => {
  const { db, tempDir, cleanup } = await build()
  try {
    insertEvent(db, { ts: daysAgo(40), path: "wiki/a.md" })
    insertEvent(db, { ts: daysAgo(50), path: "wiki/b.md" })
    insertEvent(db, { ts: daysAgo(5), path: "wiki/recent.md" })

    const masterBefore = snapshotSqliteMaster(db)
    const countBefore = countWikiEvents(db)

    const vacuum = new NightlyVacuum({ db, rootDir: tempDir, clock: () => NOW })
    const result = vacuum.run()
    assert.equal(result.scannedEvents, 2)

    const masterAfter = snapshotSqliteMaster(db)
    const countAfter = countWikiEvents(db)

    assert.equal(masterAfter, masterBefore, "sqlite_master schema diff 必须 = ∅（不引表/索引）")
    assert.equal(countAfter, countBefore, "wiki_events 行数不变（archive 是复制不是 move）")
    assert.equal(countAfter, 3, "3 行全保留（含 2 个被 archive 的老事件）")
  } finally {
    cleanup()
  }
})

test("NightlyVacuum · AC-P2-11: 老事件 archive 后 DB 行 state 不变（不软删）", async () => {
  const { db, tempDir, cleanup } = await build()
  try {
    insertEvent(db, { ts: daysAgo(40), path: "wiki/x.md", state: "committed" })
    const vacuum = new NightlyVacuum({ db, rootDir: tempDir, clock: () => NOW })
    vacuum.run()
    const row = db.get<{ state: string }>(
      sql`SELECT state FROM wiki_events WHERE path = 'wiki/x.md'`,
    )
    assert.equal(row?.state, "committed", "archive 不改 state（不存在 archived state）")
  } finally {
    cleanup()
  }
})

test("NightlyVacuum · atomic write — archive/snapshot 无 .tmp 残留", async () => {
  const { db, tempDir, cleanup } = await build()
  try {
    insertEvent(db, { ts: daysAgo(40), path: "wiki/a.md" })
    const vacuum = new NightlyVacuum({ db, rootDir: tempDir, clock: () => NOW })
    const result = vacuum.run()
    for (const f of [...result.archiveFiles, ...result.snapshotFiles]) {
      const abs = path.join(tempDir, f)
      assert.ok(fs.existsSync(abs))
      assert.equal(fs.existsSync(`${abs}.tmp`), false, ".tmp 应在 rename 后消失")
    }
  } finally {
    cleanup()
  }
})
