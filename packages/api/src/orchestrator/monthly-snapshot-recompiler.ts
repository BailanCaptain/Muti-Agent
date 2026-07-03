/**
 * F027 修2 (残债 C1.5) · MonthlySnapshot 真业务依赖 — 无副作用重编器 + backup + replace
 *
 * 真相源：docs/plans/V16.5-final.md chap 11 line 1202-1236（anti-drift 派生 b:
 * MonthlySnapshot full recompile）+ 小孙 2026-07-03 拍板口径：
 *   - 只探近 90 天有消息活动的 room（activeDays）
 *   - 单次上限 30 room（maxRoomsPerRun），滚动窗口：最久未探的优先，探过的记
 *     state 文件，下月轮到没探的 —— 全量覆盖靠月份滚动摊开，控 LLM 成本
 *   - 判官用生产 RoomCompiler 同一个 judgeRunner（不是 wikiCompile 可配模型）：
 *     drift 必须 apples-to-apples —— 换模型重编测出的是模型差异，不是内容漂移
 *
 * 无副作用设计（probe 语义）：
 *   - 复用 createViewfinderCompileFn（Phase 0 内存编译），prevCheckpoint=null 全量视角
 *   - ledger 用 createProbeDecisionLedger 的 overlay 视图（范-r1 P1/P2-2 修）：
 *     本轮 append 写进内存虚拟行（负 id），读方法返回「真表 ∪ overlay」合并视图 ——
 *     探针新判出的决策真实进入 recompiledViewfinder（这正是抓历史漏编的核心价值），
 *     但一行都不落库；markCompleted 沿用生产 fencing 语义（只 sweep 同 token 行 =
 *     本轮虚拟行）。实现是 plain object 组合而非继承：白名单之外的方法**不存在**，
 *     未来 compile-fn 调 DecisionLedger 新 mutator 时探针直接 TypeError（默认拒绝，
 *     不许静默污染生产 ledger）
 *   - 不写 room_checkpoints / 不写 viewfinder 文件 / 不写 wiki_events —— 重编结果
 *     只进内存 RoomSnapshot 交给 MonthlySnapshot 算 drift；真正的 replace 由
 *     MonthlySnapshot 决策后走 createSnapshotViewfinderReplacer（那条才留 audit）
 *
 * 注意：recompiled viewfinder 的 generated_at 时间戳必然与 current 不同，会贡献
 * 少量 token 级 drift 噪音；Jaccard 全文分母下远低于 30% 阈值，不做特殊剥离。
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyBaseLogger } from "fastify"

import type * as schema from "../db/schema"
import type { HaikuRunner } from "../runtime/haiku-runner"
import type { RoomSnapshot } from "../services/scheduler/monthly-snapshot"
import { writeFileAtomic } from "../wiki/atomic-write"
import type { WikiEventsSinkLike } from "../wiki/room-compiler/room-compiler"
import type { MessageCommitRow, ThreadSealRow } from "../wiki/room-compiler/types"
import { createViewfinderCompileFn } from "../wiki/viewfinder/compile-fn"
import { HaikuDecisionJudge, type HaikuLike } from "../wiki/viewfinder/decision-extractor"
import { DecisionLedger } from "../wiki/viewfinder/decision-ledger"
import type {
  AppendDecisionInput,
  DecisionJudgeProvider,
  DecisionRow,
  DecisionType,
} from "../wiki/viewfinder/types"

type DrizzleDb = BetterSQLite3Database<typeof schema>

/** 与 production-room-compile-executor 同款 drizzle → SqliteAdapterLike 适配。 */
function adaptDrizzleDb(db: DrizzleDb): {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint }
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
} {
  const dbAny = db as unknown as {
    $client?: ReturnType<typeof adaptDrizzleDb>
    session?: { client?: ReturnType<typeof adaptDrizzleDb> }
  }
  return (
    dbAny.$client ?? dbAny.session?.client ?? (db as unknown as ReturnType<typeof adaptDrizzleDb>)
  )
}

/** room_id 白名单（防 join 路径穿越 — DB 值理论受控，仍 hard gate）。 */
const ROOM_ID_RE = /^[A-Za-z0-9_-]+$/

/**
 * probe ledger overlay 视图（范-r1 P1 + P2-2 修）。
 *
 * P1：append 不能 no-op —— compile-fn 数据流是 extractor 判出 decision → append →
 * getActiveDecisions 渲染 viewfinder。no-op 会让探针新判出的决策进不了 recompiled
 * viewfinder，恰好废掉「抓历史漏编」的体检价值。修法 = in-memory overlay：
 * append 写虚拟行（负 id 递减，不与真表冲突），读方法返回「真表 ∪ overlay」合并视图
 * （同真表口径过滤 + decided_at DESC + limit 后置），零落库。
 *
 * markCompleted 沿用生产 fencing 语义（decision-ledger.ts:141 WHERE fencing_token = ?
 * — 只有存储 token 与调用 token 相同的行才可 sweep）：真表旧行 token 必不同 → 不动
 * （与生产一致）；本轮虚拟行同 token → 正常 sweep。
 *
 * P2-2：不再 extends DecisionLedger（子类只 override 已知 mutator，父类未来加新写方法
 * 默认 fail-open 继承真写实现）。改为 plain object 组合：白名单之外的方法根本不存在，
 * 任何未知调用直接 TypeError —— 默认拒绝，构造上 fail-closed。
 */
export interface ProbeDecisionLedger {
  append(input: AppendDecisionInput): number
  markCompleted(ids: ReadonlyArray<number>, fencingToken: string): number[]
  getById(decisionId: number): DecisionRow | null
  getActiveDecisions(roomId: string, limit?: number): DecisionRow[]
  getTombstoneDecisions(roomId: string): DecisionRow[]
  getActiveByType(roomId: string, type: DecisionType, limit?: number): DecisionRow[]
  /** 测试/审计用：本轮 overlay 虚拟行快照。 */
  overlayRows(): ReadonlyArray<DecisionRow>
}

export function createProbeDecisionLedger(
  db: ConstructorParameters<typeof DecisionLedger>[0],
  opts?: { nowFn?: () => string },
): ProbeDecisionLedger {
  const real = new DecisionLedger(db)
  const nowFn = opts?.nowFn ?? (() => new Date().toISOString())
  const overlay: DecisionRow[] = []
  let nextVirtualId = -1

  const byRecency = (a: DecisionRow, b: DecisionRow): number => {
    if (a.decidedAt !== b.decidedAt) return a.decidedAt < b.decidedAt ? 1 : -1
    return b.decisionId - a.decisionId
  }
  const capped = (rows: DecisionRow[], limit?: number): DecisionRow[] =>
    limit ? rows.slice(0, limit) : rows

  return {
    append(input: AppendDecisionInput): number {
      const id = nextVirtualId--
      overlay.push({
        decisionId: id,
        roomId: input.roomId,
        decidedAt: nowFn(),
        decidedBy: input.decidedBy,
        decisionType: input.decisionType,
        content: input.content,
        sourceMessageIds: [...input.sourceMessageIds],
        sourceQuote: input.sourceQuote,
        sourceHash: sha256(input.sourceQuote),
        tombstone: input.tombstone ?? false,
        supersededBy: null,
        fencingToken: input.fencingToken,
        extractorConfidence: input.extractorConfidence ?? null,
        coverageCheckPassed: null,
        status: "active",
      })
      return id
    },
    markCompleted(ids: ReadonlyArray<number>, fencingToken: string): number[] {
      // 生产同语义：status='active' AND 存储 fencing_token === 调用 token 才可 sweep。
      // 真表行 token 必不匹配探针 token → 永不触碰（零落库不变式由此保证）。
      const swept: number[] = []
      for (const row of overlay) {
        if (ids.includes(row.decisionId) && row.status === "active" && row.fencingToken === fencingToken) {
          row.status = "completed"
          swept.push(row.decisionId)
        }
      }
      return swept
    },
    getById(decisionId: number): DecisionRow | null {
      if (decisionId < 0) return overlay.find((r) => r.decisionId === decisionId) ?? null
      return real.getById(decisionId)
    },
    getActiveDecisions(roomId: string, limit?: number): DecisionRow[] {
      // 真表读不带 limit，合并排序后再截断 —— 否则真表 limit 可能截掉合并后仍该保留的行
      const merged = [
        ...real.getActiveDecisions(roomId),
        ...overlay.filter((r) => r.roomId === roomId && r.status === "active"),
      ].sort(byRecency)
      return capped(merged, limit)
    },
    getTombstoneDecisions(roomId: string): DecisionRow[] {
      return [
        ...real.getTombstoneDecisions(roomId),
        ...overlay.filter((r) => r.roomId === roomId && r.tombstone),
      ].sort(byRecency)
    },
    getActiveByType(roomId: string, type: DecisionType, limit?: number): DecisionRow[] {
      const merged = [
        ...real.getActiveByType(roomId, type),
        ...overlay.filter(
          (r) => r.roomId === roomId && r.decisionType === type && r.status === "active",
        ),
      ].sort(byRecency)
      return capped(merged, limit)
    },
    overlayRows(): ReadonlyArray<DecisionRow> {
      return overlay
    },
  }
}

// ── 房间选择（纯函数，可单测） ──────────────────────────────────────────

export interface SnapshotRoomCandidate {
  roomId: string
  /** ISO — 该 room 最新一条消息时间。 */
  lastActivityAt: string
}

/** 滚动窗口 state 文件 schema（fail-soft：损坏/缺失当空处理）。 */
export interface SnapshotRollingState {
  version: 1
  /** roomId → 上次成功探测（或明确跳过）的 ISO 时间。 */
  probedAt: Record<string, string>
}

/**
 * 选本次要探的 rooms：
 *   1. 过滤：lastActivityAt >= now - activeDays（ISO 字符串字典序比较，全 UTC 成立）
 *   2. 排序：从未探过（state 无记录）优先 → 最久未探优先 → roomId 字典序（确定性）
 *   3. 截断：maxRooms
 */
export function selectSnapshotRooms(
  candidates: ReadonlyArray<SnapshotRoomCandidate>,
  probedAt: Record<string, string>,
  nowMs: number,
  opts: { activeDays: number; maxRooms: number },
): string[] {
  const cutoffIso = new Date(nowMs - opts.activeDays * 86_400_000).toISOString()
  return candidates
    .filter((c) => c.lastActivityAt >= cutoffIso)
    .sort((a, b) => {
      const pa = probedAt[a.roomId] ?? ""
      const pb = probedAt[b.roomId] ?? ""
      if (pa !== pb) return pa < pb ? -1 : 1
      return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0
    })
    .slice(0, opts.maxRooms)
    .map((c) => c.roomId)
}

function loadRollingState(statePath: string, logger?: FastifyBaseLogger): SnapshotRollingState {
  try {
    const raw = fs.readFileSync(statePath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<SnapshotRollingState>
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.probedAt &&
      typeof parsed.probedAt === "object"
    ) {
      const probedAt: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed.probedAt)) {
        if (typeof v === "string") probedAt[k] = v
      }
      return { version: 1, probedAt }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger?.warn(
        { err: (err as Error).message, statePath },
        "[monthly-snapshot] rolling state unreadable — treating as empty",
      )
    }
  }
  return { version: 1, probedAt: {} }
}

// ── 无副作用重编器 ──────────────────────────────────────────────────────

export interface MonthlySnapshotRecompilerOptions {
  db: DrizzleDb
  /** RoomCompiler 落盘根（`<X>/rooms/<id>/viewfinder.md` 的 `<X>` = 双层 wiki/wiki）。 */
  wikiRoot: string
  /** 生产 RoomCompiler 同一个 judge runner（apples-to-apples drift）。 */
  judgeRunner: HaikuRunner
  /** 滚动窗口 state 文件绝对路径（JSON，writeFileAtomic 落盘）。 */
  statePath: string
  logger?: FastifyBaseLogger
  judgeTimeoutMs?: number
  judgeConcurrency?: number
  /** compile-fn git log spawn cwd。 */
  rootDir?: string
  /** 活跃窗口天数，默认 90。 */
  activeDays?: number
  /** 单次探测上限，默认 30。 */
  maxRoomsPerRun?: number
  /** 测试注入时钟。 */
  nowFn?: () => Date
  /** 测试注入判官（默认 HaikuDecisionJudge(judgeRunner)）。 */
  judgeProvider?: DecisionJudgeProvider
}

const DEFAULT_ACTIVE_DAYS = 90
const DEFAULT_MAX_ROOMS = 30
/** 与 force-recompile 同窗（production-room-compile-executor queryNewMessages LIMIT）。 */
const MESSAGE_WINDOW_LIMIT = 200

export function createMonthlySnapshotRecompiler(
  opts: MonthlySnapshotRecompilerOptions,
): () => Promise<RoomSnapshot[]> {
  const activeDays = opts.activeDays ?? DEFAULT_ACTIVE_DAYS
  const maxRooms = opts.maxRoomsPerRun ?? DEFAULT_MAX_ROOMS
  const nowFn = opts.nowFn ?? (() => new Date())

  return async (): Promise<RoomSnapshot[]> => {
    const adapter = adaptDrizzleDb(opts.db)
    const now = nowFn()

    // 1. 活跃 room 候选（近 activeDays 有消息）
    let candidates: SnapshotRoomCandidate[]
    try {
      const rows = adapter
        .prepare(
          "SELECT sg.room_id AS room_id, MAX(m.created_at) AS last_activity_at " +
            "FROM session_groups sg " +
            "JOIN threads t ON t.session_group_id = sg.id " +
            "JOIN messages m ON m.thread_id = t.id " +
            "WHERE sg.room_id IS NOT NULL " +
            "GROUP BY sg.room_id",
        )
        .all() as ReadonlyArray<{ room_id: string; last_activity_at: string }>
      candidates = rows
        .filter((r) => ROOM_ID_RE.test(r.room_id))
        .map((r) => ({ roomId: r.room_id, lastActivityAt: r.last_activity_at }))
    } catch (err) {
      opts.logger?.warn(
        { err: (err as Error).message },
        "[monthly-snapshot] scan active rooms failed — probe skipped this run",
      )
      return []
    }

    // 2. 只探已有 viewfinder 的 room（没编过 = 无 current 可对比，不占滚动名额）
    candidates = candidates.filter((c) =>
      fs.existsSync(path.join(opts.wikiRoot, "rooms", c.roomId, "viewfinder.md")),
    )

    // 3. 滚动窗口选择
    const state = loadRollingState(opts.statePath, opts.logger)
    const selected = selectSnapshotRooms(candidates, state.probedAt, now.getTime(), {
      activeDays,
      maxRooms,
    })
    if (selected.length === 0) return []
    opts.logger?.info(
      { selected: selected.length, candidates: candidates.length, activeDays, maxRooms },
      "[monthly-snapshot] probe rooms selected (rolling window)",
    )

    // 4. probe 编译器（overlay ledger + 生产同判官）。
    //    每 room 一个新 probe ledger —— overlay 是本轮编译的临时账本视图，不许跨 room 串。
    //    fencingToken 每 room 唯一（markCompleted 生产同语义：只 sweep 同 token = 本轮虚拟行）。
    const judge =
      opts.judgeProvider ??
      new HaikuDecisionJudge(opts.judgeRunner as HaikuLike, opts.judgeTimeoutMs ?? 30_000)

    const snapshots: RoomSnapshot[] = []
    const probedNowIso = now.toISOString()
    for (const roomId of selected) {
      const viewfinderPath = path.join(opts.wikiRoot, "rooms", roomId, "viewfinder.md")
      let current: string
      try {
        current = fs.readFileSync(viewfinderPath, "utf-8")
      } catch (err) {
        // 候选过滤后被并发删除等 — 跳过并记探测（文件都没了，重试无意义，防堵滚动窗口）
        opts.logger?.warn(
          { roomId, err: (err as Error).message },
          "[monthly-snapshot] current viewfinder unreadable — room skipped",
        )
        state.probedAt[roomId] = probedNowIso
        continue
      }

      // 范-r1 P2-1 修：查询失败 ≠ 空结果。查询/编译任一抛错 → 不记 probedAt（下次
      // 优先重试，SQLITE_BUSY / 迁移窗口不许被记成「已体检」）；真 0 行才记探测跳过。
      try {
        const newMessages = queryMessagesWindow(adapter, roomId)
        if (newMessages.length === 0) {
          // 无 committed 消息（seq 表未覆盖该房）→ 无法重编，记探测防堵滚动窗口
          state.probedAt[roomId] = probedNowIso
          continue
        }
        const newSeals = querySealsWindow(adapter, roomId)

        const probeLedger = createProbeDecisionLedger(adapter, {
          nowFn: () => new Date().toISOString(),
        })
        const compileFn = createViewfinderCompileFn({
          db: adapter,
          // ProbeDecisionLedger 实现了 compile-fn 用到的全部 5 方法；白名单外方法不存在
          // （默认拒绝）。类型位要 DecisionLedger 类，组合对象过不了名义检查 → 显式 cast。
          ledger: probeLedger as unknown as DecisionLedger,
          judge,
          fencingToken: `monthly-snapshot-probe-${roomId}-${now.getTime()}`,
          leaderTerm: "0",
          judgeTimeoutMs: opts.judgeTimeoutMs,
          judgeConcurrency: opts.judgeConcurrency,
          rootDir: opts.rootDir,
        })
        const artifact = await compileFn({
          roomId,
          prevCheckpoint: null,
          newMessages,
          newSeals,
        })
        snapshots.push({
          roomId,
          currentViewfinder: current,
          recompiledViewfinder: artifact.viewfinderMd,
        })
        state.probedAt[roomId] = probedNowIso
      } catch (err) {
        // 查询/编译失败（SQLITE_BUSY / judge 挂等）→ 不记探测，下次优先重试；
        // fail-soft 不拖垮其他 room
        opts.logger?.warn(
          { roomId, err: (err as Error).message },
          "[monthly-snapshot] probe failed — room will retry next run",
        )
      }
    }

    // 5. 持久化滚动 state（原子写；失败只 warn — 最坏下月重复探，不丢正确性）
    try {
      writeFileAtomic(opts.statePath, `${JSON.stringify(state, null, 2)}\n`)
    } catch (err) {
      opts.logger?.warn(
        { err: (err as Error).message, statePath: opts.statePath },
        "[monthly-snapshot] rolling state write failed (probe results still returned)",
      )
    }

    return snapshots
  }
}

/**
 * 与 force-recompile 同口径：message_commit_seq seq ASC LIMIT 200，cursor=0。
 * 范-r1 P2-1 修：不吞 SQL 异常 —— 查询失败必须抛（caller 不记 probedAt，下次优先重试），
 * 只有真 0 行才允许「无消息记探测跳过」。
 */
function queryMessagesWindow(
  adapter: ReturnType<typeof adaptDrizzleDb>,
  roomId: string,
): MessageCommitRow[] {
  const rows = adapter
    .prepare(
      "SELECT mcs.seq, mcs.message_id, mcs.committed_at, m.role " +
        "FROM message_commit_seq mcs " +
        "JOIN messages m ON m.id = mcs.message_id " +
        "JOIN threads t ON t.id = m.thread_id " +
        "JOIN session_groups sg ON sg.id = t.session_group_id " +
        "WHERE sg.room_id = ? AND mcs.seq > 0 " +
        `ORDER BY mcs.seq ASC LIMIT ${MESSAGE_WINDOW_LIMIT}`,
    )
    .all(roomId) as ReadonlyArray<{
    seq: number
    message_id: string
    committed_at: string
    role: string
  }>
  return rows.map((r) => ({
    seq: r.seq,
    messageId: r.message_id,
    committedAt: r.committed_at,
    role: (r.role === "user" || r.role === "assistant" || r.role === "system" || r.role === "tool"
      ? r.role
      : undefined) as MessageCommitRow["role"],
  }))
}

/**
 * 范-r1 P2-1 修：只容忍「表不存在」（老 schema，compile-fn 允许空 seals）；
 * 其他 SQL 异常照抛（caller 不记 probedAt，下次重试）。
 */
function querySealsWindow(
  adapter: ReturnType<typeof adaptDrizzleDb>,
  roomId: string,
): ThreadSealRow[] {
  try {
    const rows = adapter
      .prepare(
        "SELECT seq, thread_id, room_id, sealed_at, fencing_token " +
          "FROM thread_seal_events WHERE room_id = ? AND seq > 0 " +
          `ORDER BY seq ASC LIMIT ${MESSAGE_WINDOW_LIMIT}`,
      )
      .all(roomId) as ReadonlyArray<{
      seq: number
      thread_id: string
      room_id: string
      sealed_at: string
      fencing_token: string
    }>
    return rows.map((r) => ({
      seq: r.seq,
      threadId: r.thread_id,
      roomId: r.room_id,
      sealedAt: r.sealed_at,
      fencingToken: r.fencing_token,
    }))
  } catch (err) {
    if (/no such table/i.test((err as Error).message)) return []
    throw err
  }
}

// ── backup 回调 ─────────────────────────────────────────────────────────

export interface SnapshotBackupOptions {
  wikiRoot: string
  /** 备份根目录（`.runtime/monthly-snapshot-backups`）。 */
  backupRoot: string
  logger?: FastifyBaseLogger
}

/**
 * backup(label) → 拷全部 rooms/<id>/viewfinder.md 到 `<backupRoot>/<label>/<id>.md`。
 * 全量拷（≤几百个 KB 级文件）而非只拷选中 rooms：MonthlySnapshot 的 backup 回调
 * 发生在 recompileAllRooms 之前，还不知道会 replace 谁 —— 超集保护最简单最稳。
 * 返回备份目录路径（进 SnapshotReport.backupLocation）。
 */
export function createSnapshotBackup(
  opts: SnapshotBackupOptions,
): (label: string) => Promise<string> {
  return async (label: string): Promise<string> => {
    const safeLabel = label.replace(/[^A-Za-z0-9_.-]/g, "_")
    const destDir = path.join(opts.backupRoot, safeLabel)
    fs.mkdirSync(destDir, { recursive: true })
    const roomsDir = path.join(opts.wikiRoot, "rooms")
    let copied = 0
    let entries: string[] = []
    try {
      entries = fs.readdirSync(roomsDir)
    } catch {
      // rooms 目录不存在 = 无可备份；返回空备份目录（MonthlySnapshot 侧仍视为 backup 成功，
      // 因为"无 viewfinder 可备"与"备份失败"语义不同 — 后续 recompile 也必然选不出 room）
      return destDir
    }
    for (const roomId of entries) {
      if (!ROOM_ID_RE.test(roomId)) continue
      const src = path.join(roomsDir, roomId, "viewfinder.md")
      try {
        const content = fs.readFileSync(src, "utf-8")
        writeFileAtomic(path.join(destDir, `${roomId}.md`), content)
        copied += 1
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue // room 没编过
        throw err // 真读写失败必须抛 — MonthlySnapshot fail-safe 会跳过本轮 replace
      }
    }
    opts.logger?.info({ destDir, copied }, "[monthly-snapshot] viewfinder backup complete")
    return destDir
  }
}

// ── replaceViewfinder 回调 ──────────────────────────────────────────────

export interface SnapshotReplacerOptions {
  wikiRoot: string
  /** 可选 wiki_events sink（生产必注入；V16.5 §5 所有 wiki 写留痕）。 */
  wikiEventsSink?: WikiEventsSinkLike | null
  leaderContext: {
    currentLeaderTerm(): string
    newFencingToken(): string
  }
  logger?: FastifyBaseLogger
}

/**
 * replaceViewfinder(roomId, newContent) → 原子写 viewfinder.md + wiki_events 三阶段留痕
 * （appendPending → write → commit；write 失败 abort + rethrow，让 MonthlySnapshot
 * 把该 room 记为 replaceError）。
 *
 * 已知接受窗口：replace 只更新文件，不动 room_checkpoints 的 hash 三件套 ——
 * checkpoint hash 只被 recoverIncomplete 用于 committed_at IS NULL 的行，正常
 * committed 行不回读校验；下次 RoomCompiler tick 增量编译会整体覆盖。
 */
export function createSnapshotViewfinderReplacer(
  opts: SnapshotReplacerOptions,
): (roomId: string, newContent: string) => Promise<void> {
  return async (roomId: string, newContent: string): Promise<void> => {
    if (!ROOM_ID_RE.test(roomId)) {
      throw new Error(`monthly-snapshot replace: invalid roomId ${JSON.stringify(roomId)}`)
    }
    const destPath = path.join(opts.wikiRoot, "rooms", roomId, "viewfinder.md")
    let baseHash: string | null = null
    try {
      baseHash = sha256(fs.readFileSync(destPath, "utf-8"))
    } catch {
      baseHash = null // 被并发删了也照写 — replace 语义就是「以重编结果为准」
    }

    const attemptedHash = sha256(newContent)
    let eventId: number | null = null
    if (opts.wikiEventsSink) {
      const event = opts.wikiEventsSink.appendPending({
        ts: new Date().toISOString(),
        alias: "system-monthly-snapshot",
        action: "write",
        path: `wiki/rooms/${roomId}/viewfinder.md`,
        baseHash,
        attemptedHash,
        sourceMessageIds: null,
        reason: "MonthlySnapshot drift replace (full-recompile probe > threshold)",
        fencingToken: opts.leaderContext.newFencingToken(),
        leaderTerm: opts.leaderContext.currentLeaderTerm(),
      })
      eventId = event.id
    }

    try {
      writeFileAtomic(destPath, newContent)
    } catch (err) {
      if (opts.wikiEventsSink && eventId !== null) {
        try {
          opts.wikiEventsSink.abort(eventId, {
            error: err instanceof Error ? err.message : String(err),
            reason: "atomic_write_failed",
          })
        } catch {
          // abort 失败吞 — 主 throw 优先，reconciler 清残留 pending 行
        }
      }
      throw err
    }

    if (opts.wikiEventsSink && eventId !== null) {
      try {
        opts.wikiEventsSink.commit(eventId, { contentHash: attemptedHash })
      } catch (err) {
        // 文件已落盘 — audit commit fail-soft（同 RoomCompiler 语义），留 pending 行给 reconciler
        opts.logger?.warn(
          { roomId, err: (err as Error).message },
          "[monthly-snapshot] wiki_events commit failed after replace (file written; pending row left)",
        )
      }
    }
    opts.logger?.info({ roomId }, "[monthly-snapshot] viewfinder replaced (drift > threshold)")
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}
