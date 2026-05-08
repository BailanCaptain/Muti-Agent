/**
 * F026 P0 场景1 后续 · review P1-2 修复
 *
 * 把排队 flush 决策从 composer 的 useEffect 抽出来成一个纯函数，解决两个 bug：
 *   (1) latch 从"全局 boolean ref"升级为"per-group Set"，切房不串锁。
 *   (2) sendMessage 被拒时（buildSendPayload validation fail 等），
 *       `resolveLatchAfterSend` 立刻删除该 group 的 latch，避免 latch 永不清
 *       (老代码只在 `isTurnLive` 转 true 时清 → rejected 不会触发，latch 卡死)。
 *
 * 两个函数都是 side-effect free，方便单测。
 */

export type QueuedMessage = { id: string; text: string }

export type QueueFlushDecision =
  | { kind: "flush"; message: QueuedMessage }
  | { kind: "skip"; reason: "empty" | "no-group" | "busy" | "awaiting-latch" }

export interface QueueFlushInput {
  activeGroupId: string | null
  isTurnLive: boolean
  awaitingLatch: ReadonlySet<string>
  bucket: readonly QueuedMessage[]
}

export function planQueueFlush(input: QueueFlushInput): QueueFlushDecision {
  if (!input.activeGroupId) return { kind: "skip", reason: "no-group" }
  if (input.bucket.length === 0) return { kind: "skip", reason: "empty" }
  if (input.isTurnLive) return { kind: "skip", reason: "busy" }
  if (input.awaitingLatch.has(input.activeGroupId)) return { kind: "skip", reason: "awaiting-latch" }
  return { kind: "flush", message: input.bucket[0]! }
}

export type SendResult = { accepted: true } | { accepted: false; reason: string }

export function resolveLatchAfterSend(
  latch: ReadonlySet<string>,
  groupId: string,
  result: SendResult,
): Set<string> {
  if (result.accepted) return new Set(latch)
  const next = new Set(latch)
  next.delete(groupId)
  return next
}
