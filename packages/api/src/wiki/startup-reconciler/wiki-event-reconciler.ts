/**
 * F027 P7.5 · wiki_events 'pending' 行的 verdict 决策 + state transition
 * 真相源：docs/plans/V16.5-final.md chap 5 行 506-517
 *
 * 决策表（chap 5 行 510-516）：
 *   file_hash == attemptedHash    → committed_via_attempted（commit）
 *   file_hash == baseHash         → aborted_clean        （abort, reason='clean_rollback'）
 *   file_hash 不在两者中           → aborted_dirty        （abort, reason='aborted_dirty', alert）
 *
 * 边界：
 *   - file ENOENT → fileHash = null。null == baseHash null 时也走 aborted_clean
 *     （新建文件未生效）；null != baseHash "X" 时走 aborted_dirty（base 文件意外消失）
 *   - attemptedHash 类型上 non-null（AppendPendingInput.attemptedHash 必填），
 *     但实际 row 字段 nullable —— 防御 null 时 fileHash != attempted（除非两者都 null）
 *   - state 必须真是 'pending'（外层 caller 已 filter，但 settle CAS 失败仍处理）
 */

import { createHash } from "node:crypto"
import { promises as fsAsync } from "node:fs"
import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import type { WikiEvent } from "../../db/repositories/wiki-events-types"
import { WikiPathInvalidError, safeWikiPath } from "../path-containment"
import type {
  WikiEventReconcileDetail,
  WikiEventReconcileSummary,
  WikiEventReconcileVerdict,
} from "./types"

export interface WikiEventReconcilerDeps {
  repo: WikiEventsRepository
  /** wiki 根目录（与 RoomCompiler.wikiRoot 同源）。event.path 是相对此根的路径。 */
  wikiRoot: string
  logger?: (msg: string) => void
}

export async function reconcileWikiEvents(
  deps: WikiEventReconcilerDeps,
): Promise<WikiEventReconcileSummary> {
  const pending = deps.repo.getPending()
  const summary: WikiEventReconcileSummary = {
    scanned: pending.length,
    committed: 0,
    abortedClean: 0,
    abortedDirty: 0,
    noopRaceSettled: 0,
    details: [],
  }
  for (const ev of pending) {
    const detail = await reconcileOne(ev, deps)
    summary.details.push(detail)
    switch (detail.verdict) {
      case "committed_via_attempted":
        summary.committed++
        break
      case "aborted_clean":
        summary.abortedClean++
        break
      case "aborted_dirty":
        summary.abortedDirty++
        deps.logger?.(
          `[startup-reconciler] DIRTY: event=${ev.id} path=${ev.path} ` +
            `attempted=${ev.attemptedHash ?? "null"} base=${ev.baseHash ?? "null"} ` +
            `actual=${detail.fileHash ?? "null"} — manual investigation required (V16.5 chap 5)`,
        )
        break
      case "noop_race_settled":
        summary.noopRaceSettled++
        break
    }
  }
  return summary
}

async function reconcileOne(
  ev: WikiEvent,
  deps: WikiEventReconcilerDeps,
): Promise<WikiEventReconcileDetail> {
  // 范-r1 P1-2 修：path containment —— event.path 来自 DB（PREPARE 输入），
  // 不能盲信。复用 safeWikiPath 校验：必须 'wiki/' 前缀 + normalize 后仍在 wiki/
  // namespace 内 + resolve 不逃 wikiRoot/wiki/。失败按 aborted_dirty settle。
  let absPath: string
  try {
    absPath = safeWikiPath(deps.wikiRoot, ev.path)
  } catch (err) {
    if (err instanceof WikiPathInvalidError) {
      const ok = deps.repo.abort(ev.id, {
        reason: "aborted_dirty",
        error: `path containment violation: ${err.message}`,
      })
      const verdict: WikiEventReconcileVerdict = ok ? "aborted_dirty" : "noop_race_settled"
      deps.logger?.(
        `[startup-reconciler] DIRTY (path-containment): event=${ev.id} path=${ev.path} — ${err.message}`,
      )
      return {
        eventId: ev.id,
        path: ev.path,
        action: ev.action,
        alias: ev.alias,
        verdict,
        fileHash: null,
        attemptedHash: ev.attemptedHash,
        baseHash: ev.baseHash,
      }
    }
    throw err
  }

  const fileHash = await computeFileHashOrNull(absPath)
  const verdict = decideVerdict(ev, fileHash)

  // settle DB（CAS WHERE state='pending'；race 时 false → noop）
  let actualVerdict: WikiEventReconcileVerdict = verdict
  switch (verdict) {
    case "committed_via_attempted": {
      // ev.attemptedHash 非 null 由 decideVerdict 保证（else 这 branch 不会触发）
      const ok = deps.repo.commit(ev.id, { contentHash: ev.attemptedHash as string })
      if (!ok) actualVerdict = "noop_race_settled"
      break
    }
    case "aborted_clean": {
      const ok = deps.repo.abort(ev.id, { reason: "clean_rollback" })
      if (!ok) actualVerdict = "noop_race_settled"
      break
    }
    case "aborted_dirty": {
      const ok = deps.repo.abort(ev.id, {
        reason: "aborted_dirty",
        error:
          `third-party pollution: file_hash=${fileHash ?? "null"} ` +
          `attempted=${ev.attemptedHash ?? "null"} base=${ev.baseHash ?? "null"}`,
      })
      if (!ok) actualVerdict = "noop_race_settled"
      break
    }
  }
  return {
    eventId: ev.id,
    path: ev.path,
    action: ev.action,
    alias: ev.alias,
    verdict: actualVerdict,
    fileHash,
    attemptedHash: ev.attemptedHash,
    baseHash: ev.baseHash,
  }
}

/**
 * Pure decision: 给 ev 和当前文件 hash → 决定 verdict（不依赖 IO/DB）。
 * 单独 export 方便测试。
 */
export function decideVerdict(
  ev: Pick<WikiEvent, "attemptedHash" | "baseHash">,
  fileHash: string | null,
): Exclude<WikiEventReconcileVerdict, "noop_race_settled"> {
  // 优先级：attempted match > base match > dirty
  // 边界：attemptedHash null 时 fileHash 不可能 "match" 它（除非 fileHash 也 null，
  //   但 attempted null = writer 没准备好 hash 就崩了，treat as base 比较）
  if (ev.attemptedHash !== null && fileHash === ev.attemptedHash) {
    return "committed_via_attempted"
  }
  if (fileHash === ev.baseHash) {
    return "aborted_clean"
  }
  return "aborted_dirty"
}

async function computeFileHashOrNull(absPath: string): Promise<string | null> {
  try {
    const buf = await fsAsync.readFile(absPath)
    return createHash("sha256").update(buf).digest("hex")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}
