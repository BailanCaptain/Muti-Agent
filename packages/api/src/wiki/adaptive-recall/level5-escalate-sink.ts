/**
 * F027 P13.4 · Level 5 escalate sinks
 *
 * P13 模块边界（设计选择）：escalate 不绑定具体 audit 后端。
 *   - NoopLevel5Sink: 测试 / 极简集成用，just resolves
 *   - ConsoleWarnLevel5Sink: 开发环境，console.warn 打信息
 *   - ProductionLevel5Sink (F027 Phase 3 P20 Day 9 c, AC-P3-9 c):
 *     写 wiki_events action='recall_escalate' (PREPARE+COMMIT 两步) +
 *     可选 broadcaster 推 realtime audit notification
 *
 * 默认推荐：
 *   - 开发 / 测试 → NoopLevel5Sink
 *   - dev preview → ConsoleWarnLevel5Sink（看到 escalate 信号）
 *   - 生产 → ProductionLevel5Sink (server.ts boot wire wikiEventsRepo + leaderContext)
 */

import { createHash } from "node:crypto"
import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import type { EscalateInfo, Level5Sink } from "./types"

export class NoopLevel5Sink implements Level5Sink {
  async escalate(_info: EscalateInfo): Promise<void> {
    // intentional no-op
  }
}

export class ConsoleWarnLevel5Sink implements Level5Sink {
  constructor(
    private readonly log: (msg: string, info: EscalateInfo) => void = defaultConsoleWarn,
  ) {}

  async escalate(info: EscalateInfo): Promise<void> {
    this.log(
      `[F027-P13] recall escalated to user — room=${info.roomId} alias=${info.alias} ` +
        `trigger=${info.trigger} visited=[${info.visitedLevels.join(",")}] reason=${info.reason}`,
      info,
    )
  }
}

function defaultConsoleWarn(msg: string, _info: EscalateInfo): void {
  // eslint-disable-next-line no-console
  console.warn(msg)
}

/**
 * 测试 sink：记录所有 escalate 调用，用于 assertion。
 */
export class RecordingLevel5Sink implements Level5Sink {
  public readonly calls: EscalateInfo[] = []

  async escalate(info: EscalateInfo): Promise<void> {
    this.calls.push(info)
  }
}

// ─── F027 Phase 3 P20 Day 9 c · ProductionLevel5Sink (AC-P3-9 c) ─────

/**
 * Leader context provider — escalate 写 wiki_events 需要 fencingToken + leaderTerm。
 *
 * Day 9 c：server.ts boot 注入简单 provider（const term=1 + UUID fencing）。
 * Phase 4：接 Compiler Leader Lease (compiler-leader-repository) 拿真 leader 信息。
 */
export interface LeaderContextProvider {
  /** 当前 leader_term（单调推进 bigint as decimal string）。 */
  currentLeaderTerm(): string
  /** 派一个新 fencing token（uuid 或单调序列）。 */
  newFencingToken(): string
}

/**
 * Audit broadcaster — escalate 时推一个 realtime event 让 Inspector UI 拿到。
 *
 * Day 9 c：可选注入；不传 = 仅写 DB，不推 realtime。
 * Phase 4：接 realtime broadcaster 推 audit 事件类型 `recall.escalated`。
 */
export interface AuditBroadcaster {
  broadcast(event: {
    type: "recall.escalated"
    payload: {
      roomId: string
      alias: string
      trigger: string
      visitedLevels: ReadonlyArray<number>
      reason: string
      totalMs: number
      critiqueCalls: number
      wikiEventId: number
      eventPath: string
      ts: string
    }
  }): void
}

/** Minimal logger 接口（warn 用）。 */
export interface MinimalLogger {
  warn(obj: unknown, msg?: string): void
}

export interface ProductionLevel5SinkDeps {
  wikiEventsRepo: WikiEventsRepository
  leaderContext: LeaderContextProvider
  /** Audit broadcaster（可选；不传 = 仅写 DB）。 */
  broadcaster?: AuditBroadcaster
  /** Logger（fail-soft 路径 warn 用；不传 = console.warn）。 */
  logger?: MinimalLogger
  /** 注入 clock（测试用；默认 () => new Date()）。 */
  clock?: () => Date
}

/**
 * 生产 Level 5 escalate sink。
 *
 * 行为（plan v3.1 §3 Day 9 c）：
 *   1. PREPARE: appendPending {action:'recall_escalate', path='audit/recall/<roomId>/<ts>',
 *      alias=info.alias, attemptedHash=sha256(reason), fencingToken, leaderTerm,
 *      sourceMessageIds=null, reason=info.reason}
 *   2. COMMIT: 立即 commit(eventId, {contentHash=attemptedHash})
 *      —— recall_escalate 不写文件，event row 即终态（write/promote 类才需要 reconciler 扫）
 *   3. 推 broadcaster?.broadcast({type:'recall.escalated', payload:{...}}) 让 Inspector UI 接
 *
 * Fail-soft 策略：
 *   - DB 写失败 → log warn 不抛（P13 executor 上游不应因 audit 失败 retry）
 *   - broadcaster 抛 → log warn 不抛（DB 已落 row 仍可被 Inspector pull）
 */
export class ProductionLevel5Sink implements Level5Sink {
  private readonly wikiEventsRepo: WikiEventsRepository
  private readonly leaderContext: LeaderContextProvider
  private readonly broadcaster?: AuditBroadcaster
  private readonly logger: MinimalLogger
  private readonly clock: () => Date

  constructor(deps: ProductionLevel5SinkDeps) {
    this.wikiEventsRepo = deps.wikiEventsRepo
    this.leaderContext = deps.leaderContext
    this.broadcaster = deps.broadcaster
    this.logger = deps.logger ?? { warn: (obj, msg) => console.warn(msg, obj) }
    this.clock = deps.clock ?? (() => new Date())
  }

  async escalate(info: EscalateInfo): Promise<void> {
    const ts = this.clock().toISOString()
    const path = `audit/recall/${info.roomId}/${ts}`
    const reasonHash = sha256(info.reason)

    let eventId = 0
    try {
      const event = this.wikiEventsRepo.appendPending({
        ts,
        alias: info.alias,
        action: "recall_escalate",
        path,
        baseHash: null,
        attemptedHash: reasonHash,
        diffSummary: buildDiffSummary(info),
        sourceMessageIds: null,
        reason: info.reason,
        fencingToken: this.leaderContext.newFencingToken(),
        leaderTerm: this.leaderContext.currentLeaderTerm(),
        result: "ok",
      })
      eventId = event.id

      const committed = this.wikiEventsRepo.commit(eventId, {
        contentHash: reasonHash,
      })
      if (!committed) {
        // 罕见 race：row 已被并行 abort（不会发生在 escalate 路径，但防御）
        this.logger.warn(
          { stage: "level5_sink.commit_noop", eventId, info },
          "ProductionLevel5Sink.commit returned false (row not pending?)",
        )
      }
    } catch (err) {
      this.logger.warn(
        {
          stage: "level5_sink.write_failed",
          err: { name: (err as Error).name, message: (err as Error).message },
          info,
        },
        "ProductionLevel5Sink: wiki_events write failed (fail-soft)",
      )
      return
    }

    if (!this.broadcaster) return
    try {
      this.broadcaster.broadcast({
        type: "recall.escalated",
        payload: {
          roomId: info.roomId,
          alias: info.alias,
          trigger: info.trigger,
          visitedLevels: info.visitedLevels,
          reason: info.reason,
          totalMs: info.totalMs,
          critiqueCalls: info.critiqueCalls,
          wikiEventId: eventId,
          eventPath: path,
          ts,
        },
      })
    } catch (err) {
      this.logger.warn(
        {
          stage: "level5_sink.broadcast_failed",
          err: { name: (err as Error).name, message: (err as Error).message },
          eventId,
        },
        "ProductionLevel5Sink: broadcaster failed (DB row already persisted)",
      )
    }
  }
}

/**
 * 简易 LeaderContextProvider（Day 9 c boot 注入）：固定 leaderTerm + 每次 UUID fencing。
 *
 * Phase 4：接 compiler-leader-repository 真 leader lease 时替换。
 */
export function createSimpleLeaderContext(
  opts: {
    leaderTerm?: string
    newFencingToken?: () => string
  } = {},
): LeaderContextProvider {
  const term = opts.leaderTerm ?? "1"
  const tokenFn =
    opts.newFencingToken ??
    (() => createHash("sha1").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16))
  return {
    currentLeaderTerm: () => term,
    newFencingToken: tokenFn,
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

function buildDiffSummary(info: EscalateInfo): string {
  return `recall_escalate trigger=${info.trigger} visited=[${info.visitedLevels.join(",")}] reason=${info.reason} totalMs=${info.totalMs} critiqueCalls=${info.critiqueCalls}`
}
