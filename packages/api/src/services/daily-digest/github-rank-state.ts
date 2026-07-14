import fs from "node:fs"
import path from "node:path"
import type { NormalizedItem } from "./types"

export type GithubRankStatus =
  | { kind: "new" }
  | { kind: "streak"; days: number }
  | { kind: "returning" }

export interface GithubRankSnapshot {
  businessDate: string
  lists: Record<string, string[]>
}

const TRACKED = new Set(["github-trending-daily", "github-ai-newcomers"])
const SNAPSHOT_FILE = "github-rank.json"

function previousDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() - 1)
  return parsed.toISOString().slice(0, 10)
}

export function resolveGithubRankStatus(input: {
  sourceId: string
  repoKey: string
  businessDate: string
  history: GithubRankSnapshot[]
}): GithubRankStatus | null {
  if (!TRACKED.has(input.sourceId)) return null
  const byDate = new Map(input.history.map((snapshot) => [snapshot.businessDate, snapshot]))
  const appearedBefore = input.history.some((snapshot) =>
    (snapshot.lists[input.sourceId] ?? []).includes(input.repoKey),
  )
  if (!appearedBefore) return { kind: "new" }

  let cursor = previousDate(input.businessDate)
  let priorStreak = 0
  while ((byDate.get(cursor)?.lists[input.sourceId] ?? []).includes(input.repoKey)) {
    priorStreak++
    cursor = previousDate(cursor)
  }
  return priorStreak > 0 ? { kind: "streak", days: priorStreak + 1 } : { kind: "returning" }
}

export function formatGithubRankStatus(status: GithubRankStatus | null): string | null {
  if (!status) return null
  if (status.kind === "new") return "NEW"
  if (status.kind === "returning") return "重新上榜"
  return `连续 ${status.days} 日上榜`
}

function isSnapshot(value: unknown): value is GithubRankSnapshot {
  if (!value || typeof value !== "object") return false
  const candidate = value as { businessDate?: unknown; lists?: unknown }
  if (
    typeof candidate.businessDate !== "string" ||
    !candidate.lists ||
    typeof candidate.lists !== "object"
  ) {
    return false
  }
  return Object.values(candidate.lists).every(
    (list) => Array.isArray(list) && list.every((repo) => typeof repo === "string"),
  )
}

export function applyGithubRankStatuses(
  items: NormalizedItem[],
  businessDate: string,
  history: GithubRankSnapshot[],
): NormalizedItem[] {
  return items.map((item) => {
    if (!item.githubMeta) return item
    const { rankStatus: _staleStatus, ...meta } = item.githubMeta
    const rankStatus = resolveGithubRankStatus({
      sourceId: item.sourceId,
      repoKey: item.canonicalUrl,
      businessDate,
      history,
    })
    return {
      ...item,
      githubMeta: {
        ...meta,
        ...(rankStatus ? { rankStatus } : {}),
      },
    }
  })
}

export function buildGithubRankSnapshot(
  businessDate: string,
  items: NormalizedItem[],
): GithubRankSnapshot {
  const lists: Record<string, string[]> = Object.fromEntries(
    [...TRACKED].map((sourceId) => [sourceId, []]),
  )
  for (const item of items) {
    if (!TRACKED.has(item.sourceId)) continue
    const list = lists[item.sourceId]
    if (!list.includes(item.canonicalUrl)) list.push(item.canonicalUrl)
  }
  return { businessDate, lists }
}

/** 只读过去日期；同日 force 补发不会把当天误算成第二个连续日。坏文件跳过，保留可重跑性。 */
export function loadGithubRankHistory(baseDir: string, businessDate: string): GithubRankSnapshot[] {
  if (!fs.existsSync(baseDir)) return []
  const dates = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < businessDate,
    )
    .map((entry) => entry.name)
    .sort()
  const history: GithubRankSnapshot[] = []
  for (const date of dates) {
    const file = path.join(baseDir, date, SNAPSHOT_FILE)
    if (!fs.existsSync(file)) continue
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (isSnapshot(parsed) && parsed.businessDate === date) history.push(parsed)
    } catch {
      // 历史辅助状态损坏不能阻断日报；该日按无可靠状态处理。
    }
  }
  return history
}

/** 仅在邮件真实发送成功后调用；同日补发取并集，既不删历史，也不制造额外天数。 */
export function writeGithubRankSnapshot(
  baseDir: string,
  businessDate: string,
  items: NormalizedItem[],
): void {
  const next = buildGithubRankSnapshot(businessDate, items)
  const dayDir = path.join(baseDir, businessDate)
  const file = path.join(dayDir, SNAPSHOT_FILE)
  if (fs.existsSync(file)) {
    try {
      const existing: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (isSnapshot(existing) && existing.businessDate === businessDate) {
        for (const sourceId of TRACKED) {
          next.lists[sourceId] = [
            ...(existing.lists[sourceId] ?? []),
            ...(next.lists[sourceId] ?? []),
          ].filter((repo, index, all) => all.indexOf(repo) === index)
        }
      }
    } catch {
      // 现有坏文件不可信；以本次成功发送的事实重建。
    }
  }
  fs.mkdirSync(dayDir, { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
}
