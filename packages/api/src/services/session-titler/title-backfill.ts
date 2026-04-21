import type { FastifyBaseLogger } from "fastify"
import { isDefaultTitle } from "./default-title"

export interface BackfillRepo {
  listSessionGroups(): Array<{ id: string; title: string | null }>
}

export interface BackfillTitler {
  runNow(sessionGroupId: string): Promise<void>
}

export interface BackfillOptions {
  logger?: FastifyBaseLogger
  /** Inter-run delay for rate limiting; default 1000ms. */
  delayMs?: number
  /** Inject for tests. */
  sleep?: (ms: number) => Promise<void>
}

export interface BackfillResult {
  scanned: number
  attempted: number
}

/**
 * AC-14b: scan historical sessions with null/default titles and feed them
 * to the titler one at a time, with a fixed delay between runs to avoid
 * bursting Haiku rate limits. Idempotent — titler.runNow() itself skips
 * already-named rows (AC-10).
 */
export async function backfillHistoricalTitles(
  repo: BackfillRepo,
  titler: BackfillTitler,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const delayMs = options.delayMs ?? 1000
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()))
  const groups = repo.listSessionGroups()
  const pending = groups.filter((g) => !g.title || isDefaultTitle(g.title))
  options.logger?.info(
    { event: "backfill.start", scanned: groups.length, pending: pending.length },
    "historical title backfill start",
  )
  for (let i = 0; i < pending.length; i++) {
    try {
      await titler.runNow(pending[i].id)
    } catch (err) {
      options.logger?.error(
        { event: "backfill.error", sessionGroupId: pending[i].id, error: String(err) },
        "historical title backfill row error",
      )
    }
    if (i < pending.length - 1) await sleep(delayMs)
  }
  options.logger?.info(
    { event: "backfill.done", attempted: pending.length },
    "historical title backfill done",
  )
  return { scanned: groups.length, attempted: pending.length }
}
