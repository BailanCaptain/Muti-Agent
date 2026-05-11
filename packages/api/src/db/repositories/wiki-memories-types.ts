/**
 * F027 P10 · wiki_memories 域类型 + 状态机契约
 * 真相源：docs/plans/V16.5-final.md chap 14
 *
 * 5 类记忆桶物理表（conversation 桶逻辑上属 6 类，物理由 messages 表承载，
 * 不在 type enum 中 — V16.5 chap 14 line 1599-1607）。
 *
 * 状态机：
 *   draft ──promote──► canonical ──deprecate──► deprecated
 *           └─reject──► deprecated（小孙 review 拒掉直接 demote）
 *
 * canonical 行的 contributed_by + cross_refs + dedup_decision 由 LLM 编译填
 * （V16.5 chap 26 编译 3 阶段 — Phase 1 P4.6 实施）。
 */

export const WIKI_MEMORY_TYPES = ["room", "project", "user", "feedback", "work"] as const

export type WikiMemoryType = (typeof WIKI_MEMORY_TYPES)[number]

export type WikiMemoryState = "draft" | "canonical" | "deprecated"

/** Hydrated row（JSON 字段已解析）。 */
export interface WikiMemory {
  id: number
  type: WikiMemoryType
  name: string
  canonicalOwnerPath: string
  promotionTarget: string | null
  ttlDays: number | null
  supersedes: string[] | null
  replacesInBuckets: string[] | null
  sourceMessageIds: string[] | null
  contributedBy: string[]
  crossRefs: unknown[] | null
  dedupDecision: Record<string, unknown> | null
  body: string
  state: WikiMemoryState
  createdAt: string
  updatedAt: string
}

export interface InsertWikiMemoryInput {
  type: WikiMemoryType
  name: string
  canonicalOwnerPath: string
  promotionTarget?: string | null
  ttlDays?: number | null
  supersedes?: string[] | null
  replacesInBuckets?: string[] | null
  sourceMessageIds?: string[] | null
  contributedBy: string[]
  crossRefs?: unknown[] | null
  dedupDecision?: Record<string, unknown> | null
  body: string
  state?: WikiMemoryState
  createdAt?: string
}

/**
 * V16.5 chap 14 type-routed 写时校验：
 *   - canonical_owner_path 必须以 wiki/<type>/ 开头（按 type 强路由 — 防漂桶）
 *   - room 桶必须 promotion_target IS NULL（room 是派生视图终点，不可 promote）
 */
export class InvalidBucketPathError extends Error {
  constructor(
    readonly type: WikiMemoryType,
    readonly canonicalOwnerPath: string,
    readonly expectedPrefix: string,
  ) {
    super(
      `InvalidBucketPathError: type=${type} requires canonical_owner_path to start with "${expectedPrefix}", got "${canonicalOwnerPath}"`,
    )
    this.name = "InvalidBucketPathError"
  }
}

export class RoomBucketCannotPromoteError extends Error {
  constructor(readonly canonicalOwnerPath: string) {
    super(
      `RoomBucketCannotPromoteError: room 桶记录禁止设置 promotion_target（path=${canonicalOwnerPath}）`,
    )
    this.name = "RoomBucketCannotPromoteError"
  }
}

/** state 机器只允许 draft→canonical / draft→deprecated / canonical→deprecated。 */
export class InvalidStateTransitionError extends Error {
  constructor(
    readonly memoryId: number,
    readonly from: WikiMemoryState,
    readonly to: WikiMemoryState,
  ) {
    super(
      `InvalidStateTransitionError: wiki_memories[${memoryId}] cannot transition ${from} → ${to}`,
    )
    this.name = "InvalidStateTransitionError"
  }
}

/**
 * V16.5 chap 14 状态机白名单。范-review-r1 finding：repo.updateState 之前只 CAS
 * `from`，未约束 `to` —— `updateState(id, "deprecated", "canonical")` 会真改回 canonical
 * 违反白名单。本表 = 单一真相源，repo / lint / 调试工具一起用。
 */
export const VALID_STATE_TRANSITIONS: Record<WikiMemoryState, readonly WikiMemoryState[]> = {
  draft: ["canonical", "deprecated"],
  canonical: ["deprecated"],
  deprecated: [],
}

export function isValidTransition(from: WikiMemoryState, to: WikiMemoryState): boolean {
  return VALID_STATE_TRANSITIONS[from].includes(to)
}

/** chap 14 type-routed 默认 ttl：feedback 桶 30 天，其他无默认（永久）。 */
export const DEFAULT_FEEDBACK_TTL_DAYS = 30

export function bucketPrefix(type: WikiMemoryType): string {
  return `wiki/${type}/`
}
