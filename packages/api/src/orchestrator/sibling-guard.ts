import type { CallRegistry } from "./call-registry"
import type { WorklistRegistry } from "./worklist-registry"

/**
 * F026 P3 · sibling-guard
 *
 * 协议口径：A 派 [Call:@B][Call:@C] 后，B/C 各自闭环不得互相派发。
 * dispatch 决策层硬卡（不依赖 agent 自律），命中即 blocked。
 *
 * 判定路径（不依赖 a2a_calls.callee 字段）：
 *   1. caller 自己处理的 callId → 反查 caller 的 parentCallId
 *   2. parentCallId 为 null（user-root 直派）→ 不在任何 fan-out 内 → false
 *   3. 用 worklistRegistry.findActiveByParentCallId(parentCallId) 取
 *      caller 所在的 sibling 集合（即 parent 当时派出的所有 fan-out targets）
 *   4. target ∈ sibling 集合 且 ≠ caller 自己 → sibling 互调 → true
 *
 * 反向接力（child→parent）不在此 guard 范围 —— parent alias 不在 sibling 集合里。
 */

export interface SiblingGuardDeps {
  callRegistry: Pick<CallRegistry, "get">
  worklistRegistry: Pick<WorklistRegistry, "findActiveByParentCallId">
}

export interface SiblingGuardInput {
  /** caller 自己处理的 call_id（即将创建的新 child call 的 parent_call_id） */
  callerCallId: string
  /** caller 自己的 alias —— 用于排除"自派"误报 */
  callerAlias: string
  /** 即将派发的目标 alias */
  targetAlias: string
}

export function isSiblingCrossCall(
  deps: SiblingGuardDeps,
  input: SiblingGuardInput,
): boolean {
  const callerCall = deps.callRegistry.get(input.callerCallId)
  if (!callerCall) return false
  if (!callerCall.parentCallId) return false

  const parentWorklist = deps.worklistRegistry.findActiveByParentCallId(callerCall.parentCallId)
  if (!parentWorklist) return false

  return parentWorklist.items.some(
    (it) => it.alias === input.targetAlias && it.alias !== input.callerAlias,
  )
}
