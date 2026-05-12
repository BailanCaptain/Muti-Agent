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
  /** 读最新一行 checkpoint（无视 committed_at；caller 自己判 staleness）。 */
  read(roomId: string): RoomCheckpointRow | null
  /** PREPARE：upsert（committed_at=null）。返回写入的 compiledAt 用于 COMMIT 阶段定位。 */
  prepare(row: Omit<RoomCheckpointRow, "committedAt">): void
  /** COMMIT：committed_at = now WHERE room_id AND compiled_at（精确定位防 race）。 */
  commit(roomId: string, compiledAt: string, committedAt: string): boolean
  /** 列出所有 committed_at IS NULL 的行（reconciler 用）。 */
  listIncomplete(): RoomCheckpointRow[]
  /** 删除 prepare 行（reconciler 文件 hash 不匹配走这条）。 */
  deletePrepare(roomId: string, compiledAt: string): boolean
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
}

export class RoomCompiler {
  constructor(private readonly opts: RoomCompilerOptions) {}

  /**
   * 跑一轮二阶段提交。caller 已通过 shouldCompile 判定为该跑。
   *
   * 失败语义：
   *   - prepare 失败 → 抛 RoomCompilerError("prepare")，无副作用
   *   - write  失败 → 抛 RoomCompilerError("write")；prepare 行残留（committed_at=null），
   *                   reconciler 启动时会清掉
   *   - commit 失败 → 抛 RoomCompilerError("commit")；prepare 行残留 + 文件已落盘，
   *                   reconciler 会按 hash 比对补 committed_at
   */
  async run(input: {
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

    // Phase 1: PREPARE
    try {
      this.opts.store.prepare(prepareRow)
    } catch (err) {
      throw new RoomCompilerError(
        "prepare",
        `checkpoint prepare upsert failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    // Phase 2: WRITE (atomic rename)
    const dir = path.join(this.opts.wikiRoot, "rooms", input.roomId)
    try {
      writeFileAtomic(path.join(dir, "viewfinder.md"), artifact.viewfinderMd)
      writeFileAtomic(path.join(dir, "decisions.md"), artifact.decisionsMd)
      writeFileAtomic(path.join(dir, "log.md"), artifact.logMd)
    } catch (err) {
      throw new RoomCompilerError(
        "write",
        `atomic write failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }

    // Phase 3: COMMIT
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

    return {
      artifact,
      checkpoint: { ...prepareRow, committedAt },
    }
  }

  /**
   * 崩溃恢复 (chap 8 行 918-923)。
   * 启动时调一次（P7.5 startup reconciler 会包装）。
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
      const viewfinderPath = path.join(dir, "viewfinder.md")

      let fileHash: string | null = null
      try {
        const content = await fsAsync.readFile(viewfinderPath, "utf-8")
        fileHash = sha256(content)
      } catch (err) {
        // 文件不存在 / 读不了 → write 阶段都没成功 → 当作 rollback
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new RoomCompilerError(
            "recover",
            `read viewfinder failed: ${err instanceof Error ? err.message : String(err)}`,
            err,
          )
        }
      }

      if (fileHash === row.viewfinderHash) {
        // 文件已落盘但 commit 失败 → 补 committed_at
        const committedAt = new Date(now ?? Date.now()).toISOString()
        const ok = this.opts.store.commit(row.roomId, row.compiledAt, committedAt)
        if (ok) {
          report.patched++
          report.details.push({
            roomId: row.roomId,
            compiledAt: row.compiledAt,
            action: "patched",
            reason: "file_hash_matches_prepare",
          })
        }
        continue
      }

      // hash 不匹配（含 ENOENT / 半写 / 已被新 prepare 覆盖文件）→ 删 prepare 行
      const deleted = this.opts.store.deletePrepare(row.roomId, row.compiledAt)
      if (deleted) {
        report.rolledBack++
        report.details.push({
          roomId: row.roomId,
          compiledAt: row.compiledAt,
          action: "rolled_back",
          reason: fileHash === null ? "file_missing" : "file_hash_mismatch",
        })
      }
    }
    return report
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}
