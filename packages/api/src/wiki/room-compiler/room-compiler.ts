/**
 * F027 P7 · RoomCompiler 二阶段提交 + reconciler
 * 真相源：docs/plans/V16.5-final.md chap 8 行 911-925
 *
 * 二阶段提交协议：
 *   1. PREPARE: INSERT/UPDATE room_checkpoints (compiled_at=now, committed_at=null,
 *      hash 三件套已写)
 *   2. WRITE:   atomic-rename viewfinder.md / decisions.md / log.md
 *   3. COMMIT:  UPDATE row SET committed_at=now WHERE room_id=? AND compiled_at=?
 *
 * 崩溃恢复 (recoverIncomplete)：
 *   - 扫所有 committed_at IS NULL 的 room_checkpoints
 *   - 对每行：
 *     a. 读 viewfinder.md 当前 hash
 *     b. file_hash == viewfinder_hash → 文件已落盘但 commit 失败 → 补 committed_at = now
 *     c. file_hash 不匹配 → DELETE 这条 prepare 行（caller 下次重新 compile）
 *
 * SessionBootstrap 只读 committed_at IS NOT NULL 的 row（chap 8 行 924）。
 *
 * F018 边界：
 *   - F018 TranscriptWriter（不变）只 flush jsonl + digest
 *   - 本 compiler 监听 thread_seal_events（独立流）+ message_commit_seq
 *   - 共享 SQLite WAL，不同表分离
 */

import { createHash } from "node:crypto"
import { promises as fsAsync } from "node:fs"
import path from "node:path"
import { writeFileAtomic } from "../atomic-write"
import {
  type CompileArtifact,
  type CompileFn,
  type MessageCommitRow,
  type ReconcileReport,
  type RoomCheckpointRow,
  RoomCompilerError,
  type ThreadSealRow,
} from "./types"

export interface CheckpointStore {
  /**
   * Compiler 侧读：返回最新一行 checkpoint（含 committed_at=null 的 prepare 行）。
   * Compiler 自己用来判断要不要 prepare、cursor 推到哪。
   */
  read(roomId: string): RoomCheckpointRow | null
  /**
   * 范-r1 P2-1 修：Bootstrap 侧读 —— 必须只返回 committed_at IS NOT NULL 的行。
   * 真相源 V16.5 chap 8 行 924 "SessionBootstrap 只读 committed_at IS NOT NULL"。
   * SQL 直接 filter，防误用：caller 即便忘了走 staleness 也不会读到 prepare 行。
   */
  readForBootstrap(roomId: string): RoomCheckpointRow | null
  /** PREPARE：upsert（committed_at=null）。返回写入的 compiledAt 用于 COMMIT 阶段定位。 */
  prepare(row: Omit<RoomCheckpointRow, "committedAt">): void
  /** COMMIT：committed_at = now WHERE room_id AND compiled_at（精确定位防 race）。 */
  commit(roomId: string, compiledAt: string, committedAt: string): boolean
  /** 列出所有 committed_at IS NULL 的行（reconciler 用）。 */
  listIncomplete(): RoomCheckpointRow[]
  /** 删除 prepare 行（reconciler 文件 hash 不匹配走这条）。 */
  deletePrepare(roomId: string, compiledAt: string): boolean
}

/**
 * F027 P4 hotfix · wiki_events sink 抽象 — 兼容 WikiEventsRepository 又允许测试注 noop。
 * 真相源：V16.5 §5 line 452 "所有 wiki 写操作走 append-only event log"。
 * RoomCompiler 派生 viewfinder.md 也是"wiki 写操作"，必须在 wiki_events 留痕。
 */
export interface WikiEventsSinkLike {
  appendPending(input: {
    ts: string
    alias: string
    action: "write"
    path: string
    baseHash?: string | null
    attemptedHash: string
    sourceMessageIds?: string[] | null
    reason?: string | null
    fencingToken: string
    leaderTerm: string
  }): { id: number }
  commit(eventId: number, input: { contentHash: string }): boolean
  abort(eventId: number, input: { error?: string | null; reason?: string | null }): boolean
}

export interface RoomCompilerOptions {
  store: CheckpointStore
  /** wiki 根目录；compiler 写到 <wikiRoot>/rooms/<roomId>/(viewfinder|decisions|log).md */
  wikiRoot: string
  /** 编译业务逻辑（Phase 1 P12 viewfinder + P10 decision-extractor 后期接入）。 */
  compileFn: CompileFn
  /** 注入 leader_term + fencing_token（来自 chap 5 Compiler Leader Lease）。 */
  leaderTerm: string
  fencingToken: string
  /**
   * F027 P4 hotfix · 可选 wiki_events sink。注入时每次 viewfinder.md 写入都 留 wiki_events row
   * (PREPARE → write file → COMMIT 三阶段)；未注入时回退到旧行为（只写 room_checkpoints）。
   * 真相源：V16.5 §5 + Prompt Inspector "追溯 wiki_events" 按钮需要这条 audit。
   */
  wikiEventsSink?: WikiEventsSinkLike | null
  /** wiki_events alias 字段（V16.5 §11 line 1196 "system-auto-room-compiler 写"）。 */
  wikiEventsAlias?: string
}

export class RoomCompiler {
  /**
   * 范-r1 P1-2 修：per-room async mutex —— 同 room 的 run() 调用串行化。
   * 防御场景：caller 在 await 中再触发同 room 二次 run() 时（比如 setTimeout / event-driven 调度），
   * 不会出现 stale writer A 在 B commit 后再 writeFileAtomic 覆盖文件的反例。
   *
   * 注意：本 mutex 只覆盖单进程内同 RoomCompiler 实例的并发；
   * 跨进程 / 多 leader 仍靠 chap 5 Compiler Leader Lease + leader_term 双保险。
   */
  private readonly roomLockTails = new Map<string, Promise<unknown>>()

  constructor(private readonly opts: RoomCompilerOptions) {}

  private async withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.roomLockTails.get(roomId) ?? Promise.resolve()
    // 即便 prev reject 也要让后续走（mutex 不应因 task 异常 deadlock）
    const task = prev.then(fn, fn)
    this.roomLockTails.set(roomId, task)
    try {
      return await task
    } finally {
      // 只在自己仍是队尾时才清，避免删掉后续排队的链
      if (this.roomLockTails.get(roomId) === task) {
        this.roomLockTails.delete(roomId)
      }
    }
  }

  /**
   * 跑一轮二阶段提交。caller 已通过 shouldCompile 判定为该跑。
   *
   * 同 room 并发：自动 mutex 串行化（范-r1 P1-2）。
   *
   * 失败语义：
   *   - prepare 失败 → 抛 RoomCompilerError("prepare")，无副作用
   *   - write  失败 → 抛 RoomCompilerError("write")；prepare 行残留（committed_at=null），
   *                   reconciler 启动时会清掉
   *   - commit 失败 → 抛 RoomCompilerError("commit")；prepare 行残留 + 文件已落盘，
   *                   reconciler 会按 hash 比对补 committed_at（必须 3 文件 hash 全匹配）
   */
  async run(input: {
    roomId: string
    newMessages: MessageCommitRow[]
    newSeals: ThreadSealRow[]
    now?: number
  }): Promise<{ artifact: CompileArtifact; checkpoint: RoomCheckpointRow }> {
    return this.withRoomLock(input.roomId, () => this.runUnlocked(input))
  }

  private async runUnlocked(input: {
    roomId: string
    newMessages: MessageCommitRow[]
    newSeals: ThreadSealRow[]
    now?: number
  }): Promise<{ artifact: CompileArtifact; checkpoint: RoomCheckpointRow }> {
    const now = input.now ?? Date.now()
    const compiledAt = new Date(now).toISOString()

    const prev = this.opts.store.read(input.roomId)

    // Phase 0: compile in-memory
    let artifact: CompileArtifact
    try {
      artifact = await this.opts.compileFn({
        roomId: input.roomId,
        prevCheckpoint: prev,
        newMessages: input.newMessages,
        newSeals: input.newSeals,
      })
    } catch (err) {
      throw new RoomCompilerError(
        "prepare",
        `compileFn failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    const viewfinderHash = sha256(artifact.viewfinderMd)
    const decisionsHash = sha256(artifact.decisionsMd)
    const logHash = sha256(artifact.logMd)

    const prepareRow: Omit<RoomCheckpointRow, "committedAt"> = {
      roomId: input.roomId,
      cursorCommitSeq: artifact.cursorCommitSeq,
      cursorMessageId: artifact.cursorMessageId,
      sealedCursorSeq: artifact.sealedCursorSeq,
      viewfinderHash,
      decisionsHash,
      logHash,
      threadSealId: artifact.threadSealId,
      compiledAt,
      fencingToken: this.opts.fencingToken,
      leaderTerm: this.opts.leaderTerm,
    }

    // Phase 1: PREPARE (room_checkpoints + 可选 wiki_events)
    try {
      this.opts.store.prepare(prepareRow)
    } catch (err) {
      throw new RoomCompilerError(
        "prepare",
        `checkpoint prepare upsert failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    // F027 P4 hotfix · wiki_events append-only 留痕（V16.5 §5 line 452）。
    // V16.5 §8 line 533：RoomCompiler 派生 viewfinder.md + decisions.md + log.md，
    // 每个文件都是独立 wiki path 都要走三阶段。F027 P4-A4 修：补 decisions + log 两文件
    // （此前只 audit 了 viewfinder，违反 V16.5 §5 "所有 wiki 写" 强契约）。
    // 范-r1 P1 修：fail-closed — appendPending 故障必须抛错；rollback prepare 保双表一致。
    type PendingAudit = { eventId: number; contentHash: string }
    const pendingAudits: PendingAudit[] = []
    if (this.opts.wikiEventsSink) {
      const sourceMessageIds = input.newMessages.map((m) => m.messageId)
      const reason = `RoomCompiler tick · newMessages=${input.newMessages.length} newSeals=${input.newSeals.length}`
      const targets: Array<{ relPath: string; attemptedHash: string; baseHash: string | null }> = [
        {
          relPath: `wiki/rooms/${input.roomId}/viewfinder.md`,
          attemptedHash: viewfinderHash,
          baseHash: prev?.viewfinderHash ?? null,
        },
        {
          relPath: `wiki/rooms/${input.roomId}/decisions.md`,
          attemptedHash: decisionsHash,
          baseHash: prev?.decisionsHash ?? null,
        },
        {
          relPath: `wiki/rooms/${input.roomId}/log.md`,
          attemptedHash: logHash,
          baseHash: prev?.logHash ?? null,
        },
      ]
      try {
        for (const t of targets) {
          const event = this.opts.wikiEventsSink.appendPending({
            ts: compiledAt,
            alias: this.opts.wikiEventsAlias ?? "system-room-compiler",
            action: "write",
            path: t.relPath,
            baseHash: t.baseHash,
            attemptedHash: t.attemptedHash,
            sourceMessageIds,
            reason,
            fencingToken: this.opts.fencingToken,
            leaderTerm: this.opts.leaderTerm,
          })
          pendingAudits.push({ eventId: event.id, contentHash: t.attemptedHash })
        }
      } catch (err) {
        // fail-closed: abort 已 append 的 audit 行 + rollback room_checkpoints prepare 后抛错
        for (const audit of pendingAudits) {
          try {
            this.opts.wikiEventsSink.abort(audit.eventId, {
              error: err instanceof Error ? err.message : String(err),
              reason: "partial_prepare_rollback",
            })
          } catch {
            // abort 失败也吞 — 主 throw 优先；reconciler 会清残留 pending 行
          }
        }
        try {
          this.opts.store.deletePrepare(input.roomId, compiledAt)
        } catch {
          // deletePrepare 失败也吞 — 主 throw 优先；reconciler 会清残留 prepare 行
        }
        throw new RoomCompilerError(
          "prepare",
          `wiki_events.appendPending failed (V16.5 §5 audit log mandatory): ${err instanceof Error ? err.message : String(err)}`,
          err,
        )
      }
    }

    // Phase 2: WRITE (atomic rename)
    const dir = path.join(this.opts.wikiRoot, "rooms", input.roomId)
    try {
      writeFileAtomic(path.join(dir, "viewfinder.md"), artifact.viewfinderMd)
      writeFileAtomic(path.join(dir, "decisions.md"), artifact.decisionsMd)
      writeFileAtomic(path.join(dir, "log.md"), artifact.logMd)
    } catch (err) {
      // WRITE 失败 → abort 所有 wiki_events row
      if (this.opts.wikiEventsSink) {
        for (const audit of pendingAudits) {
          try {
            this.opts.wikiEventsSink.abort(audit.eventId, {
              error: err instanceof Error ? err.message : String(err),
              reason: "atomic_write_failed",
            })
          } catch {
            // abort 失败也不抛 — 主 throw 优先
          }
        }
      }
      throw new RoomCompilerError(
        "write",
        `atomic write failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    // Phase 3: COMMIT (room_checkpoints + 可选 wiki_events)
    const committedAt = new Date(Date.now()).toISOString()
    let committed: boolean
    try {
      committed = this.opts.store.commit(input.roomId, compiledAt, committedAt)
    } catch (err) {
      throw new RoomCompilerError(
        "commit",
        `commit update failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    if (!committed) {
      throw new RoomCompilerError(
        "commit",
        `commit affected 0 rows: race? room=${input.roomId} compiledAt=${compiledAt}`,
      )
    }
    // wiki_events COMMIT (fail-soft — checkpoint 已 commit 后即便 audit commit 失败也不回滚)
    if (this.opts.wikiEventsSink) {
      for (const audit of pendingAudits) {
        try {
          this.opts.wikiEventsSink.commit(audit.eventId, { contentHash: audit.contentHash })
        } catch {
          // 留 pending 行让 startup reconciler 通过文件 hash 比对 patch
        }
      }
    }

    return {
      artifact,
      checkpoint: { ...prepareRow, committedAt },
    }
  }

  /**
   * 崩溃恢复 (chap 8 行 918-923)。
   * 启动时调一次（P7.5 startup reconciler 会包装）。
   *
   * 范-r1 P1-1 修：必须 3 文件 (viewfinder.md / decisions.md / log.md) hash 全匹配
   * 才补 committed_at。任一文件缺失或 hash 不匹配都走 rollback —— 防 WRITE 阶段
   * 中途崩 (viewfinder rename 完但 decisions/log 没写) 时只看 viewfinder 误判 commit。
   */
  async recoverIncomplete(now?: number): Promise<ReconcileReport> {
    const incomplete = this.opts.store.listIncomplete()
    const report: ReconcileReport = {
      scanned: incomplete.length,
      patched: 0,
      rolledBack: 0,
      details: [],
    }

    for (const row of incomplete) {
      const dir = path.join(this.opts.wikiRoot, "rooms", row.roomId)
      const check = await checkAllThreeFiles(dir, row)

      if (check.allMatch) {
        // 3 文件全落盘且 hash 全对 → 补 committed_at（write 完了 commit 没跑）
        const committedAt = new Date(now ?? Date.now()).toISOString()
        const ok = this.opts.store.commit(row.roomId, row.compiledAt, committedAt)
        if (ok) {
          report.patched++
          report.details.push({
            roomId: row.roomId,
            compiledAt: row.compiledAt,
            action: "patched",
            reason: "all_three_files_match",
          })
        }
        continue
      }

      // 任一文件缺失 / hash 不匹配 → 删 prepare 行（caller 重新 compile）
      const deleted = this.opts.store.deletePrepare(row.roomId, row.compiledAt)
      if (deleted) {
        report.rolledBack++
        report.details.push({
          roomId: row.roomId,
          compiledAt: row.compiledAt,
          action: "rolled_back",
          reason: check.firstFailReason,
        })
      }
    }
    return report
  }
}

interface FileCheckResult {
  allMatch: boolean
  /** 第一个失败的原因（"<file>_missing" | "<file>_hash_mismatch" | "all_three_files_match"） */
  firstFailReason: string
}

async function checkAllThreeFiles(dir: string, row: RoomCheckpointRow): Promise<FileCheckResult> {
  const checks: Array<{ file: string; expectedHash: string }> = [
    { file: "viewfinder.md", expectedHash: row.viewfinderHash },
    { file: "decisions.md", expectedHash: row.decisionsHash },
    { file: "log.md", expectedHash: row.logHash },
  ]
  for (const c of checks) {
    let actualHash: string | null = null
    try {
      const content = await fsAsync.readFile(path.join(dir, c.file), "utf-8")
      actualHash = sha256(content)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RoomCompilerError(
          "recover",
          `read ${c.file} failed: ${err instanceof Error ? err.message : String(err)}`,
          err,
        )
      }
    }
    if (actualHash === null) {
      return { allMatch: false, firstFailReason: `${c.file}_missing` }
    }
    if (actualHash !== c.expectedHash) {
      return { allMatch: false, firstFailReason: `${c.file}_hash_mismatch` }
    }
  }
  return { allMatch: true, firstFailReason: "all_three_files_match" }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}
