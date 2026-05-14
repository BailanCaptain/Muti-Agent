/**
 * F027 P7 · RoomCompiler types
 * 真相源：docs/plans/V16.5-final.md chap 8 行 860-957
 *
 * 三表角色：
 *   - room_checkpoints     ← compiler 自己管理，二阶段提交 (PREPARE → WRITE → COMMIT)
 *   - message_commit_seq   ← F004 message-service 同事务 INSERT；compiler 只读
 *   - thread_seal_events   ← F018 seal 同事务 INSERT；compiler 只读 sealed_cursor_seq
 */

export interface RoomCheckpointRow {
  roomId: string
  cursorCommitSeq: number
  cursorMessageId: string
  sealedCursorSeq: number
  viewfinderHash: string
  decisionsHash: string
  logHash: string
  threadSealId: string | null
  compiledAt: string
  committedAt: string | null
  fencingToken: string
  leaderTerm: string
}

/** F004 message-service 同事务 INSERT message_commit_seq 用 */
export interface MessageCommitRow {
  seq: number
  messageId: string
  committedAt: string
  /** chap 8 触发条件需 message.role 计 user 数；compiler 现拉 messages 表回填 */
  role?: "user" | "assistant" | "system" | "tool"
}

/** F018 seal 同事务 INSERT thread_seal_events 用 */
export interface ThreadSealRow {
  seq: number
  threadId: string
  roomId: string
  sealedAt: string
  fencingToken: string
}

/**
 * shouldCompile 输入。新 messages / 新 seals 只取 cursor 之后的部分。
 * 规则 (V16.5 chap 8 行 902-908)：
 *   - userCount >= 8       → 触发
 *   - idleMs > 30 * 60_000 → 触发
 *   - newSeals.length > 0  → 触发
 */
export interface CompileTriggerInput {
  checkpoint: RoomCheckpointRow | null
  newMessages: MessageCommitRow[]
  newSeals: ThreadSealRow[]
  now: number // ms epoch
  config?: {
    userCountThreshold?: number // default 8
    idleMs?: number // default 30 * 60_000
  }
}

export type CompileTriggerReason =
  | "user_count_reached"
  | "idle_timeout"
  | "new_seal"
  | "first_compile"

export interface CompileTriggerDecision {
  shouldCompile: boolean
  reasons: CompileTriggerReason[]
  details: {
    userCount: number
    idleMs: number | null
    sealCount: number
  }
}

/**
 * Compile artifact —— RoomCompiler.run() 产出，写到 wiki/rooms/<roomId>/。
 * 三个文件 hash 存进 room_checkpoints 行做 reconciler 比对（chap 8 行 921-923）。
 */
export interface CompileArtifact {
  viewfinderMd: string
  decisionsMd: string
  logMd: string
  cursorCommitSeq: number
  cursorMessageId: string
  sealedCursorSeq: number
  threadSealId: string | null
}

/** 调用方注入：compile 业务逻辑（P12 viewfinder + P10 decision-extractor 后期接入）。 */
export type CompileFn = (input: {
  roomId: string
  prevCheckpoint: RoomCheckpointRow | null
  newMessages: MessageCommitRow[]
  newSeals: ThreadSealRow[]
}) => Promise<CompileArtifact> | CompileArtifact

/**
 * Max-staleness SLA (V16.5 chap 8 行 934-943)。
 *   - warn     → SessionBootstrap 拿 viewfinder + 注入 staleness warning（默认）
 *   - sync     → 调用方触发同步 catch-up（compiler 立即编，wake-up ≤ 30s）
 *   - fallback → 不读 viewfinder；改读 messages tail（最近 20 条）
 */
export type StalenessStrategy = "warn" | "sync" | "fallback"

export interface StalenessCheckResult {
  stale: boolean
  ageMs: number
  strategy: StalenessStrategy
  decision: "use_viewfinder" | "trigger_sync" | "fallback_messages"
  warning?: string
}

export class RoomCompilerError extends Error {
  constructor(
    public readonly stage: "prepare" | "write" | "commit" | "recover",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = "RoomCompilerError"
  }
}

export interface ReconcileReport {
  scanned: number
  patched: number // file 已落盘 → 补 committed_at
  rolledBack: number // file 不匹配 → 删 prepare 行（待重新 compile）
  details: Array<{
    roomId: string
    compiledAt: string
    action: "patched" | "rolled_back"
    reason: string
  }>
}
