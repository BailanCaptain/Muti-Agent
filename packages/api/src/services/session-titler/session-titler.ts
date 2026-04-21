import type { FastifyBaseLogger } from "fastify"
import type { RealtimeServerEvent } from "@multi-agent/shared"
import type { HaikuRunner } from "../../runtime/haiku-runner"
import { isDefaultTitle } from "./default-title"

/** Max chars of the description part after the type prefix (product decision 2026-04-20). */
const DESC_MAX_CHARS = 8
const DEFAULT_DEBOUNCE_MS = 2500
// Windows 上 `claude --print` 冷启动实测 ~18s / 热启动 ~8-9s（F022 验收时测量，2026-04-20）。
// 原本 5s 几乎必超时 → 每次都 fallback 成 `D-新会话 ${date}`，AC-14f 从未真正生效。
// 20s 留余量给冷启，同时仍远低于用户可感知的"命名没来"窗口。
const DEFAULT_TIMEOUT_MS = 20000

/**
 * AC-14d + AC-14e: normalize Haiku output to one of:
 *   - `F{编号}-{desc}` / `B{编号}-{desc}` — filed feature / bug (编号原样保留)
 *   - `D-{desc}` / `Q-{desc}` — discussion / question
 * Unfiled bare `F-` / `B-` (no digit id) are demoted to `D-` per product rule:
 *   "F/B 前缀必须对应立项号，没立项就归讨论"。
 * Description is truncated to DESC_MAX_CHARS so filed titles like `F022-xxx` keep
 * their id intact instead of being chopped at 10 chars.
 */
function enforceTitlePrefix(raw: string): string {
  const trimmed = raw.trim()

  const filed = /^([FfBb])(\d+)-(.*)$/.exec(trimmed)
  if (filed) {
    const letter = filed[1].toUpperCase()
    return `${letter}${filed[2]}-${filed[3].slice(0, DESC_MAX_CHARS)}`
  }

  const unfiledFB = /^[FfBb]-(.*)$/.exec(trimmed)
  if (unfiledFB) {
    return `D-${unfiledFB[1].slice(0, DESC_MAX_CHARS)}`
  }

  const discussion = /^([DdQq])-(.*)$/.exec(trimmed)
  if (discussion) {
    return `${discussion[1].toUpperCase()}-${discussion[2].slice(0, DESC_MAX_CHARS)}`
  }

  return `D-${trimmed.slice(0, DESC_MAX_CHARS)}`
}

export interface SessionTitlerRepo {
  getSessionGroupById(
    id: string,
  ):
    | { id: string; roomId: string | null; title: string; titleLockedAt?: string | null }
    | undefined
  updateSessionGroupTitle(id: string, title: string): void
  // F022 Phase 3.5 (review P1-2): Haiku 失败计数。
  // success → reset 0；fallback → +1；backfill 过 MAX 跳过。
  incrementTitleBackfillAttempts(id: string): void
  resetTitleBackfillAttempts(id: string): void
}

export interface SessionTitlerDeps {
  repo: SessionTitlerRepo
  haiku: HaikuRunner
  logger: FastifyBaseLogger
  /** Build the Haiku prompt from a session group's recent messages. */
  buildPrompt: (sessionGroupId: string) => string
  /** Default: 2500ms. */
  debounceMs?: number
  /** Haiku timeout; default 5000ms. */
  timeoutMs?: number
  /** Date formatter for fallback title; default `new Date().toISOString().slice(0,10)`. */
  dateFormatter?: () => string
  /** AC-14k: push `session.title_updated` so the sidebar refreshes without F5. */
  emit?: (event: RealtimeServerEvent) => void
}

/**
 * Per-sessionGroupId debounced auto-titler.
 *
 * - `schedule(id)` is fire-and-forget (AC-09). Repeated calls within `debounceMs`
 *   collapse into a single Haiku invocation (AC-05).
 * - Before calling Haiku, re-reads `title` and skips if it's not a default
 *   pattern (AC-10 idempotency via `isDefaultTitle`).
 * - Success → writes Haiku output truncated to {MAX_TITLE_CHARS} chars (AC-06/07).
 * - Failure → writes `新会话 {date}` fallback (AC-08).
 * - Emits structured log events: schedule | haiku.call | success | fallback | skip.idempotent | error.
 */
export class SessionTitler {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly pending: Promise<void>[] = []

  constructor(private readonly deps: SessionTitlerDeps) {}

  schedule(sessionGroupId: string): void {
    const log = this.deps.logger
    const existing = this.timers.get(sessionGroupId)
    if (existing) clearTimeout(existing)
    log.info({ event: "schedule", sessionGroupId }, "session-titler scheduled")
    const timer = setTimeout(() => {
      this.timers.delete(sessionGroupId)
      const p = this.run(sessionGroupId).catch((err: unknown) => {
        log.error(
          { event: "error", sessionGroupId, error: String(err) },
          "session-titler unexpected error",
        )
      })
      this.pending.push(p)
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    // Don't block process exit just because a titler timer is pending.
    timer.unref?.()
    this.timers.set(sessionGroupId, timer)
  }

  /**
   * AC-14b: run the titler synchronously for one sessionGroup (no debounce).
   * Used by the historical-title backfill orchestrator to control pacing / rate-limit.
   * Idempotent: skips when the current title is not a default pattern (same as schedule()).
   */
  async runNow(sessionGroupId: string): Promise<void> {
    await this.run(sessionGroupId)
  }

  /** Test-only hook: wait for all scheduled runs to finish. */
  async flushPending(): Promise<void> {
    // Wait for any timers to fire (max debounce interval + small slack).
    const maxWait = (this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS) + 20
    const start = Date.now()
    while (this.timers.size > 0 && Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 5))
    }
    while (this.pending.length > 0) {
      const [p] = this.pending.splice(0, 1)
      await p
    }
  }

  private async run(sessionGroupId: string): Promise<void> {
    const { repo, haiku, logger, buildPrompt, timeoutMs, dateFormatter, emit } = this.deps
    const row = repo.getSessionGroupById(sessionGroupId)
    if (!row) return
    const roomId = row.roomId
    // F022 Phase 3.5 (AC-14g): 手动重命名锁 — 用户改过名的不允许 Haiku 覆盖
    if (row.titleLockedAt) {
      logger.info(
        { event: "skip.locked", sessionGroupId, roomId, titleLockedAt: row.titleLockedAt },
        "session-titler skipped (title locked by user rename)",
      )
      return
    }
    if (!isDefaultTitle(row.title)) {
      logger.info(
        { event: "skip.idempotent", sessionGroupId, roomId, currentTitle: row.title },
        "session-titler skipped (already titled)",
      )
      return
    }

    const prompt = buildPrompt(sessionGroupId)
    logger.info({ event: "haiku.call", sessionGroupId, roomId }, "session-titler calling haiku")
    const result = await haiku.runPrompt(prompt, { timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS })

    if (result.ok) {
      const title = enforceTitlePrefix(result.text)
      repo.updateSessionGroupTitle(sessionGroupId, title)
      // P1-2: 成功命名 → 清零失败计数（未来如果 title 又被擦成默认也允许重扫）
      repo.resetTitleBackfillAttempts(sessionGroupId)
      emit?.({
        type: "session.title_updated",
        payload: { sessionGroupId, title, titleLockedAt: null },
      })
      logger.info(
        {
          event: "success",
          sessionGroupId,
          roomId,
          titleGenerated: title,
          durationMs: result.durationMs,
        },
        "session-titler success",
      )
      return
    }

    const fallback = `D-新会话 ${(dateFormatter ?? defaultDateFormatter)()}`
    repo.updateSessionGroupTitle(sessionGroupId, fallback)
    // P1-2: 失败 fallback 写的是 isDefaultTitle 识别为默认的格式 —
    // 不累加就会被下次重启再次扫入 backfill 队列 → Haiku 挂时永久风暴。
    repo.incrementTitleBackfillAttempts(sessionGroupId)
    emit?.({
      type: "session.title_updated",
      payload: { sessionGroupId, title: fallback, titleLockedAt: null },
    })
    logger.warn(
      {
        event: "fallback",
        sessionGroupId,
        roomId,
        error: result.error,
        durationMs: result.durationMs,
        titleGenerated: fallback,
      },
      "session-titler fallback to date format",
    )
  }
}

function defaultDateFormatter(): string {
  return new Date().toISOString().slice(0, 10)
}
