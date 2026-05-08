/**
 * F026 Phase 2 · planWorklistAdvance (I2-b)
 *
 * Pure decision layer for the worklist executor. Given the current worklist
 * snapshot and the result of the just-completed child invocation, decide
 * whether the executor should advance to the next worklist item, settle the
 * whole worklist as done, or halt (child failed / empty / bounds).
 *
 * This is the mechanism that replaces F003's return-path "new-invocation"
 * behaviour: instead of synthesising a fresh invocation back into the parent
 * with a wrapper prompt, the executor stays on the same `routeSerial` and
 * picks the next item — so a single turn cannot produce two DB message rows
 * (R-184 root fix, I2-a).
 *
 * The function is pure: no side effects, no I/O, no mutation of the input.
 */

export type WorklistItemStatus = "pending" | "running" | "done" | "failed"

export type WorklistItem = {
  /** Optional — populated only after the executor wires an invocation to this item.
   *  At register time the worklist is created with items containing only alias + status. */
  invocationId?: string
  alias: string
  status: WorklistItemStatus
}

export type WorklistAdvanceInput = {
  /** Same `routeSerial` shared by every item in this worklist. */
  routeSerial: string
  /** Ordered worklist snapshot at the moment of the completion. */
  items: WorklistItem[]
  /** Index of the item that just finished (`childResult` describes its outcome). */
  completedIndex: number
  /** Outcome of the child invocation at `completedIndex`. */
  childResult: {
    ok: boolean
    content: string
  }
}

export type WorklistAdvanceResult =
  | { kind: "advance"; nextIndex: number; nextItem: WorklistItem }
  | { kind: "done"; finalIndex: number }
  | { kind: "halt"; reason: WorklistHaltReason }

export type WorklistHaltReason = "child-failed" | "empty-content" | "index-oob"

export function planWorklistAdvance(input: WorklistAdvanceInput): WorklistAdvanceResult {
  const { items, completedIndex, childResult } = input

  // Defensive bounds check — guards against corrupt state / off-by-one callers.
  if (items.length === 0 || completedIndex < 0 || completedIndex >= items.length) {
    return { kind: "halt", reason: "index-oob" }
  }

  if (!childResult.ok) {
    return { kind: "halt", reason: "child-failed" }
  }

  if (childResult.content.trim().length === 0) {
    return { kind: "halt", reason: "empty-content" }
  }

  const nextIndex = completedIndex + 1
  if (nextIndex >= items.length) {
    return { kind: "done", finalIndex: completedIndex }
  }

  return { kind: "advance", nextIndex, nextItem: items[nextIndex]! }
}
