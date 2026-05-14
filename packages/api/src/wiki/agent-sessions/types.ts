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
