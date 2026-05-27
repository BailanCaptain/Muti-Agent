/**
 * F027 v3 G2 · cron scanner 真业务接通 (替换 scheduler-bootstrap.ts 5 个 async () => [])
 *
 * 真相源:
 *   - scheduler-bootstrap.ts:183-205 — 原 5 个 noop fallback
 *   - F027 v3 audit summary G2 — 标 P0: "5 cron jobs scan callback 真业务接通"
 *   - V16.5 chap 17 line 1800-1854 (NightlyHealthCheck) + chap 11 (MonthlySnapshot drift)
 *
 * ⚠️ wikiRoot 约定（G2 r2 codex review FAIL 后明确）:
 *   wikiRoot 必须指向 **markdown 文件实际根目录**，即满足 `<wikiRoot>/rooms/<id>/viewfinder.md`
 *   能直接读到真文件的那一层 — 不是 namespace 外层（如 `.runtime/wiki/`）。
 *
 *   真实文件结构: `.runtime/wiki/wiki/rooms/<id>/viewfinder.md`（注意双 `wiki/`）
 *   ✅ 正确传值: `.runtime/wiki/wiki` (markdown 实际根 — 与 RoomCompileExecutor 同口径)
 *   ❌ 错误传值: `.runtime/wiki`     (namespace 外层 — scanner 全扫不到真文件)
 *
 *   server.ts:849 + :911 用 `roomCompileWikiRoot = path.join(<wikiServicesRoot>, "wiki")` 统一约定。
 *   未来 caller 见 server.ts:822-829 注释（不一致的 ViewfinderService vs RoomCompiler.run() 历史）。
 *
 * 5 个 scanner:
 *   1. scanWikiEntitiesFs(wikiRoot)        → NightlyHealthCheck.scanEntities
 *   2. scanWikiDraftsFs(wikiRoot)          → WeeklyDraftDigest.scanDrafts
 *   3. scanDriftTriggersDb(db)             → DriftDetector.scanTriggers
 *   4. scanRoomViewfindersForSnapshot()    → MonthlySnapshot.recompileAllRooms
 *      (MVP: 读 current viewfinder.md，recompiledViewfinder = current —
 *       真 LLM-from-scratch 重编需独立 F-id 接 RoomCompiler.compileFromScratch)
 *   5. scanAgentSessionsFs(wikiRoot)       → ArchiveYearlySessions.scanSessions
 *
 * 设计取舍:
 *   - fs 扫遍 wiki 树 vs SQL 查 — 走 fs 因为 wiki/rooms/<id>/{viewfinder,log,decisions}.md
 *     是文件单一真相源 (RoomCompiler 落盘)，DB 只存 wiki_events / wiki_memories metadata。
 *   - frontmatter 用 lite parser (`---\nyaml\n---\nbody` 三段切)；不引入 gray-matter 避免新依赖。
 *   - 路径用 POSIX 化 (\\→/) 让 NightlyHealthCheck.normalizePath / classifyDraftPath 等
 *     已有 path 检测一致。
 *   - fail-soft: 单文件 read/parse 错跳过 + warn，不影响整体 scan。
 */

import fs from "node:fs"
import path from "node:path"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyBaseLogger } from "fastify"
import type * as schema from "../../db/schema"
import type { SqliteAdapterLike } from "../../wiki/room-compiler/sqlite-checkpoint-store"
import type { DraftEntry } from "./weekly-draft-digest"
import type { DriftTrigger } from "./drift-detector"
import type { RoomSnapshot } from "./monthly-snapshot"
import type { SessionEntry } from "./archive-yearly-sessions"
import type { WikiEntity, WikiFrontmatter } from "./nightly-health-check"

type DrizzleDb = BetterSQLite3Database<typeof schema>

// ── frontmatter parser (lite) ───────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/**
 * 极简 yaml frontmatter 解析: `---\nyaml\n---\nbody` → {frontmatter, body}
 * 只解析 scalar (string/bool/number) + 简单 array (`field: [a, b]`)。
 * 不支持嵌套 object / multi-line scalar — 本项目 frontmatter 不用。
 */
export function parseFrontmatter(raw: string): {
  frontmatter: WikiFrontmatter
  body: string
} {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { frontmatter: {}, body: raw }
  const yamlBody = m[1]
  const body = m[2]
  const fm: Record<string, unknown> = {}
  for (const line of yamlBody.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const colon = trimmed.indexOf(":")
    if (colon < 1) continue
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim()
    if (!key) continue
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0)
      continue
    }
    if (value === "true") fm[key] = true
    else if (value === "false") fm[key] = false
    else if (/^-?\d+(\.\d+)?$/.test(value)) fm[key] = Number(value)
    else fm[key] = value.replace(/^["']|["']$/g, "")
  }
  return { frontmatter: fm as WikiFrontmatter, body }
}

// ── fs 工具 ────────────────────────────────────────────────────────────

/** 递归 walk dir，返所有 .md 文件 (相对 root 的 posix 路径)。dir 不存在 → 空数组。 */
function walkMdFiles(root: string, dir: string): string[] {
  const acc: string[] = []
  const absDir = path.join(root, dir)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const ent of entries) {
    const childRel = path.posix.join(dir.replace(/\\/g, "/"), ent.name)
    if (ent.isDirectory()) {
      acc.push(...walkMdFiles(root, childRel))
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      acc.push(childRel)
    }
  }
  return acc
}

function safeReadFile(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf-8")
  } catch {
    return null
  }
}

// ── 1. scanWikiEntitiesFs (NightlyHealthCheck) ─────────────────────────

/**
 * Scan wiki/**\/*.md → WikiEntity[]（path / frontmatter / body）。
 *
 * @param wikiRoot 绝对路径，目录形如 `.../wiki/`（含 rooms/agents/concepts 子目录）。
 * @returns Promise<WikiEntity[]>；wikiRoot 不存在 / 空 → []。
 */
export function scanWikiEntitiesFs(
  wikiRoot: string,
  logger?: FastifyBaseLogger,
): () => Promise<WikiEntity[]> {
  return async () => {
    const relPaths = walkMdFiles(wikiRoot, ".")
    const entities: WikiEntity[] = []
    for (const rel of relPaths) {
      const absPath = path.join(wikiRoot, rel)
      const raw = safeReadFile(absPath)
      if (raw === null) {
        logger?.warn({ rel }, "[wiki-scanner] read failed (skipped)")
        continue
      }
      try {
        const { frontmatter, body } = parseFrontmatter(raw)
        // entity.path = repo-relative form `wiki/...md` (with wiki/ prefix, NightlyHealthCheck
        // 期望 path-style 真实路径；NightlyHealthCheck.deadLink 检测会 normalize 对比)
        entities.push({ path: `wiki/${rel}`, frontmatter, body })
      } catch (err) {
        logger?.warn({ rel, err: (err as Error).message }, "[wiki-scanner] parse failed (skipped)")
      }
    }
    return entities
  }
}

// ── 2. scanWikiDraftsFs (WeeklyDraftDigest) ────────────────────────────

/**
 * Scan wiki/**\/draft/**\/*.md → DraftEntry[]。
 *
 * 不区分 user-drop vs subdir — WeeklyDraftDigest.classifyDraftPath 内部按 path 判定。
 * Scope: 所有 6 桶 (concepts/rules/methods/lessons/rooms/episodes) 的 draft/ 子目录。
 */
export function scanWikiDraftsFs(
  wikiRoot: string,
  logger?: FastifyBaseLogger,
): () => Promise<DraftEntry[]> {
  return async () => {
    const drafts: DraftEntry[] = []
    const allMd = walkMdFiles(wikiRoot, ".")
    for (const rel of allMd) {
      const posix = rel.replace(/\\/g, "/")
      if (!posix.includes("/draft/")) continue
      const absPath = path.join(wikiRoot, rel)
      const raw = safeReadFile(absPath)
      if (raw === null) {
        logger?.warn({ rel }, "[wiki-scanner] draft read failed (skipped)")
        continue
      }
      try {
        const { frontmatter } = parseFrontmatter(raw)
        const title =
          typeof frontmatter.title === "string" ? (frontmatter.title as string) : undefined
        const createdAt =
          typeof frontmatter.created_at === "string"
            ? (frontmatter.created_at as string)
            : undefined
        drafts.push({ path: `wiki/${posix}`, title, createdAt })
      } catch (err) {
        logger?.warn(
          { rel, err: (err as Error).message },
          "[wiki-scanner] draft parse failed (skipped)",
        )
      }
    }
    return drafts
  }
}

// ── 3. scanDriftTriggersDb (DriftDetector) ─────────────────────────────

/**
 * 数据库扫 drift trigger:
 *
 * - new_lesson: wiki_events 写 lessons 桶 (path LIKE '%lessons/%' + action='write') 最近 7d
 * - handoff_failure: a2a_calls.status='failed' 最近 7d
 * - model_upgrade: 需对比 wiki/agents/<alias>.md frontmatter model 变化历史 — 当前缺
 *   "model snapshot table" 状态比对基础设施，本 scanner 暂不实施（返 [] 不噪音）；
 *   model_upgrade trigger 等独立 F-id 加 model_snapshots 表后接入。
 *
 * processedTriggerKeys 由 DriftDetector 内部跨 run 去重，本 scanner 不负责持久化。
 */
export function scanDriftTriggersDb(
  db: DrizzleDb,
  logger?: FastifyBaseLogger,
): () => Promise<DriftTrigger[]> {
  return async () => {
    const adapter = adaptDrizzleDb(db)
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const triggers: DriftTrigger[] = []

    // new_lesson · wiki_events 最近 7d 写 lessons 桶
    try {
      const rows = adapter
        .prepare(
          `SELECT path, alias, ts FROM wiki_events
            WHERE state = 'committed'
              AND action IN ('write', 'append', 'patch')
              AND path LIKE '%lessons/%'
              AND ts >= ?
            ORDER BY ts DESC
            LIMIT 50`,
        )
        .all(sevenDaysAgoIso) as ReadonlyArray<{
        path: string
        alias: string
        ts: string
      }>
      for (const r of rows) {
        // ref = filename without dir (e.g. LL-031.md → LL-031)
        const basename = r.path.split("/").pop() ?? r.path
        const ref = basename.replace(/\.md$/, "")
        triggers.push({
          kind: "new_lesson",
          ref,
          detail: `新 lesson 写入 ${r.path} @ ${r.ts} by ${r.alias}`,
        })
      }
    } catch (err) {
      logger?.warn(
        { err: (err as Error).message },
        "[wiki-scanner] drift new_lesson scan failed (skipped)",
      )
    }

    // handoff_failure · a2a_calls 最近 7d 失败
    try {
      const rows = adapter
        .prepare(
          `SELECT call_id, issuer_id, convener_id, updated_at FROM a2a_calls
            WHERE status = 'failed'
              AND updated_at >= ?
            ORDER BY updated_at DESC
            LIMIT 50`,
        )
        .all(sevenDaysAgoIso) as ReadonlyArray<{
        call_id: string
        issuer_id: string
        convener_id: string
        updated_at: string
      }>
      for (const r of rows) {
        triggers.push({
          kind: "handoff_failure",
          ref: r.call_id,
          detail: `handoff ${r.call_id} ${r.issuer_id}→${r.convener_id} failed @ ${r.updated_at}`,
        })
      }
    } catch (err) {
      logger?.warn(
        { err: (err as Error).message },
        "[wiki-scanner] drift handoff_failure scan failed (skipped)",
      )
    }

    return triggers
  }
}

// ── 4. scanRoomViewfindersForSnapshot (MonthlySnapshot) ────────────────

/**
 * MonthlySnapshot.recompileAllRooms MVP 实现:
 *
 * 扫所有活跃 room (session_groups.room_id IS NOT NULL)，
 * 读 `<wikiRoot>/rooms/<roomId>/viewfinder.md` current 内容，
 * 返 RoomSnapshot[] 让 MonthlySnapshot 算 drift 决定 replace。
 *
 * **MVP 限制**: recompiledViewfinder = currentViewfinder（无 drift） — 真"从原始
 * transcript 全量重编"需 RoomCompiler.compileFromScratch 路径 (LLM 重活)，独立 F-id 接。
 * 当前实现仍比 noop 强: backup 保护 + replace 决策路径全活，drift threshold 调用真触发。
 *
 * 等 LLM-from-scratch 接进来后只改本函数 recompiledViewfinder 取值。
 */
export function scanRoomViewfindersForSnapshot(
  db: DrizzleDb,
  wikiRoot: string,
  logger?: FastifyBaseLogger,
): () => Promise<RoomSnapshot[]> {
  return async () => {
    const adapter = adaptDrizzleDb(db)
    let roomIds: string[]
    try {
      const rows = adapter
        .prepare("SELECT DISTINCT room_id FROM session_groups WHERE room_id IS NOT NULL")
        .all() as ReadonlyArray<{ room_id: string }>
      roomIds = rows.map((r) => r.room_id)
    } catch (err) {
      logger?.warn(
        { err: (err as Error).message },
        "[wiki-scanner] monthly-snapshot scan rooms failed (skipped)",
      )
      return []
    }
    const snapshots: RoomSnapshot[] = []
    for (const roomId of roomIds) {
      const viewfinderPath = path.join(wikiRoot, "rooms", roomId, "viewfinder.md")
      const current = safeReadFile(viewfinderPath)
      if (current === null) continue // room 还没编过 viewfinder
      snapshots.push({
        roomId,
        currentViewfinder: current,
        // MVP: recompiled === current → drift=0 → 不触发 replace
        // 真重编 LLM-from-scratch 见上方注释；本字段是占位等 F-id 接入。
        recompiledViewfinder: current,
      })
    }
    return snapshots
  }
}

// ── 5. scanAgentSessionsFs (ArchiveYearlySessions) ─────────────────────

const SESSION_FILE_RE = /^S-(\d+)\.md$/

/**
 * Scan `<wikiRoot>/rooms/<roomId>/agent-sessions/<alias>/S-NNNN.md` → SessionEntry[]。
 *
 * year 从 frontmatter `created_at` ISO 抽取，缺则 fallback 文件 mtime 年份。
 * digest = body (frontmatter 之后部分) — 进 yearly pack 内容。
 *
 * 当前 wiki 树暂无 agent-sessions/ (F028 sessions ledger 未做)；本 scanner 返 []，
 * ArchiveYearlySessions cron 跑空摆。等 sessions ledger 接入后自动扫到。
 */
export function scanAgentSessionsFs(
  wikiRoot: string,
  logger?: FastifyBaseLogger,
): () => Promise<SessionEntry[]> {
  return async () => {
    const sessions: SessionEntry[] = []
    const allMd = walkMdFiles(wikiRoot, ".")
    for (const rel of allMd) {
      const posix = rel.replace(/\\/g, "/")
      // 匹配 rooms/<roomId>/agent-sessions/<alias>/S-NNNN.md
      const m = posix.match(/^rooms\/([^/]+)\/agent-sessions\/([^/]+)\/(S-\d+\.md)$/)
      if (!m) continue
      const [, roomId, alias, basename] = m
      if (!SESSION_FILE_RE.test(basename)) continue
      const absPath = path.join(wikiRoot, rel)
      const raw = safeReadFile(absPath)
      if (raw === null) continue
      try {
        const { frontmatter, body } = parseFrontmatter(raw)
        let year: number
        if (typeof frontmatter.created_at === "string") {
          const parsed = Date.parse(frontmatter.created_at as string)
          year = Number.isNaN(parsed)
            ? new Date(fs.statSync(absPath).mtimeMs).getFullYear()
            : new Date(parsed).getFullYear()
        } else {
          year = new Date(fs.statSync(absPath).mtimeMs).getFullYear()
        }
        sessions.push({
          path: `wiki/${posix}`,
          roomId,
          alias,
          year,
          digest: body.trim(),
        })
      } catch (err) {
        logger?.warn(
          { rel, err: (err as Error).message },
          "[wiki-scanner] session parse failed (skipped)",
        )
      }
    }
    return sessions
  }
}

// ── drizzle 内部 adapter (复用 production-room-compile-executor 同 pattern) ──

function adaptDrizzleDb(db: DrizzleDb): SqliteAdapterLike {
  const dbAny = db as unknown as {
    $client?: SqliteAdapterLike
    session?: { client?: SqliteAdapterLike }
  }
  return (
    dbAny.$client ??
    dbAny.session?.client ??
    (db as unknown as SqliteAdapterLike)
  )
}
