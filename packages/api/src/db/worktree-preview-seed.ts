import fs from "node:fs"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"

/**
 * F027 P4 AC-P4-9 d5 · worktree-preview-only data seed loader.
 *
 * 实测翻车前提（v5 修）:
 *   - 不做 DB 文件 copy/swap/checkpoint/rename (那是 v3 AC-P4-7 已取消的路径)
 *   - 纯 BEGIN IMMEDIATE 单事务内 INSERT 3 张 Phase 1 空表 (room_decisions / wiki_events / wiki_leases)
 *   - per-table idempotent: 每表 COUNT(*)=0 才 seed; 任一表已有 rows 整事务跳过
 *   - prompt_audit 永不 fixture seed (production write path only via AC-P4-8 真房间 recall)
 *
 * Double gate (生产隔离):
 *   - primary: WORKTREE_PREVIEW=1 (scripts/worktree-preview.ts 注入)
 *   - secondary: sqlitePath 路径包含 ".runtime/worktree-preview/"
 *   - 两道全过才 seed; 任一不满足 → no-op return {gateClosed: true}
 *
 * Fail-closed: fixture JSON schema invalid → 整事务 rollback 不留半 seed + 抛错 alert.
 */

const FIXTURE_DIR_DEFAULT = "tests/fixtures/db-seed"

const REQUIRED_ROOM_DECISION_FIELDS = [
  "room_id", "decided_at", "decided_by", "decision_type",
  "content", "source_message_ids", "source_quote", "source_hash",
  "tombstone", "fencing_token",
] as const

const REQUIRED_WIKI_EVENT_FIELDS = [
  "ts", "alias", "action", "path",
  "fencing_token", "leader_term", "result", "state",
] as const

const REQUIRED_WIKI_LEASE_FIELDS = [
  "path", "fencing_token", "owner_alias",
  "acquired_at", "expires_at", "leader_term",
] as const

export type SeedReport = {
  gateClosed?: { reason: string }
  skipped?: { table: string; existingRows: number }
  inserted?: { room_decisions: number; wiki_events: number; wiki_leases: number }
  failed?: { stage: string; error: string }
}

export type SeedOpts = {
  db: DatabaseSync
  sqlitePath: string
  /** primary gate. defaults to process.env.WORKTREE_PREVIEW */
  worktreePreview?: string | undefined
  /** fixture root, relative to repoRoot. defaults to tests/fixtures/db-seed */
  fixtureDir?: string
  /** repoRoot for resolving fixtureDir. defaults to process.cwd() */
  repoRoot?: string
}

export function applyWorktreePreviewSeed(opts: SeedOpts): SeedReport {
  // ─── Double gate ─────────────────────────────────────────────────────────
  const gate = opts.worktreePreview ?? process.env.WORKTREE_PREVIEW
  if (gate !== "1") {
    return { gateClosed: { reason: "WORKTREE_PREVIEW gate not set to 1 (primary)" } }
  }
  // Normalize Windows backslash → forward slash so path check works on both OS.
  const normalizedPath = opts.sqlitePath.replace(/\\/g, "/")
  if (!normalizedPath.includes(".runtime/worktree-preview/")) {
    return { gateClosed: { reason: "sqlitePath does not contain .runtime/worktree-preview/ (secondary)" } }
  }

  // ─── Per-table idempotent: any table with rows → skip the whole transaction ──
  for (const table of ["room_decisions", "wiki_events", "wiki_leases"]) {
    const row = opts.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    if (row.n > 0) {
      return { skipped: { table, existingRows: row.n } }
    }
  }

  // ─── Load + validate fixtures (fail-closed before opening tx) ─────────────
  const fixtureRoot = path.resolve(
    opts.repoRoot ?? process.cwd(),
    opts.fixtureDir ?? FIXTURE_DIR_DEFAULT,
  )
  let roomDecisions: unknown[]
  let wikiEvents: unknown[]
  let wikiLeases: unknown[]
  try {
    roomDecisions = readFixture(path.join(fixtureRoot, "room-decisions.json"))
    wikiEvents = readFixture(path.join(fixtureRoot, "wiki-events.json"))
    wikiLeases = readFixture(path.join(fixtureRoot, "wiki-leases.json"))
    validateSchema(roomDecisions, REQUIRED_ROOM_DECISION_FIELDS, "room_decisions")
    validateSchema(wikiEvents, REQUIRED_WIKI_EVENT_FIELDS, "wiki_events")
    validateSchema(wikiLeases, REQUIRED_WIKI_LEASE_FIELDS, "wiki_leases")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[worktree-preview-seed] fail-closed at load/validate: ${msg}`)
    return { failed: { stage: "load_or_validate", error: msg } }
  }

  // ─── Single transaction INSERT 3 tables (BEGIN IMMEDIATE + rollback on err) ──
  opts.db.exec("BEGIN IMMEDIATE")
  try {
    insertRoomDecisions(opts.db, roomDecisions as RoomDecisionRow[])
    insertWikiEvents(opts.db, wikiEvents as WikiEventRow[])
    insertWikiLeases(opts.db, wikiLeases as WikiLeaseRow[])
    opts.db.exec("COMMIT")
  } catch (err) {
    opts.db.exec("ROLLBACK")
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[worktree-preview-seed] fail-closed at INSERT: ${msg}`)
    return { failed: { stage: "insert", error: msg } }
  }

  return {
    inserted: {
      room_decisions: roomDecisions.length,
      wiki_events: wikiEvents.length,
      wiki_leases: wikiLeases.length,
    },
  }
}

function readFixture(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`fixture not found: ${filePath}`)
  }
  const raw = fs.readFileSync(filePath, "utf-8")
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`fixture not an array: ${filePath}`)
  }
  return parsed
}

function validateSchema(
  rows: unknown[],
  required: readonly string[],
  tableName: string,
): void {
  rows.forEach((row, idx) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`${tableName}[${idx}] not an object`)
    }
    for (const field of required) {
      if (!(field in row)) {
        throw new Error(`${tableName}[${idx}] missing required field: ${field}`)
      }
    }
  })
}

type RoomDecisionRow = {
  room_id: string
  decided_at: string
  decided_by: string
  decision_type: string
  content: string
  source_message_ids: string
  source_quote: string
  source_hash: string
  tombstone: number
  fencing_token: string
  extractor_confidence?: number
  coverage_check_passed?: number
  status?: string
}

function insertRoomDecisions(db: DatabaseSync, rows: RoomDecisionRow[]): void {
  const stmt = db.prepare(`
    INSERT INTO room_decisions (
      room_id, decided_at, decided_by, decision_type, content,
      source_message_ids, source_quote, source_hash, tombstone,
      fencing_token, extractor_confidence, coverage_check_passed, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of rows) {
    stmt.run(
      row.room_id, row.decided_at, row.decided_by, row.decision_type, row.content,
      row.source_message_ids, row.source_quote, row.source_hash, row.tombstone,
      row.fencing_token,
      row.extractor_confidence ?? null,
      row.coverage_check_passed ?? null,
      row.status ?? "active",
    )
  }
}

type WikiEventRow = {
  ts: string
  alias: string
  action: string
  path: string
  fencing_token: string
  leader_term: string
  result: string
  state: string
  diff_summary?: string
  promotion_target?: string
  reason?: string
}

function insertWikiEvents(db: DatabaseSync, rows: WikiEventRow[]): void {
  const stmt = db.prepare(`
    INSERT INTO wiki_events (
      ts, alias, action, path, fencing_token, leader_term, result, state,
      diff_summary, promotion_target, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of rows) {
    stmt.run(
      row.ts, row.alias, row.action, row.path,
      row.fencing_token, row.leader_term, row.result, row.state,
      row.diff_summary ?? null,
      row.promotion_target ?? null,
      row.reason ?? null,
    )
  }
}

type WikiLeaseRow = {
  path: string
  fencing_token: string
  owner_alias: string
  acquired_at: string
  expires_at: string
  leader_term: string
}

function insertWikiLeases(db: DatabaseSync, rows: WikiLeaseRow[]): void {
  const stmt = db.prepare(`
    INSERT INTO wiki_leases (
      path, fencing_token, owner_alias, acquired_at, expires_at, leader_term
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const row of rows) {
    stmt.run(
      row.path, row.fencing_token, row.owner_alias,
      row.acquired_at, row.expires_at, row.leader_term,
    )
  }
}
