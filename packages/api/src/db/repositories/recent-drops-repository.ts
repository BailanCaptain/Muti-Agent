/**
 * F027 AC-P1-5 · RecentDropsRepository — multi-drop cross-correlation 的"最近 drop 语料库"。
 *
 * 职责：
 *   - record(): commit 落盘成功后写一条（content + embedding + ingestedAt + contributedBy + seriesId）
 *   - queryWindow(): preview 检测时查 [windowEnd - windowDays, windowEnd] 内的历史 drop
 *   - pruneOlderThan(): 清理超窗 drop（caller 可定期调，防表无限增长）
 *
 * 设计：
 *   - embedding 存 JSON 文本（number[] 序列化）；读时 parse 回 number[]，失败/缺失 → undefined
 *     （crossCorrelateDrops 对 embedding 缺失视为 sim 0，不影响 keyword/reference 链路检测）。
 *   - 返回 DropRecord（multi-drop/types）形态，caller 直接喂 crossCorrelateDrops，无需转换。
 *   - 持久表：重启不丢历史 → 跨重启的拆分攻击也能被关联检测抓到（内存 buffer 做不到）。
 */

import { and, gte, lte } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../schema"
import { recentDrops } from "../schema"
import type { DropRecord } from "../../wiki/multi-drop/types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface RecordDropInput {
  id: string
  rawContent: string
  ingestedAt: number
  contributedBy: string
  seriesId?: string
  embedding?: number[]
}

export class RecentDropsRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  /** commit 落盘后调：写一条历史 drop。重复 id 覆盖（onConflictDoUpdate）。 */
  record(input: RecordDropInput): void {
    const values = {
      id: input.id,
      rawContent: input.rawContent,
      ingestedAt: input.ingestedAt,
      contributedBy: input.contributedBy,
      seriesId: input.seriesId ?? null,
      embedding: input.embedding ? JSON.stringify(input.embedding) : null,
      createdAt: this.nowIso(),
      reserved1: null,
      reserved2: null,
    }
    this.db
      .insert(recentDrops)
      .values(values)
      .onConflictDoUpdate({ target: recentDrops.id, set: values })
      .run()
  }

  /**
   * 查 [windowEnd - windowDays*天, windowEnd] 窗口内的历史 drop，返 DropRecord[]。
   * crossCorrelateDrops 自己还会再按 current.ingestedAt 过滤窗口 + 排除 self，这里宽召即可。
   */
  queryWindow(windowEndMs: number, windowDays: number): DropRecord[] {
    const windowStart = windowEndMs - windowDays * MS_PER_DAY
    const rows = this.db
      .select()
      .from(recentDrops)
      .where(and(gte(recentDrops.ingestedAt, windowStart), lte(recentDrops.ingestedAt, windowEndMs)))
      .all()
    return rows.map(hydrate)
  }

  /** 清理 ingestedAt < cutoffMs 的历史 drop，返删除条数。 */
  pruneOlderThan(cutoffMs: number): number {
    const result = this.db.delete(recentDrops).where(lte(recentDrops.ingestedAt, cutoffMs)).run()
    return result.changes
  }
}

const MS_PER_DAY = 86_400_000

type RawRow = typeof recentDrops.$inferSelect

function hydrate(row: RawRow): DropRecord {
  return {
    id: row.id,
    rawContent: row.rawContent,
    ingestedAt: row.ingestedAt,
    contributedBy: row.contributedBy,
    seriesId: row.seriesId ?? undefined,
    embedding: parseEmbedding(row.embedding),
  }
}

function parseEmbedding(value: string | null): number[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((n) => typeof n === "number") ? parsed : undefined
  } catch {
    return undefined
  }
}
