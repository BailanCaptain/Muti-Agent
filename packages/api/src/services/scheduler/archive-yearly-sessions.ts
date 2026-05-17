/**
 * F027 P19.13 · ArchiveYearlySessions (cron 0 3 1 1 * Asia/Shanghai)
 *
 * 真相源：docs/plans/F027-phase2-implementation-plan.md AC-P2-15 + V16.5 chap 9
 * line 1060-1078（agent-sessions ledger sharding & yearly pack）
 *
 * 职责：每年 1/1 03:00 把往年 S-XXXX.md 合并归档：
 *   - 往年（year < 当前年）session 按年合并成 yearly pack `<year>.md`
 *     （保留 metadata + digest）
 *   - 原 S-XXXX.md mv 到 wiki/archive/agent-sessions/<roomId>/<alias>/<year>/
 *     （**不删原则** — archive 是 move 到归档区，不是删除）
 *
 * 职责（Day 16 归档逻辑壳；scan/write/move 由 caller 注入）：
 *   - scanSessions() 返全部 session entries
 *   - writeYearlyPack(year, content) 写 pack 文件
 *   - archiveSessionFile(src, dst) mv S 文件到归档区
 *   - 本类只做"按年分组 + pack 内容拼装 + 归档路径计算"；纯逻辑可单测
 *
 * 不做：
 *   - 不读 fs / 不直接 mv（caller 注入）
 *   - 不动主索引（caller 后续自行 update index）
 *   - 不绑 scheduler — 集成层 wire
 */

import type { FastifyBaseLogger } from "fastify"
import { createLogger } from "../../lib/logger"

export interface SessionEntry {
  /** S-XXXX.md 当前路径（repo-relative）。 */
  path: string
  roomId: string
  alias: string
  /** session 归属年份（YYYY）。 */
  year: number
  /** metadata + digest（进 yearly pack 的内容）。 */
  digest: string
}

export interface ArchiveYearlySessionsOptions {
  /** Caller-injected: 扫全部 session entries snapshot。 */
  scanSessions: () => Promise<SessionEntry[]>
  /** Caller-injected: 写 yearly pack 文件；返 pack 路径。 */
  writeYearlyPack?: (year: number, packContent: string) => Promise<string>
  /** Caller-injected: mv S 文件到归档区。 */
  archiveSessionFile?: (srcPath: string, dstPath: string) => Promise<void>
  /** Inject clock (testing); 默认 () => new Date()。 */
  clock?: () => Date
  logger?: FastifyBaseLogger
}

export interface YearlyPackResult {
  year: number
  /** writeYearlyPack 返回的 pack 路径；无 writer 注入时 null。 */
  packPath: string | null
  sessionCount: number
}

export interface ArchiveYearlyResult {
  /** 运行时的当前年（cron 触发年）。 */
  currentYear: number
  totalSessionsScanned: number
  /** 属于往年（< currentYear）被归档的 session 数。 */
  sessionsArchived: number
  /** 各年 yearly pack 结果。 */
  packs: YearlyPackResult[]
  /** mv 成功的文件 (src → dst)。 */
  archivedFiles: { src: string; dst: string }[]
  /** mv 失败的文件。 */
  failed: { src: string; error: string }[]
}

export class ArchiveYearlySessions {
  private readonly opts: ArchiveYearlySessionsOptions
  private readonly log: FastifyBaseLogger
  private readonly clock: () => Date

  constructor(opts: ArchiveYearlySessionsOptions) {
    this.opts = opts
    this.log = opts.logger ?? createLogger("archive-yearly-sessions")
    this.clock = opts.clock ?? (() => new Date())
  }

  async run(): Promise<ArchiveYearlyResult> {
    // cron 0 3 1 1 * Asia/Shanghai — 取 CST 年份
    const currentYear = shanghaiYear(this.clock())
    const all = await this.opts.scanSessions()

    // 往年 session（year < currentYear）才归档；当年 active session 不动
    const toArchive = all.filter((s) => s.year < currentYear)

    // 按年分组
    const byYear = new Map<number, SessionEntry[]>()
    for (const s of toArchive) {
      const arr = byYear.get(s.year)
      if (arr) arr.push(s)
      else byYear.set(s.year, [s])
    }

    const packs: YearlyPackResult[] = []
    const archivedFiles: { src: string; dst: string }[] = []
    const failed: { src: string; error: string }[] = []

    for (const [year, sessions] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
      // 拼 yearly pack 内容（metadata + digest 保留）
      const packContent = buildYearlyPack(year, sessions)
      let packPath: string | null = null
      let packFailed = false
      if (this.opts.writeYearlyPack) {
        try {
          packPath = await this.opts.writeYearlyPack(year, packContent)
        } catch (err) {
          this.log.error(
            { err, year },
            "writeYearlyPack failed; 跳过本年 session 归档（防 partial year）",
          )
          packFailed = true
        }
      }
      packs.push({ year, packPath, sessionCount: sessions.length })

      // 范-r2 P2-2：pack 没写成 → 本年 session 全不 mv（避免"源文件已移走但
      // 无 yearly pack 索引"的 partial year 不一致状态）；落 failed。
      if (packFailed) {
        for (const s of sessions) {
          failed.push({
            src: s.path,
            error: `yearly pack write failed for ${year}; session not archived`,
          })
        }
        continue
      }

      // mv 每个 S 文件到归档区（不删原则）
      for (const s of sessions) {
        const dst = archivePathFor(s)
        if (this.opts.archiveSessionFile) {
          try {
            await this.opts.archiveSessionFile(s.path, dst)
            archivedFiles.push({ src: s.path, dst })
          } catch (err) {
            failed.push({ src: s.path, error: (err as Error).message })
          }
        } else {
          // dry-run：记录归档目标但不真 mv
          archivedFiles.push({ src: s.path, dst })
        }
      }
    }

    const result: ArchiveYearlyResult = {
      currentYear,
      totalSessionsScanned: all.length,
      sessionsArchived: toArchive.length,
      packs,
      archivedFiles,
      failed,
    }
    this.log.info(
      {
        currentYear,
        scanned: all.length,
        archived: toArchive.length,
        packs: packs.length,
        failed: failed.length,
      },
      "yearly session archive done",
    )
    return result
  }
}

// ── helpers ────────────────────────────────────────────────────────────

/** Asia/Shanghai (UTC+8) 年份 —— cron 在 CST 触发，避免 UTC 跨年错。 */
function shanghaiYear(d: Date): number {
  return new Date(d.getTime() + 8 * 3600 * 1000).getUTCFullYear()
}

/** 拼 yearly pack markdown（保留 metadata + digest；原文不在 pack 内）。 */
export function buildYearlyPack(year: number, sessions: SessionEntry[]): string {
  const lines: string[] = []
  lines.push(`# Agent Sessions Yearly Pack — ${year}`)
  lines.push("")
  lines.push(`Total sessions: ${sessions.length}`)
  lines.push("")
  // 按 room/alias 稳定排序
  const sorted = [...sessions].sort((a, b) => {
    if (a.roomId !== b.roomId) return a.roomId < b.roomId ? -1 : 1
    if (a.alias !== b.alias) return a.alias < b.alias ? -1 : 1
    return a.path < b.path ? -1 : 1
  })
  for (const s of sorted) {
    lines.push(`## ${s.roomId} / ${s.alias} — ${s.path}`)
    lines.push(s.digest)
    lines.push("")
  }
  return lines.join("\n")
}

/**
 * 归档目标路径：wiki/archive/agent-sessions/<roomId>/<alias>/<year>/<basename>
 * （V16.5 chap 9:1070）。
 */
export function archivePathFor(s: SessionEntry): string {
  const normalized = s.path.replace(/\\/g, "/")
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1)
  return `wiki/archive/agent-sessions/${s.roomId}/${s.alias}/${s.year}/${basename}`
}
