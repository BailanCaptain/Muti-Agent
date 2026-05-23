import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"

import { applyWorktreePreviewSeed } from "./worktree-preview-seed"

/**
 * F027 P4 AC-P4-9 d5 · worktree-preview-only seed loader 5 单测.
 * 范-r3 P2-1/2/3/4 修法 + 黄 r4 self P3-1 (fixture schema invalid fail-closed).
 */

function createPhase1Tables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE room_decisions (
      decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      decided_by TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      content TEXT NOT NULL,
      source_message_ids TEXT NOT NULL,
      source_quote TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      tombstone INTEGER NOT NULL DEFAULT 0,
      superseded_by INTEGER,
      fencing_token TEXT NOT NULL,
      extractor_confidence REAL,
      coverage_check_passed INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      reserved_1 TEXT,
      reserved_2 TEXT
    );
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
    CREATE TABLE wiki_leases (
      path TEXT PRIMARY KEY,
      fencing_token TEXT NOT NULL,
      owner_alias TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      leader_term TEXT NOT NULL,
      reserved_1 TEXT,
      reserved_2 TEXT
    );
    CREATE TABLE compiler_leader (
      id INTEGER PRIMARY KEY,
      current_term TEXT NOT NULL,
      leader_alias TEXT,
      acquired_at TEXT,
      renewed_at TEXT,
      lease_expires_at TEXT,
      reserved_1 TEXT,
      reserved_2 TEXT
    );
    CREATE TRIGGER reject_stale_leader
      BEFORE INSERT ON wiki_events
      WHEN EXISTS (SELECT 1 FROM compiler_leader WHERE id = 1)
        AND CAST(NEW.leader_term AS INTEGER) < CAST((SELECT current_term FROM compiler_leader WHERE id = 1) AS INTEGER)
      BEGIN
        SELECT RAISE(ABORT, 'stale leader_term');
      END;
  `)
}

function writeValidFixtures(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "room-decisions.json"),
    JSON.stringify([
      {
        room_id: "R-001", decided_at: "2026-05-23T10:00:00Z", decided_by: "tester",
        decision_type: "spec", content: "test", source_message_ids: "[]",
        source_quote: "q", source_hash: "h1", tombstone: 0, fencing_token: "f1",
      },
    ]),
  )
  fs.writeFileSync(
    path.join(dir, "wiki-events.json"),
    JSON.stringify([
      {
        ts: "2026-05-23T10:00:00Z", alias: "tester", action: "ingest_commit",
        path: "wiki/x.md", fencing_token: "f1", leader_term: "t1",
        result: "ok", state: "committed",
      },
    ]),
  )
  fs.writeFileSync(
    path.join(dir, "wiki-leases.json"),
    JSON.stringify([
      {
        path: "wiki/x.md", fencing_token: "f1", owner_alias: "tester",
        acquired_at: "2026-05-23T10:00:00Z", expires_at: "2099-12-31T00:00:00Z",
        leader_term: "t1",
      },
    ]),
  )
}

const PREVIEW_PATH = "/tmp/.runtime/worktree-preview/data/multi-agent.sqlite"

describe("applyWorktreePreviewSeed", () => {
  it("(1) preview gate off → no-op gateClosed", () => {
    const db = new DatabaseSync(":memory:")
    createPhase1Tables(db)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-t1-"))
    writeValidFixtures(tmpDir)

    const report = applyWorktreePreviewSeed({
      db, sqlitePath: PREVIEW_PATH,
      worktreePreview: undefined, // gate off
      fixtureDir: tmpDir, repoRoot: "/",
    })

    assert.ok(report.gateClosed, "should return gateClosed when WORKTREE_PREVIEW unset")
    assert.match(report.gateClosed.reason, /primary/)
    const count = db.prepare("SELECT COUNT(*) AS n FROM room_decisions").get() as { n: number }
    assert.equal(count.n, 0)
  })

  it("(2) preview gate on but sqlitePath wrong → no-op gateClosed secondary", () => {
    const db = new DatabaseSync(":memory:")
    createPhase1Tables(db)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-t2-"))
    writeValidFixtures(tmpDir)

    const report = applyWorktreePreviewSeed({
      db, sqlitePath: "/some/other/path/multi-agent.sqlite", // not worktree-preview path
      worktreePreview: "1",
      fixtureDir: tmpDir, repoRoot: "/",
    })

    assert.ok(report.gateClosed, "should return gateClosed when sqlitePath wrong")
    assert.match(report.gateClosed.reason, /secondary/)
    const count = db.prepare("SELECT COUNT(*) AS n FROM room_decisions").get() as { n: number }
    assert.equal(count.n, 0)
  })

  it("(3) preview gate on + 3 tables empty → seed inserts all 3 tables", () => {
    const db = new DatabaseSync(":memory:")
    createPhase1Tables(db)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-t3-"))
    writeValidFixtures(tmpDir)

    const report = applyWorktreePreviewSeed({
      db, sqlitePath: PREVIEW_PATH,
      worktreePreview: "1",
      fixtureDir: tmpDir, repoRoot: "/",
    })

    assert.ok(report.inserted, "should return inserted counts")
    assert.equal(report.inserted.room_decisions, 1)
    assert.equal(report.inserted.wiki_events, 1)
    assert.equal(report.inserted.wiki_leases, 1)
    const rd = db.prepare("SELECT COUNT(*) AS n FROM room_decisions").get() as { n: number }
    const we = db.prepare("SELECT COUNT(*) AS n FROM wiki_events").get() as { n: number }
    const wl = db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get() as { n: number }
    assert.equal(rd.n, 1)
    assert.equal(we.n, 1)
    assert.equal(wl.n, 1)
  })

  it("(4) any target table already has rows → whole tx skipped (per-table idempotent)", () => {
    const db = new DatabaseSync(":memory:")
    createPhase1Tables(db)
    // Pre-populate wiki_events with one row to simulate existing data
    db.prepare(`
      INSERT INTO wiki_events (ts, alias, action, path, fencing_token, leader_term, result, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2026-01-01T00:00:00Z", "preexisting", "promote", "wiki/old.md",
      "preexisting-fence", "preexisting-term", "ok", "committed",
    )

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-t4-"))
    writeValidFixtures(tmpDir)

    const report = applyWorktreePreviewSeed({
      db, sqlitePath: PREVIEW_PATH,
      worktreePreview: "1",
      fixtureDir: tmpDir, repoRoot: "/",
    })

    assert.ok(report.skipped, "should skip when any table has rows")
    assert.equal(report.skipped.table, "wiki_events")
    assert.equal(report.skipped.existingRows, 1)
    // room_decisions should remain empty (whole tx skipped, not just wiki_events)
    const rd = db.prepare("SELECT COUNT(*) AS n FROM room_decisions").get() as { n: number }
    assert.equal(rd.n, 0)
  })

  it("(6) fixture wiki_events leader_term CAST→0 < current_term → trigger abort, whole tx rollback (Day 4 inflight bug regression)", () => {
    // Production bug reproduce (Day 4 worktree-preview boot 实测):
    //   - compiler_leader.current_term='4' (scheduler boot 推到 term=4)
    //   - fixture leader_term="seed-term-001" CAST AS INTEGER = 0
    //   - 0 < 4 → reject_stale_leader trigger ABORT 'stale leader_term'
    //   - 整事务 rollback → 3 表全空
    // 修复：fixture leader_term 用纯数字 "999" 永远 ≥ current_term。
    const db = new DatabaseSync(":memory:")
    createPhase1Tables(db)
    // Simulate production: compiler_leader has been promoted to term 4
    db.prepare(`
      INSERT INTO compiler_leader (id, current_term, leader_alias) VALUES (1, '4', 'test-leader')
    `).run()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-t6-"))
    // writeValidFixtures 用 leader_term="t1" CAST→0 < 4 → trigger 触发
    writeValidFixtures(tmpDir)

    const report = applyWorktreePreviewSeed({
      db, sqlitePath: PREVIEW_PATH,
      worktreePreview: "1",
      fixtureDir: tmpDir, repoRoot: "/",
    })

    assert.ok(report.failed, "should fail at INSERT stage when trigger aborts")
    assert.equal(report.failed.stage, "insert")
    assert.match(report.failed.error, /stale leader_term/)
    // Rollback 干净：3 表全空
    const rd = db.prepare("SELECT COUNT(*) AS n FROM room_decisions").get() as { n: number }
    const we = db.prepare("SELECT COUNT(*) AS n FROM wiki_events").get() as { n: number }
    const wl = db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get() as { n: number }
    assert.equal(rd.n, 0)
    assert.equal(we.n, 0)
    assert.equal(wl.n, 0)
  })

  it("(7) fixture leader_term as integer string '999' + current_term=4 → trigger pass, all 3 tables seeded (Day 4 fix verify)", () => {
    const db = new DatabaseSync(":memory:")
    createPhase1Tables(db)
    db.prepare(`
      INSERT INTO compiler_leader (id, current_term, leader_alias) VALUES (1, '4', 'test-leader')
    `).run()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-t7-"))
    fs.writeFileSync(
      path.join(tmpDir, "room-decisions.json"),
      JSON.stringify([{
        room_id: "R-001", decided_at: "2026-05-23T10:00:00Z", decided_by: "tester",
        decision_type: "spec", content: "test", source_message_ids: "[]",
        source_quote: "q", source_hash: "h1", tombstone: 0, fencing_token: "f1",
      }]),
    )
    fs.writeFileSync(
      path.join(tmpDir, "wiki-events.json"),
      JSON.stringify([{
        ts: "2026-05-23T10:00:00Z", alias: "tester", action: "ingest_commit",
        path: "wiki/x.md", fencing_token: "f1",
        leader_term: "999", // fixed: CAST→999 > current_term=4
        result: "ok", state: "committed",
      }]),
    )
    fs.writeFileSync(
      path.join(tmpDir, "wiki-leases.json"),
      JSON.stringify([{
        path: "wiki/x.md", fencing_token: "f1", owner_alias: "tester",
        acquired_at: "2026-05-23T10:00:00Z", expires_at: "2099-12-31T00:00:00Z",
        leader_term: "999",
      }]),
    )

    const report = applyWorktreePreviewSeed({
      db, sqlitePath: PREVIEW_PATH,
      worktreePreview: "1",
      fixtureDir: tmpDir, repoRoot: "/",
    })

    assert.ok(report.inserted)
    assert.equal(report.inserted.room_decisions, 1)
    assert.equal(report.inserted.wiki_events, 1)
    assert.equal(report.inserted.wiki_leases, 1)
  })

  it("(5) fixture JSON schema invalid → fail-closed, no rows inserted (r4 self P3-1)", () => {
    const db = new DatabaseSync(":memory:")
    createPhase1Tables(db)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-t5-"))
    // Write an invalid room-decisions.json (missing required field 'fencing_token')
    fs.writeFileSync(
      path.join(tmpDir, "room-decisions.json"),
      JSON.stringify([{
        room_id: "R-001", decided_at: "2026-05-23T10:00:00Z", decided_by: "tester",
        decision_type: "spec", content: "test", source_message_ids: "[]",
        source_quote: "q", source_hash: "h1", tombstone: 0,
        // fencing_token MISSING - should fail schema validate
      }]),
    )
    fs.writeFileSync(path.join(tmpDir, "wiki-events.json"), "[]")
    fs.writeFileSync(path.join(tmpDir, "wiki-leases.json"), "[]")

    const report = applyWorktreePreviewSeed({
      db, sqlitePath: PREVIEW_PATH,
      worktreePreview: "1",
      fixtureDir: tmpDir, repoRoot: "/",
    })

    assert.ok(report.failed, "should fail at validate stage")
    assert.equal(report.failed.stage, "load_or_validate")
    assert.match(report.failed.error, /fencing_token/)
    // No rows inserted (fail-closed before tx opens)
    const rd = db.prepare("SELECT COUNT(*) AS n FROM room_decisions").get() as { n: number }
    const we = db.prepare("SELECT COUNT(*) AS n FROM wiki_events").get() as { n: number }
    const wl = db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get() as { n: number }
    assert.equal(rd.n, 0)
    assert.equal(we.n, 0)
    assert.equal(wl.n, 0)
  })
})
