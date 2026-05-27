/**
 * F027 P8 · agent-sessions 域类型
 * 真相源：docs/plans/V16.5-final.md chap 9 行 960-1086
 *
 * 角色：每位 agent 在每个 room 的每次"进出"按 session_seq 单调累积。
 * 文件结构：wiki/rooms/<roomId>/agent-sessions/<alias>/S-<seq>.md（永久保留）
 *          + current.md（最新 session digest 派生，assembler 注入热路径）
 *          + packs/<year>.md（yearly archive 合并）
 *
 * Sharding 三招（chap 9 行 1063-1079）：
 *   1. room/alias shard（结构自然分布）
 *   2. yearly pack：上一年 S-XXXX.md → archive 目录 + 主目录只留 active
 *   3. current.md 热路径：assembler 不扫 S 文件，只读 200-400 tok 的 current
 *
 * AC-P1-8：100k session 模拟 + active < 1k（sharding 后 git 索引不爆）
 */

/**
 * V16.5 M2 修：open_thread 允许字符串（兼容旧）或 {text, a2a_call_id?} 结构。
 * a2a_call_id 关联 F026 a2a_calls.call_id（"等回复"型 thread）；状态由 callRegistry 实时 join。
 */
export type OpenThread = string | { text: string; a2a_call_id?: string }

/**
 * F027 v3 G10 · OpenThread 运行时 type guard (单值)。
 *
 * 之前 schema 是 TEXT 列存 JSON union，repository.parseJsonOrEmpty 只检 Array.isArray
 * 不检每项 shape — 老 DB row 含格式错的 entry 会 silent 传到 UI/assembler 注入。
 * 此 guard 给 boundary (repository hydrate / API request) 用，单项格式错时直接 reject。
 */
export function isOpenThread(value: unknown): value is OpenThread {
  if (typeof value === "string") return true
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.text !== "string" || obj.text.length === 0) return false
  if (obj.a2a_call_id !== undefined && typeof obj.a2a_call_id !== "string") return false
  return true
}

/** F027 v3 G10 · OpenThread[] 运行时 type guard (整数组每项 valid 才过)。 */
export function isOpenThreadArray(value: unknown): value is OpenThread[] {
  return Array.isArray(value) && value.every(isOpenThread)
}

/**
 * F027 v3 G10 · 把 raw JSON parsed 数组过滤成合法 OpenThread[]，丢弃非法 entry + 记 count.
 *
 * 用于 repository hydrate path: 不抛错保持向后兼容 (老 DB 数据可能含 schema 漂)，
 * 但格式错的 entry 不传到 UI/assembler — 比 silent passthrough 安全。
 */
export function sanitizeOpenThreads(rawArray: unknown): {
  valid: OpenThread[]
  droppedCount: number
} {
  if (!Array.isArray(rawArray)) return { valid: [], droppedCount: 0 }
  const valid: OpenThread[] = []
  let droppedCount = 0
  for (const item of rawArray) {
    if (isOpenThread(item)) valid.push(item)
    else droppedCount += 1
  }
  return { valid, droppedCount }
}

/** DB 行 hydrate 后（JSON 字段已解析）。 */
export interface RoomAgentSession {
  sessionId: number
  roomId: string
  alias: string
  sessionSeq: number
  startedAt: string
  endedAt: string | null
  entryReason: string
  exitReason: string | null
  lastSeenCommitSeq: number | null
  openThreads: OpenThread[]
  closedThreads: string[]
  privateNotesHash: string | null
  sessionDigest: string | null
  archived: "N" | "Y"
  archivedAt: string | null
  archivedYear: number | null
}

/** Create 时入参（session_seq 由 repo 自增推得；caller 不传）。 */
export interface CreateSessionInput {
  roomId: string
  alias: string
  startedAt: string
  entryReason: string
  lastSeenCommitSeq?: number | null
}

export interface EndSessionInput {
  endedAt: string
  exitReason: string
  lastSeenCommitSeq?: number | null
  openThreads?: OpenThread[]
  closedThreads?: string[]
  privateNotesHash?: string | null
  sessionDigest?: string | null
}

/**
 * S-NNNN.md frontmatter（chap 9 行 1005-1031）。
 * canonical_owner_path 是 wiki/rooms/<roomId>/agent-sessions/<alias>/S-<seq>.md
 * （防漂桶 lint 兜底：caller 不可改）。
 */
export interface SessionLedgerFrontmatter {
  session_id: number
  room_id: string
  alias: string
  session_seq: number
  started_at: string
  ended_at: string | null
  entry_reason: string
  exit_reason: string | null
  last_seen_commit_seq: number | null
  open_threads: OpenThread[]
  closed_threads: string[]
  canonical_owner_path: string
  sources: Array<{ type: "room-messages"; message_id_range?: [string, string] }>
}

/** Yearly pack archive 报告 —— P14 NightlyJobScheduler '@cron 1 月 1 日' 调用。 */
export interface YearlyPackReport {
  year: number
  scanned: number
  archived: number
  packPath: string
  /** archive 目录绝对路径（wiki/archive/agent-sessions/<roomId>/<alias>/<year>/） */
  archivedDir: string
}

export class AgentSessionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentSessionsError"
  }
}
