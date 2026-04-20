import type { FastifyBaseLogger } from "fastify"
import type { HaikuRunner } from "../../runtime/haiku-runner"
import { isDefaultTitle } from "./default-title"

/** Max chars of the auto-generated title (product decision 2026-04-20, down from 20). */
const MAX_TITLE_CHARS = 10
const DEFAULT_DEBOUNCE_MS = 2500
const DEFAULT_TIMEOUT_MS = 5000

export interface SessionTitlerRepo {
  getSessionGroupById(id: string): { id: string; roomId: string | null; title: string } | undefined
  updateSessionGroupTitle(id: string, title: string): void
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
    const { repo, haiku, logger, buildPrompt, timeoutMs, dateFormatter } = this.deps
    const row = repo.getSessionGroupById(sessionGroupId)
    if (!row) return
    const roomId = row.roomId
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
      const title = result.text.slice(0, MAX_TITLE_CHARS)
      repo.updateSessionGroupTitle(sessionGroupId, title)
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

    const fallback = `新会话 ${(dateFormatter ?? defaultDateFormatter)()}`
    repo.updateSessionGroupTitle(sessionGroupId, fallback)
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
