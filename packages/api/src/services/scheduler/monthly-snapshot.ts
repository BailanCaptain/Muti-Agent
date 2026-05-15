/**
 * F027 P19.12 · MonthlySnapshot (cron 0 3 1 * * Asia/Shanghai)
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-14 + V16.5 chap 11
 * line 1202-1236（Viewfinder anti-drift — 派生 b: MonthlySnapshot full recompile）
 *
 * 职责：每月 1 号 03:00 全量重编所有 room viewfinder：
 *   1. backup 当前状态（防 replace 后无法回滚）
 *   2. recompileAllRooms：从 raw transcript 全量重编 viewfinder（caller 注入 LLM 工作）
 *   3. 逐 room 算 drift（current vs recompiled，word-Jaccard 距离）
 *   4. drift > driftThreshold（默认 30%）→ replaceViewfinder（V15.2 升级：自动 replace）
 *   5. pushAudit 推审计通知到指定 room
 *
 * 职责（Day 14-15 编排逻辑壳；recompile/backup/replace/audit 由 caller 注入）：
 *   - 本类只做 drift 计算 + replace 决策；重活（LLM 重编 / fs backup）caller 注入
 *   - 纯逻辑可单测（含 100k room mock pressure）
 *
 * 不做：
 *   - 不实现 viewfinder 重编（caller recompileAllRooms 注入；P12 已有 compiler）
 *   - 不直接 fs backup（caller backup 注入）
 *   - 不绑 scheduler / leader gate — 集成层 wire
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export interface RoomSnapshot {
  roomId: string
  /** 当前 viewfinder 内容。 */
  currentViewfinder: string
  /** 从 raw transcript 全量重编出的新 viewfinder。 */
  recompiledViewfinder: string
}

export interface MonthlySnapshotOptions {
  /** Caller-injected: 扫所有 room + 全量重编 viewfinder（LLM 重活）。 */
  recompileAllRooms: () => Promise<RoomSnapshot[]>
  /** Caller-injected: replace 前 backup 当前状态；返 backup 位置标识。 */
  backup?: (label: string) => Promise<string>
  /** Caller-injected: 用新 viewfinder 替换某 room。 */
  replaceViewfinder?: (roomId: string, newContent: string) => Promise<void>
  /** Caller-injected: 推审计通知（V16.5 chap 11:1206 — 推到指定 room）。 */
  pushAudit?: (report: SnapshotReport) => Promise<void>
  /** Drift 阈值 0..1；默认 0.30（> 30% 自动 replace）。 */
  driftThreshold?: number
  /** Inject clock (testing); 默认 () => new Date()。 */
  clock?: () => Date
  logger?: FastifyBaseLogger
}

export interface RoomDriftResult {
  roomId: string
  /** 0..1；0 = 完全一致，1 = 完全不同。 */
  driftRatio: number
  /** 是否触发 replace（drift > threshold）。 */
  replaced: boolean
  /** replace 失败时的错误（replaced=false + 此字段非空 = 想 replace 但失败）。 */
  replaceError?: string
}

export interface SnapshotReport {
  /** 快照时刻 ISO。 */
  snapshotAt: string
  /** 快照标签（year-month，如 "2027-01"）。 */
  label: string
  /** backup 位置标识；无 backup 注入时 null。 */
  backupLocation: string | null
  totalRooms: number
  roomsReplaced: number
  /** drift > threshold 但 replace 失败的房间数。 */
  roomsReplaceFailed: number
  rooms: RoomDriftResult[]
}

export class MonthlySnapshot {
  private readonly opts: MonthlySnapshotOptions
  private readonly log: FastifyBaseLogger
  private readonly clock: () => Date
  private readonly driftThreshold: number

  constructor(opts: MonthlySnapshotOptions) {
    this.opts = opts
    this.log = opts.logger ?? createLogger("monthly-snapshot")
    this.clock = opts.clock ?? (() => new Date())
    this.driftThreshold = opts.driftThreshold ?? 0.3
  }

  async run(): Promise<SnapshotReport> {
    const now = this.clock()
    // 范-r1 P1-1: label 按 Asia/Shanghai 格式化（cron 在 CST 触发；UTC slice
    // 会让 2027-01-01 03:00 CST = 2026-12-31 19:00 UTC 错标成 2026-12）。
    const label = formatYearMonthShanghai(now)

    // 范-r1 P1-2: 有 replaceViewfinder 时 backup 必填（无 backup = 无回滚兜底，
    // 禁止 replace）。仅 dry-run（不传 replaceViewfinder）允许无 backup。
    if (this.opts.replaceViewfinder && !this.opts.backup) {
      throw new Error(
        "MonthlySnapshot: replaceViewfinder 提供时 backup 必填（backup-before-replace " +
          "安全语义）；dry-run 模式请不要传 replaceViewfinder",
      )
    }

    // (1) backup 当前状态
    let backupLocation: string | null = null
    if (this.opts.backup) {
      try {
        backupLocation = await this.opts.backup(`monthly-snapshot-${label}`)
      } catch (err) {
        // backup 失败 → 不 replace（无回滚兜底不敢动），report 标记
        this.log.error({ err, label }, "backup failed — skipping replace this run (fail-safe)")
        const rooms0 = await this.opts.recompileAllRooms()
        const failReport = this.buildReport({
          snapshotAt: now.toISOString(),
          label,
          backupLocation: null,
          rooms: rooms0.map((r) => ({
            roomId: r.roomId,
            driftRatio: computeDrift(r.currentViewfinder, r.recompiledViewfinder),
            replaced: false,
            replaceError: "backup failed — replace skipped",
          })),
        })
        // 范-r1 P2-4: backup 失败的 report 也走 pushAudit best-effort
        // （否则 R-201 收不到失败审计 — 比 replace 成功更需要告警）
        if (this.opts.pushAudit) {
          try {
            await this.opts.pushAudit(failReport)
          } catch (auditErr) {
            this.log.warn({ err: auditErr }, "pushAudit threw on backup-failure report (ignored)")
          }
        }
        return failReport
      }
    }

    // (2) recompile
    const snapshots = await this.opts.recompileAllRooms()

    // (3)(4) drift 计算 + replace 决策
    const rooms: RoomDriftResult[] = []
    for (const snap of snapshots) {
      const driftRatio = computeDrift(snap.currentViewfinder, snap.recompiledViewfinder)
      if (driftRatio > this.driftThreshold) {
        if (this.opts.replaceViewfinder) {
          try {
            await this.opts.replaceViewfinder(snap.roomId, snap.recompiledViewfinder)
            rooms.push({ roomId: snap.roomId, driftRatio, replaced: true })
          } catch (err) {
            rooms.push({
              roomId: snap.roomId,
              driftRatio,
              replaced: false,
              replaceError: (err as Error).message,
            })
          }
        } else {
          // 无 replacer（dry-run）：记录 drift 但不 replace
          rooms.push({ roomId: snap.roomId, driftRatio, replaced: false })
        }
      } else {
        rooms.push({ roomId: snap.roomId, driftRatio, replaced: false })
      }
    }

    const report = this.buildReport({
      snapshotAt: now.toISOString(),
      label,
      backupLocation,
      rooms,
    })

    // (5) 推审计通知
    if (this.opts.pushAudit) {
      try {
        await this.opts.pushAudit(report)
      } catch (err) {
        this.log.warn({ err }, "pushAudit threw (ignored — report still returned)")
      }
    }

    this.log.info(
      { label, total: report.totalRooms, replaced: report.roomsReplaced },
      "monthly snapshot done",
    )
    return report
  }

  private buildReport(input: {
    snapshotAt: string
    label: string
    backupLocation: string | null
    rooms: RoomDriftResult[]
  }): SnapshotReport {
    const roomsReplaced = input.rooms.filter((r) => r.replaced).length
    const roomsReplaceFailed = input.rooms.filter(
      (r) => !r.replaced && r.replaceError !== undefined,
    ).length
    return {
      snapshotAt: input.snapshotAt,
      label: input.label,
      backupLocation: input.backupLocation,
      totalRooms: input.rooms.length,
      roomsReplaced,
      roomsReplaceFailed,
      rooms: input.rooms,
    }
  }
}

/**
 * Drift 计算：word-level Jaccard 距离。
 *   driftRatio = 1 - |A∩B| / |A∪B|
 *   0 = 完全一致；1 = 无任何共同 word。
 *
 * 选 Jaccard 而非 edit distance：viewfinder 是语义摘要，词集合重叠比字符级
 * 编辑距离更能反映"内容漂移"（换行 / 措辞微调不算 drift；换主题才算）。
 */
export function computeDrift(oldText: string, newText: string): number {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  if (a.size === 0 && b.size === 0) return 0
  let interCount = 0
  for (const w of a) {
    if (b.has(w)) interCount += 1
  }
  const unionCount = a.size + b.size - interCount
  if (unionCount === 0) return 0
  const similarity = interCount / unionCount
  return 1 - similarity
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/i)
      .filter((w) => w.length > 0),
  )
}

/**
 * 范-r1 P1-1: 按 Asia/Shanghai (UTC+8 无 DST) 格式化 year-month。
 * MonthlySnapshot cron 在 CST 03:00 触发；直接 toISOString().slice(0,7) 是 UTC
 * label，跨日界会错月（CST 月初 = UTC 上月末）。
 */
function formatYearMonthShanghai(d: Date): string {
  // Asia/Shanghai = UTC+8 固定偏移
  const shanghai = new Date(d.getTime() + 8 * 3600 * 1000)
  // 用 getUTC* 读偏移后的"墙上时间"
  const year = shanghai.getUTCFullYear()
  const month = String(shanghai.getUTCMonth() + 1).padStart(2, "0")
  return `${year}-${month}`
}
