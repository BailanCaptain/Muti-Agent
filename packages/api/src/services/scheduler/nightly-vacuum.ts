/**
 * F027 P19.9 · NightlyVacuum (cron 0 5 * * * Asia/Shanghai)
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-11 + V16.5 chap 5
 * line 519-524 + plan §13（V16.5 真相源 drift 归档）
 *
 * 职责：把 archiveThresholdDays（默认 30）天前的 wiki_events
 *   - archive：完整事件行 → `.runtime/wiki-events-archive/<year>/<month>.jsonl`
 *   - snapshot：committed 事件按 path 取 last → `.runtime/wiki-events-snapshot/<year>-<month>.jsonl`
 *
 * **Iron Laws 1 + plan §13 强约束**：
 *   - **不删 wiki_events 行**（archive 是复制不是 move）
 *   - **不改 state / 不扩 enum / 不引新表 / 不改 schema**
 *   - V16.5 chap 5 原写 `wiki_events_snapshot` / `wiki_events_archive` 是 DB 表
 *     —— plan §13 归档为真相源 drift；Phase 2 改用 .runtime/ jsonl 文件替代
 *   - 测试断言：run() 前后 sqlite_master + wiki_events 行数 diff = ∅
 *
 * 不做：
 *   - 不删老数据（archive 后 DB 行保留；后续真清理是另一个独立决策，需人工）
 *   - 不绑 scheduler / leader gate — 集成层 wire
 *   - 不直接落 job_trace（caller / scheduler-runtime 把 VacuumResult 塞 trace.result）
 */

import fs from "node:fs"
import path from "node:path"
import { sql } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"
import type * as schema from "../../db/schema"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface NightlyVacuumOptions {
  db: DrizzleDb
  /** .runtime/ 输出根目录；默认 process.cwd()。 */
  rootDir?: string
  /** 早于今天此天数的 events 进 archive + snapshot；默认 30。 */
  archiveThresholdDays?: number
  /** 注入时钟（测试用）；默认 () => new Date()。 */
  clock?: () => Date
  logger?: FastifyBaseLogger
  /**
   * F027 AC-P1-5 codex P2-3 修：recent_drops 历史语料库 retention。
   * 注入 → 每夜 prune ingestedAt < now - recentDropsRetentionDays（默认 7）。
   * 不注入 → 跳过（向后兼容）。crossCorrelateDrops 只看 7 天窗口，超窗即可删（Iron Law 1：
   * recent_drops 是关联检测临时语料非神圣原始数据，超窗删合规；区别 wiki_events archive 不删）。
   */
  recentDrops?: { pruneOlderThan(cutoffMs: number): number }
  /** recent_drops 保留天数；默认 7（对齐 crossCorrelateDrops 窗口）。 */
  recentDropsRetentionDays?: number
}

export interface VacuumResult {
  /** 扫到的 ≥ 阈值老 events 总数。 */
  scannedEvents: number
  /** 写入 archive 的事件行数（= scannedEvents；archive 含全部老事件）。 */
  archivedEvents: number
  /** snapshot 内 distinct path 条目数（committed 事件按 path 去重后）。 */
  snapshotEntries: number
  /** 写入的 archive jsonl 文件相对路径列表。 */
  archiveFiles: string[]
  /** 写入的 snapshot jsonl 文件相对路径列表。 */
  snapshotFiles: string[]
  /** F027 AC-P1-5 · prune 掉的超窗 recent_drops 条数（未接 recentDrops 时 0）。 */
  recentDropsPruned: number
}

interface WikiEventRow {
  id: number
  ts: string
  alias: string
  action: string
  path: string
  content_hash: string | null
  result: string
  state: string
  leader_term: string
  fencing_token: string
}

interface SnapshotEntry {
  path: string
  lastContentHash: string | null
  lastWriter: string
  lastTs: string
  lastEventId: number
}

export class NightlyVacuum {
  private readonly db: DrizzleDb
  private readonly rootDir: string
  private readonly archiveThresholdDays: number
  private readonly clock: () => Date
  private readonly log: FastifyBaseLogger
  private readonly recentDrops?: { pruneOlderThan(cutoffMs: number): number }
  private readonly recentDropsRetentionDays: number

  constructor(opts: NightlyVacuumOptions) {
    this.db = opts.db
    this.rootDir = opts.rootDir ?? process.cwd()
    this.archiveThresholdDays = opts.archiveThresholdDays ?? 30
    this.clock = opts.clock ?? (() => new Date())
    this.log = opts.logger ?? createLogger("nightly-vacuum")
    this.recentDrops = opts.recentDrops
    this.recentDropsRetentionDays = opts.recentDropsRetentionDays ?? 7
  }

  /**
   * F027 AC-P1-5 codex P2-3 修：prune 超窗 recent_drops（注入 recentDrops 才跑）。
   * cutoff = now - retentionDays；pruneOlderThan 用 `<` 严格小于（不删窗口边界行）。
   */
  private pruneRecentDrops(): number {
    if (!this.recentDrops) return 0
    const cutoff = this.clock().getTime() - this.recentDropsRetentionDays * 24 * 3600 * 1000
    const pruned = this.recentDrops.pruneOlderThan(cutoff)
    if (pruned > 0) {
      this.log.info(
        { pruned, retentionDays: this.recentDropsRetentionDays },
        "vacuum: pruned stale recent_drops (超窗关联语料)",
      )
    }
    return pruned
  }

  run(): VacuumResult {
    const cutoffIso = new Date(
      this.clock().getTime() - this.archiveThresholdDays * 24 * 3600 * 1000,
    ).toISOString()

    // 只读查询 —— 绝不 DELETE / UPDATE wiki_events
    const oldEvents = this.db.all<WikiEventRow>(
      sql`SELECT id, ts, alias, action, path, content_hash, result, state, leader_term, fencing_token
          FROM wiki_events
          WHERE ts < ${cutoffIso}
          ORDER BY ts ASC, id ASC`,
    )

    if (oldEvents.length === 0) {
      this.log.info({ cutoffIso }, "vacuum: no events older than threshold")
      // recent_drops prune 独立于 wiki_events archive（即使无老 events 也要 prune 超窗语料）
      const recentDropsPruned = this.pruneRecentDrops()
      return {
        scannedEvents: 0,
        archivedEvents: 0,
        snapshotEntries: 0,
        archiveFiles: [],
        snapshotFiles: [],
        recentDropsPruned,
      }
    }

    // 按 year-month 分组（archive 文件按月切）
    const byMonth = new Map<string, WikiEventRow[]>()
    for (const ev of oldEvents) {
      const ym = ev.ts.slice(0, 7) // "2026-04"
      const arr = byMonth.get(ym)
      if (arr) arr.push(ev)
      else byMonth.set(ym, [ev])
    }

    const archiveFiles: string[] = []
    const snapshotFiles: string[] = []
    let snapshotEntries = 0

    for (const [ym, events] of byMonth) {
      const [year, month] = ym.split("-")

      // ── archive：完整事件行 → .runtime/wiki-events-archive/<year>/<month>.jsonl ──
      const archiveDir = path.join(this.rootDir, ".runtime", "wiki-events-archive", year)
      fs.mkdirSync(archiveDir, { recursive: true })
      const archiveAbs = path.join(archiveDir, `${month}.jsonl`)
      const archiveBody = events.map((e) => JSON.stringify(e)).join("\n")
      writeJsonlAtomic(archiveAbs, archiveBody)
      archiveFiles.push(path.relative(this.rootDir, archiveAbs).replace(/\\/g, "/"))

      // ── snapshot：committed 事件按 path 取 last → .runtime/wiki-events-snapshot/<ym>.jsonl ──
      // 范-r1 P2-1: events 已 ORDER BY ts ASC, id ASC → 迭代顺序即时间顺序，
      // 直接覆盖 = last-write-wins（不能按 id 判定 —— backfill 导入历史文件时
      // ts 是历史时间但 id 是新分配的大值，按 id 选会选错"最新"）。
      const snapshotMap = new Map<string, SnapshotEntry>()
      for (const ev of events) {
        if (ev.state !== "committed") continue
        snapshotMap.set(ev.path, {
          path: ev.path,
          lastContentHash: ev.content_hash,
          lastWriter: ev.alias,
          lastTs: ev.ts,
          lastEventId: ev.id,
        })
      }
      if (snapshotMap.size > 0) {
        const snapshotDir = path.join(this.rootDir, ".runtime", "wiki-events-snapshot")
        fs.mkdirSync(snapshotDir, { recursive: true })
        const snapshotAbs = path.join(snapshotDir, `${ym}.jsonl`)
        const snapshotBody = [...snapshotMap.values()]
          .map((e) => JSON.stringify(e))
          .join("\n")
        writeJsonlAtomic(snapshotAbs, snapshotBody)
        snapshotFiles.push(path.relative(this.rootDir, snapshotAbs).replace(/\\/g, "/"))
        snapshotEntries += snapshotMap.size
      }
    }

    const recentDropsPruned = this.pruneRecentDrops()
    const result: VacuumResult = {
      scannedEvents: oldEvents.length,
      archivedEvents: oldEvents.length,
      snapshotEntries,
      archiveFiles: archiveFiles.sort(),
      snapshotFiles: snapshotFiles.sort(),
      recentDropsPruned,
    }
    this.log.info(result, "vacuum done (wiki_events archive is copy; recent_drops 超窗 pruned)")
    return result
  }
}

/** Atomic jsonl write：tmp + rename，防 reader 读到半文件。 */
function writeJsonlAtomic(absPath: string, body: string): void {
  const tmp = `${absPath}.tmp`
  fs.writeFileSync(tmp, body.length > 0 ? `${body}\n` : "", "utf-8")
  fs.renameSync(tmp, absPath)
}
