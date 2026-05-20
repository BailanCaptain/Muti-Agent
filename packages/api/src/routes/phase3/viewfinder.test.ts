/**
 * F027 Phase 3 P20 · ViewfinderService tests — Week 1 Day 3
 *
 * 覆盖：
 *   - 文件不存在 → viewfinder=null + empty coverage + ledger 正常
 *   - 文件存在且 frontmatter 完整 → 解析 coverage / lastCompiledAt
 *   - frontmatter "85% (17/20)" → broad=20 / resolved=17 / coverage=0.85
 *   - frontmatter "unknown (broad=2)" → broad=2 / coverage=null / status=warn
 *   - frontmatter 缺 inputs → emptyCoverage()
 *   - ledger 查 active count + latest decision id（含 superseded 过滤）
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { createDrizzleDb } from "../../db/drizzle-instance"
import { ViewfinderService } from "./viewfinder"

function safeTempDir(prefix: string): string {
  const base = path.join(process.cwd(), ".runtime")
  fs.mkdirSync(base, { recursive: true })
  return fs.mkdtempSync(path.join(base, prefix))
}
function safeCleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // best effort
  }
}

async function writeViewfinder(
  wikiRoot: string,
  roomId: string,
  content: string,
): Promise<void> {
  const abs = path.join(wikiRoot, "wiki", "rooms", roomId, "viewfinder.md")
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content, "utf-8")
}

function insertDecision(
  db: ReturnType<typeof createDrizzleDb>["db"],
  roomId: string,
  opts: { tombstone?: boolean; supersededBy?: number | null; status?: string } = {},
): number {
  const tombstone = opts.tombstone ? 1 : 0
  const supersededBy = opts.supersededBy ?? null
  const status = opts.status ?? "active"
  const client = (
    db as unknown as {
      $client: {
        prepare: (sql: string) => {
          run: (...args: unknown[]) => { lastInsertRowid: number | bigint }
        }
      }
    }
  ).$client
  const result = client
    .prepare(
      `INSERT INTO room_decisions (
        room_id, decided_at, decided_by, decision_type, content,
        source_message_ids, source_quote, source_hash,
        tombstone, superseded_by, fencing_token,
        extractor_confidence, coverage_check_passed, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      roomId,
      new Date().toISOString(),
      "黄仁勋",
      "commit",
      "test decision",
      "[]",
      "test quote",
      "hash",
      tombstone,
      supersededBy,
      "fence-1",
      null,
      status,
    )
  return Number(result.lastInsertRowid)
}

test("Day 3 · ViewfinderService · 文件不存在 → null + empty coverage + 空 ledger", async () => {
  const tmp = safeTempDir("F027-Day3-vf-empty-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const svc = new ViewfinderService({ db, wikiRoot: tmp })
    const r = await svc.getViewfinder("R-999")
    assert.equal(r.viewfinder, null)
    assert.equal(r.lastCompiledAt, null)
    assert.deepEqual(r.coverage, {
      broad: 0,
      resolved: 0,
      unresolved: 0,
      coverage: null,
      status: "fail",
    })
    assert.deepEqual(r.ledger, { activeCount: 0, latestDecisionId: null })
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 3 · ViewfinderService · frontmatter '85% (17/20)' 解析", async () => {
  const tmp = safeTempDir("F027-Day3-vf-pct-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const fm = [
      "---",
      "viewfinder_id: vf-201-1",
      "generated_at: 2026-05-20T10:00:00Z",
      "generated_by: RoomCompiler (rule-based template)",
      "inputs:",
      "  last_committed_cursor: 42",
      "  decision_ledger_count: 5",
      "  coverage: 85% (17/20)",
      "coverage_status: pass",
      "---",
      "# Viewfinder body",
    ].join("\n")
    await writeViewfinder(tmp, "R-201", fm)

    const svc = new ViewfinderService({ db, wikiRoot: tmp })
    const r = await svc.getViewfinder("R-201")
    assert.ok(r.viewfinder)
    assert.ok(r.viewfinder?.includes("# Viewfinder body"))
    assert.equal(r.lastCompiledAt, "2026-05-20T10:00:00Z")
    assert.equal(r.coverage.broad, 20)
    assert.equal(r.coverage.resolved, 17)
    assert.equal(r.coverage.unresolved, 3)
    assert.ok(r.coverage.coverage !== null)
    assert.ok(Math.abs((r.coverage.coverage ?? 0) - 0.85) < 0.001)
    assert.equal(r.coverage.status, "pass")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 3 · ViewfinderService · frontmatter 'unknown (broad=2)' 解析 → status=warn", async () => {
  const tmp = safeTempDir("F027-Day3-vf-unknown-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const fm = [
      "---",
      "viewfinder_id: vf-201-1",
      "generated_at: 2026-05-20T10:00:00Z",
      "inputs:",
      "  coverage: unknown (broad=2)",
      "coverage_status: unknown",
      "---",
      "body",
    ].join("\n")
    await writeViewfinder(tmp, "R-201", fm)

    const svc = new ViewfinderService({ db, wikiRoot: tmp })
    const r = await svc.getViewfinder("R-201")
    assert.equal(r.coverage.broad, 2)
    assert.equal(r.coverage.coverage, null)
    assert.equal(r.coverage.status, "warn")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 3 · ViewfinderService · ledger active count + latestDecisionId", async () => {
  const tmp = safeTempDir("F027-Day3-vf-ledger-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    // 3 active + 1 superseded + 1 completed = active 应为 3
    insertDecision(db, "R-201")
    insertDecision(db, "R-201")
    const lastId = insertDecision(db, "R-201")
    insertDecision(db, "R-201", { supersededBy: lastId })
    insertDecision(db, "R-201", { status: "completed" })

    const svc = new ViewfinderService({ db, wikiRoot: tmp })
    const r = await svc.getViewfinder("R-201")
    assert.equal(r.ledger.activeCount, 3, "3 rows have status=active AND superseded_by IS NULL")
    assert.ok(r.ledger.latestDecisionId, "latestDecisionId should not be null")
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 3 · ViewfinderService · 不同 room 隔离", async () => {
  const tmp = safeTempDir("F027-Day3-vf-isolation-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    insertDecision(db, "R-201")
    insertDecision(db, "R-202")
    insertDecision(db, "R-202")

    const svc = new ViewfinderService({ db, wikiRoot: tmp })
    const a = await svc.getViewfinder("R-201")
    const b = await svc.getViewfinder("R-202")
    assert.equal(a.ledger.activeCount, 1)
    assert.equal(b.ledger.activeCount, 2)
  } finally {
    close()
    safeCleanup(tmp)
  }
})

test("Day 3 · ViewfinderService · frontmatter 缺 inputs.coverage → emptyCoverage", async () => {
  const tmp = safeTempDir("F027-Day3-vf-no-coverage-")
  const dbPath = path.join(tmp, "test.sqlite")
  const { db, close } = createDrizzleDb(dbPath)
  try {
    const fm = "---\nviewfinder_id: vf-1\ngenerated_at: 2026-05-20T00:00:00Z\n---\nbody"
    await writeViewfinder(tmp, "R-201", fm)

    const svc = new ViewfinderService({ db, wikiRoot: tmp })
    const r = await svc.getViewfinder("R-201")
    assert.equal(r.coverage.broad, 0)
    assert.equal(r.coverage.coverage, null)
    assert.equal(r.coverage.status, "fail")
    assert.equal(r.lastCompiledAt, "2026-05-20T00:00:00Z")
  } finally {
    close()
    safeCleanup(tmp)
  }
})
