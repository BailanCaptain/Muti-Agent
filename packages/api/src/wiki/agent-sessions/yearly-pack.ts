/**
 * F027 P8 · Yearly pack archive
 * 真相源：docs/plans/V16.5-final.md chap 9 行 1067-1071
 *
 * 触发：P14 NightlyJobScheduler '@cron 1 月 1 日 03:00'（本 phase 只提供 helper）。
 * 行为：
 *   1. repo.listForYearlyPack(year) → 拿所有 ended_at < <year+1>-01-01 + archived='N' 行
 *   2. 按 (roomId, alias) 分组生成 packs/<year>.md（metadata + digest 合并；不含原文 body）
 *   3. 把对应 S-XXXX.md 从主目录 mv 到 wiki/archive/agent-sessions/<roomId>/<alias>/<year>/
 *   4. repo.markArchived(ids, year)
 *   5. 不删原则：archive 目录里 S-XXXX.md 永久保留
 *
 * AC-P1-8：100k session 模拟，archive 后 active < 1k（chap 9 行 1079）。
 */

import { promises as fsAsync } from "node:fs"
import path from "node:path"
import { writeFileAtomic } from "../atomic-write"
import { computeAgentSessionLayout } from "./ledger-writer"
import type { RoomAgentSessionsRepository } from "./repository"
import type { RoomAgentSession, YearlyPackReport } from "./types"

export interface ArchiveYearlyOptions {
  wikiRoot: string
  year: number
  repo: RoomAgentSessionsRepository
  /** 当前 ISO 时间，注入便于测试 */
  now?: string
  /**
   * 是否物理 mv 文件到 archive 目录。
   * 默认 true；测试可关闭只测 DB + pack 写盘逻辑。
   */
  moveFiles?: boolean
}

/**
 * 主入口：归档某一 year（默认 = 现在年 - 1，由 caller 决定）。
 * 跨 (roomId, alias) 一并处理，返回汇总 reports。
 *
 * 范-r1 P2-1 修：用 nested Map<roomId, Map<alias, sessions>> 而非 string join，
 * 防 roomId/alias 含 '::' 时 split 错配（虽然 P1-1 已校验段名拒 ':'，但内部
 * 数据结构不该依赖 string parse 还原 tuple identity）。
 */
export async function archiveYearlySessions(
  opts: ArchiveYearlyOptions,
): Promise<YearlyPackReport[]> {
  const candidates = opts.repo.listForYearlyPack(opts.year)
  if (candidates.length === 0) return []

  // 按 (roomId, alias) 分桶 —— nested Map 保留原 tuple identity
  const buckets = groupByTuple(candidates, (s) => [s.roomId, s.alias])
  const reports: YearlyPackReport[] = []
  const moveFiles = opts.moveFiles !== false

  for (const [roomId, byAlias] of buckets.entries()) {
    for (const [alias, sessions] of byAlias.entries()) {
      const report = await archiveOneBucket({
        wikiRoot: opts.wikiRoot,
        year: opts.year,
        roomId,
        alias,
        sessions,
        moveFiles,
      })
      reports.push(report)
    }
  }

  // 全部文件 op 完成后再批 markArchived（防中途 mv 失败留半态 DB 标 archived）
  const archivedAt = opts.now ?? new Date().toISOString()
  const allIds = candidates.map((s) => s.sessionId)
  opts.repo.markArchived(allIds, opts.year, archivedAt)
  return reports
}

async function archiveOneBucket(opts: {
  wikiRoot: string
  year: number
  roomId: string
  alias: string
  sessions: RoomAgentSession[]
  moveFiles: boolean
}): Promise<YearlyPackReport> {
  const agentLayout = computeAgentSessionLayout({
    wikiRoot: opts.wikiRoot,
    roomId: opts.roomId,
    alias: opts.alias,
    sessionSeq: 0, // 不重要；只取 agentDir
  })
  const packsDir = path.join(agentLayout.agentDir, "packs")
  await fsAsync.mkdir(packsDir, { recursive: true })
  const packPath = path.join(packsDir, `${opts.year}.md`)
  const packContent = buildYearlyPackMarkdown(opts.roomId, opts.alias, opts.year, opts.sessions)
  writeFileAtomic(packPath, packContent)

  // wiki/archive/agent-sessions/<roomId>/<alias>/<year>/
  const archiveDir = path.join(
    opts.wikiRoot,
    "wiki",
    "archive",
    "agent-sessions",
    opts.roomId,
    opts.alias,
    String(opts.year),
  )
  if (opts.moveFiles) {
    await fsAsync.mkdir(archiveDir, { recursive: true })
    for (const s of opts.sessions) {
      const seqPadded = String(s.sessionSeq).padStart(4, "0")
      const src = path.join(agentLayout.agentDir, `S-${seqPadded}.md`)
      const dst = path.join(archiveDir, `S-${seqPadded}.md`)
      try {
        await fsAsync.rename(src, dst)
      } catch (err) {
        // 文件不存在不算错（DB 行有但文件没写过）—— 不阻塞 archive
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      }
    }
  }

  return {
    year: opts.year,
    scanned: opts.sessions.length,
    archived: opts.sessions.length,
    packPath,
    archivedDir: archiveDir,
  }
}

/**
 * Yearly pack markdown：metadata + 每 session digest（不含原文 body）。
 * 设计：read_wiki 想看原文 → 主动读 archive/<year>/S-XXXX.md（不删原则）。
 */
function buildYearlyPackMarkdown(
  roomId: string,
  alias: string,
  year: number,
  sessions: RoomAgentSession[],
): string {
  const lines: string[] = []
  lines.push("---")
  lines.push(`year: ${year}`)
  lines.push(`room_id: ${escapeYaml(roomId)}`)
  lines.push(`alias: ${escapeYaml(alias)}`)
  lines.push(`session_count: ${sessions.length}`)
  lines.push(`first_seq: ${sessions[0]?.sessionSeq ?? 0}`)
  lines.push(`last_seq: ${sessions[sessions.length - 1]?.sessionSeq ?? 0}`)
  lines.push("---")
  lines.push("")
  lines.push(`# Yearly Pack ${year} · ${alias} @ ${roomId}`)
  lines.push("")
  lines.push(`Archived ${sessions.length} sessions. Originals preserved under`)
  lines.push(`\`wiki/archive/agent-sessions/${roomId}/${alias}/${year}/\` (V16.5 chap 9 不删原则).`)
  lines.push("")
  for (const s of sessions) {
    lines.push(
      `## S-${String(s.sessionSeq).padStart(4, "0")} · ${s.startedAt} → ${s.endedAt ?? "?"}`,
    )
    lines.push("")
    lines.push(`- entry: ${s.entryReason}`)
    if (s.exitReason) lines.push(`- exit: ${s.exitReason}`)
    if (s.lastSeenCommitSeq !== null) {
      lines.push(`- last_seen_commit_seq: ${s.lastSeenCommitSeq}`)
    }
    if (s.openThreads.length > 0) lines.push(`- open_threads: ${s.openThreads.length}`)
    if (s.closedThreads.length > 0) lines.push(`- closed_threads: ${s.closedThreads.length}`)
    if (s.sessionDigest && s.sessionDigest.trim().length > 0) {
      lines.push("")
      lines.push(s.sessionDigest.trim())
    }
    lines.push("")
  }
  return `${lines.join("\n")}\n`
}

function escapeYaml(s: string): string {
  if (s.length === 0) return '""'
  if (/[:#\n\r\t]/.test(s) || /^[-?!&*|>%@`]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  }
  return s
}

/**
 * 范-r1 P2-1 修：用 (k1, k2) tuple 而非 string join 做 bucket key。
 * 防 roomId/alias 内含特殊字符让 string split 错位。
 */
function groupByTuple<T>(
  arr: T[],
  keyFn: (x: T) => [string, string],
): Map<string, Map<string, T[]>> {
  const outer = new Map<string, Map<string, T[]>>()
  for (const x of arr) {
    const [k1, k2] = keyFn(x)
    let inner = outer.get(k1)
    if (!inner) {
      inner = new Map<string, T[]>()
      outer.set(k1, inner)
    }
    const bucket = inner.get(k2)
    if (bucket) bucket.push(x)
    else inner.set(k2, [x])
  }
  return outer
}
