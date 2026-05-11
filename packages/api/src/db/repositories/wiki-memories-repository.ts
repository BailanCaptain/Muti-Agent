/**
 * F027 P10 · WikiMemoriesRepository — 5 类记忆桶物理表 DB 层。
 * 真相源：docs/plans/V16.5-final.md chap 14
 *
 * 写时校验（type-routed，防漂桶第一道闸）：
 *   - canonical_owner_path 必须以 wiki/<type>/ 开头
 *   - room 桶 promotion_target 必须 null（派生视图终点）
 *   - feedback 桶 ttl_days 默认 30（不显式给值时填入）
 *   - type 只能 5 enum（schema CHECK 已强约束 + drizzle 类型层兜一道）
 *
 * 状态机：
 *   draft ──promote──► canonical
 *   draft ──reject──► deprecated
 *   canonical ──deprecate──► deprecated
 *   重复 settle = noop（CAS WHERE state=<from>），返回 boolean
 *
 * 不做：
 *   - 文件系统写（wiki/<bucket>/*.md）→ P2 WikiCompiler
 *   - LLM 编译（cross_refs / dedup_decision）→ P4.6
 *   - lint 漂移检测（同 path 多 canonical / supersedes 死链等）→ wiki-memories-lint.ts
 *   - ACL/lease 校验 → P3 update_wiki MCP service
 */

import { and, desc, eq } from "drizzle-orm"
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type * as schema from "../schema"
import { wikiMemories } from "../schema"
import {
  type InsertWikiMemoryInput,
  InvalidBucketPathError,
  type WikiMemory,
  type WikiMemoryState,
  type WikiMemoryType,
  DEFAULT_FEEDBACK_TTL_DAYS,
  RoomBucketCannotPromoteError,
  WIKI_MEMORY_TYPES,
  bucketPrefix,
} from "./wiki-memories-types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export class WikiMemoriesRepository {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * 写新行（含 type-routed 默认 + 写时校验）。返回 hydrated row。
   * 缺省 state='draft'，等 promote 流程走 updateState。
   */
  insert(input: InsertWikiMemoryInput): WikiMemory {
    if (!WIKI_MEMORY_TYPES.includes(input.type)) {
      // 兜底：drizzle 类型层 + DB CHECK 都拦得住，这里给清晰错误
      throw new Error(`Unknown wiki memory type: ${input.type}`)
    }
    const expectedPrefix = bucketPrefix(input.type)
    if (!input.canonicalOwnerPath.startsWith(expectedPrefix)) {
      throw new InvalidBucketPathError(input.type, input.canonicalOwnerPath, expectedPrefix)
    }
    if (input.type === "room" && input.promotionTarget != null) {
      throw new RoomBucketCannotPromoteError(input.canonicalOwnerPath)
    }

    const ttlDays = input.ttlDays ?? (input.type === "feedback" ? DEFAULT_FEEDBACK_TTL_DAYS : null)
    const now = input.createdAt ?? new Date().toISOString()

    const row = this.db
      .insert(wikiMemories)
      .values({
        type: input.type,
        name: input.name,
        canonicalOwnerPath: input.canonicalOwnerPath,
        promotionTarget: input.promotionTarget ?? null,
        ttlDays,
        supersedes: serializeJson(input.supersedes),
        replacesInBuckets: serializeJson(input.replacesInBuckets),
        sourceMessageIds: serializeJson(input.sourceMessageIds),
        contributedBy: JSON.stringify(input.contributedBy),
        crossRefs: serializeJson(input.crossRefs as unknown[] | null | undefined),
        dedupDecision: input.dedupDecision == null ? null : JSON.stringify(input.dedupDecision),
        body: input.body,
        state: input.state ?? "draft",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get()
    return hydrate(row)
  }

  /**
   * 状态机 CAS：from → to。重复 settle 返回 false（idempotent）。
   * 合法转移：draft→canonical / draft→deprecated / canonical→deprecated。
   * 非法转移会直接 0 rows changed（CAS WHERE state=from），caller 看 false 自决；
   * 测试侧也可用此判断：先 get 看当前 state，再决定是否 throw InvalidStateTransitionError。
   */
  updateState(memoryId: number, from: WikiMemoryState, to: WikiMemoryState): boolean {
    const now = new Date().toISOString()
    const result = this.db
      .update(wikiMemories)
      .set({ state: to, updatedAt: now })
      .where(and(eq(wikiMemories.id, memoryId), eq(wikiMemories.state, from)))
      .run()
    return result.changes > 0
  }

  get(memoryId: number): WikiMemory | null {
    const row = this.db.select().from(wikiMemories).where(eq(wikiMemories.id, memoryId)).get()
    return row ? hydrate(row) : null
  }

  /** 按 type 查（assemblePrompt 注入按桶取 / lint 全表扫按桶分组）。 */
  getByType(type: WikiMemoryType, limit = 200): WikiMemory[] {
    const rows = this.db
      .select()
      .from(wikiMemories)
      .where(eq(wikiMemories.type, type))
      .orderBy(desc(wikiMemories.updatedAt))
      .limit(limit)
      .all()
    return rows.map(hydrate)
  }

  /** 按 canonical_owner_path 查全部历史行（同 path 可能有 draft + canonical + deprecated 多版本）。 */
  getByCanonicalOwnerPath(path: string): WikiMemory[] {
    const rows = this.db
      .select()
      .from(wikiMemories)
      .where(eq(wikiMemories.canonicalOwnerPath, path))
      .orderBy(desc(wikiMemories.updatedAt))
      .all()
    return rows.map(hydrate)
  }

  /** 按 state 查（lint 扫所有 canonical / 待 promote draft / TTL 巡检 deprecated）。 */
  getByState(state: WikiMemoryState, limit = 1000): WikiMemory[] {
    const rows = this.db
      .select()
      .from(wikiMemories)
      .where(eq(wikiMemories.state, state))
      .orderBy(desc(wikiMemories.updatedAt))
      .limit(limit)
      .all()
    return rows.map(hydrate)
  }

  /** 全表扫（lint 全局漂移检测，加 limit 防 OOM）。 */
  listAll(limit = 10000): WikiMemory[] {
    const rows = this.db
      .select()
      .from(wikiMemories)
      .orderBy(desc(wikiMemories.updatedAt))
      .limit(limit)
      .all()
    return rows.map(hydrate)
  }
}

function serializeJson<T>(value: T[] | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return JSON.stringify(value)
}

function parseJsonArray<T>(value: string | null): T[] | null {
  if (value === null || value === "") return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : null
  } catch {
    return null
  }
}

function parseJsonObject<T>(value: string | null): T | null {
  if (value === null || value === "") return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null
  } catch {
    return null
  }
}

type RawRow = typeof wikiMemories.$inferSelect

function hydrate(row: RawRow): WikiMemory {
  return {
    id: row.id,
    type: row.type as WikiMemoryType,
    name: row.name,
    canonicalOwnerPath: row.canonicalOwnerPath,
    promotionTarget: row.promotionTarget,
    ttlDays: row.ttlDays,
    supersedes: parseJsonArray<string>(row.supersedes),
    replacesInBuckets: parseJsonArray<string>(row.replacesInBuckets),
    sourceMessageIds: parseJsonArray<string>(row.sourceMessageIds),
    contributedBy: parseJsonArray<string>(row.contributedBy) ?? [],
    crossRefs: parseJsonArray<unknown>(row.crossRefs),
    dedupDecision: parseJsonObject<Record<string, unknown>>(row.dedupDecision),
    body: row.body,
    state: row.state as WikiMemoryState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
