/**
 * F027 P7 · shouldCompile 触发判定
 * 真相源：docs/plans/V16.5-final.md chap 8 行 902-908
 *
 *   userCount >= 8        → 触发（user 消息累积阈值）
 *   idleMs > 30 * 60_000  → 触发（最后一次 compile 后空闲超时）
 *   newSeals.length > 0   → 触发（独立 seal cursor，"sealed 但无 message" 也走）
 *   首次（checkpoint==null）+ 任何新 message → first_compile
 */

import type { CompileTriggerDecision, CompileTriggerInput, CompileTriggerReason } from "./types"

export const DEFAULT_USER_COUNT_THRESHOLD = 8
export const DEFAULT_IDLE_MS = 30 * 60 * 1000

export function shouldCompile(input: CompileTriggerInput): CompileTriggerDecision {
  const userThreshold = input.config?.userCountThreshold ?? DEFAULT_USER_COUNT_THRESHOLD
  const idleThreshold = input.config?.idleMs ?? DEFAULT_IDLE_MS

  const userCount = input.newMessages.filter((m) => m.role === "user").length
  const sealCount = input.newSeals.length

  let idleMs: number | null = null
  if (input.checkpoint?.compiledAt) {
    idleMs = input.now - Date.parse(input.checkpoint.compiledAt)
  }

  const reasons: CompileTriggerReason[] = []
  // 首次 + 有新 message → first_compile（chap 8 隐含：从未 compile 也要起点）
  if (!input.checkpoint && input.newMessages.length > 0) {
    reasons.push("first_compile")
  }
  if (userCount >= userThreshold) reasons.push("user_count_reached")
  if (idleMs !== null && idleMs > idleThreshold) reasons.push("idle_timeout")
  if (sealCount > 0) reasons.push("new_seal")

  return {
    shouldCompile: reasons.length > 0,
    reasons,
    details: { userCount, idleMs, sealCount },
  }
}
