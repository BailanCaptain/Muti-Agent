import fs from "node:fs"
import path from "node:path"
import type { SourceFetchResult, SourceHealthStore } from "./types"

/**
 * AC8 源健康持久化：.runtime/daily-digest/health/YYYY-MM-DD.json
 * 存 { [sourceId]: { status, errorKind? } }；连续失败判定重启不丢。
 * 缺文件（当天没跑）截断计数——宁少报不误报。
 */
export function createFileSourceHealthStore(baseDir: string): SourceHealthStore {
  const healthDir = path.join(baseDir, "health")

  function fileFor(date: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`)
    return path.join(healthDir, `${date}.json`)
  }

  function readDay(date: string): Record<string, { status: string; errorKind?: string }> | null {
    try {
      return JSON.parse(fs.readFileSync(fileFor(date), "utf8"))
    } catch {
      return null
    }
  }

  function prevDate(date: string): string {
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  }

  return {
    record(date, results) {
      fs.mkdirSync(healthDir, { recursive: true })
      const map: Record<string, { status: string; errorKind?: string }> = {}
      for (const r of results) {
        map[r.sourceId] = {
          status: r.status,
          ...(r.errors.length ? { errorKind: r.errors[0].slice(0, 200) } : {}),
        }
      }
      const target = fileFor(date)
      const tmp = `${target}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(map, null, 1))
      fs.renameSync(tmp, target)
    },
    consecutiveFailures(sourceId, endDate) {
      let count = 0
      let cursor = endDate
      for (let i = 0; i < 30; i += 1) {
        const day = readDay(cursor)
        if (!day) break
        const st = day[sourceId]?.status
        if (st !== "failed" && st !== "timeout") break
        count += 1
        cursor = prevDate(cursor)
      }
      return count
    },
  }
}
