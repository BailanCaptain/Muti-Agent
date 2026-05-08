import type {
  DispatchValidationRetryPayload,
  DispatchValidationRetryReason,
  DispatchValidationRetryStatus,
  RealtimeServerEvent,
} from "@multi-agent/shared"

/**
 * F026 P3.1 · 派发协议 retry 事件 helpers
 *
 * 单一定义点：
 *   - DB 行 eventType 列写 "dispatch_validation_retry" 字面量
 *   - WS event 走 RealtimeServerEvent 联合类型 "dispatch.validation_retry"
 *   - payload schema 验证统一在此模块（轻量 type guard，避免引入 zod 依赖）
 *
 * message-service 在 final 入库前调用：
 *   db.appendAgentEvent(buildDispatchRetryAgentEventRow(payload, { id: nanoid() }))
 *   broadcaster.broadcast(buildDispatchRetryRealtimeEvent(payload))
 */

export const DISPATCH_VALIDATION_RETRY_EVENT_TYPE = "dispatch_validation_retry" as const

const VALID_REASONS: ReadonlySet<DispatchValidationRetryReason> = new Set([
  "nested_call_tag",
  "naked_at_with_real_teammate",
])

const VALID_STATUSES: ReadonlySet<DispatchValidationRetryStatus> = new Set([
  "retrying",
  "settled",
  "exhausted",
])

const REQUIRED_KEYS = [
  "sessionGroupId",
  "threadId",
  "invocationId",
  "agentId",
  "messageId",
  "attemptIndex",
  "maxAttempts",
  "reason",
  "originalText",
  "status",
  "occurredAt",
] as const

function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1
}

export function isDispatchValidationRetryPayload(
  value: unknown,
): value is DispatchValidationRetryPayload {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) return false
  }
  if (typeof obj.sessionGroupId !== "string") return false
  if (typeof obj.threadId !== "string") return false
  if (typeof obj.invocationId !== "string") return false
  if (typeof obj.agentId !== "string") return false
  if (typeof obj.messageId !== "string") return false
  if (!isPositiveInteger(obj.attemptIndex)) return false
  if (!isPositiveInteger(obj.maxAttempts)) return false
  if (
    typeof obj.reason !== "string" ||
    !VALID_REASONS.has(obj.reason as DispatchValidationRetryReason)
  ) {
    return false
  }
  if (typeof obj.originalText !== "string") return false
  if (
    typeof obj.status !== "string" ||
    !VALID_STATUSES.has(obj.status as DispatchValidationRetryStatus)
  ) {
    return false
  }
  if (typeof obj.occurredAt !== "string") return false
  if (
    "finalContent" in obj &&
    obj.finalContent !== undefined &&
    typeof obj.finalContent !== "string"
  ) {
    return false
  }
  if ("retryCount" in obj && obj.retryCount !== undefined) {
    if (
      typeof obj.retryCount !== "number" ||
      !Number.isInteger(obj.retryCount) ||
      obj.retryCount < 0
    ) {
      return false
    }
  }
  if ("retryReasons" in obj && obj.retryReasons !== undefined) {
    if (!Array.isArray(obj.retryReasons)) return false
    for (const r of obj.retryReasons) {
      if (typeof r !== "string" || !VALID_REASONS.has(r as DispatchValidationRetryReason)) {
        return false
      }
    }
  }
  return true
}

/**
 * 严格 parse — 不通过即抛错，错误信息标出哪个字段问题，便于调试。
 * 用于运行时强校验（e.g. 从 agent_events.payload JSON 反序列化后断言）。
 */
export function parseDispatchValidationRetryPayload(
  value: unknown,
): DispatchValidationRetryPayload {
  if (!value || typeof value !== "object") {
    throw new Error("dispatch_validation_retry payload: expected object")
  }
  const obj = value as Record<string, unknown>
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) throw new Error(`dispatch_validation_retry payload: missing field '${k}'`)
  }
  if (
    typeof obj.reason !== "string" ||
    !VALID_REASONS.has(obj.reason as DispatchValidationRetryReason)
  ) {
    throw new Error(
      `dispatch_validation_retry payload: invalid reason '${String(obj.reason)}' (expected nested_call_tag | naked_at_with_real_teammate)`,
    )
  }
  if (
    typeof obj.status !== "string" ||
    !VALID_STATUSES.has(obj.status as DispatchValidationRetryStatus)
  ) {
    throw new Error(
      `dispatch_validation_retry payload: invalid status '${String(obj.status)}' (expected retrying | settled | exhausted)`,
    )
  }
  if (!isPositiveInteger(obj.attemptIndex)) {
    throw new Error(
      `dispatch_validation_retry payload: invalid attemptIndex '${String(obj.attemptIndex)}' (expected positive integer)`,
    )
  }
  if (!isPositiveInteger(obj.maxAttempts)) {
    throw new Error(
      `dispatch_validation_retry payload: invalid maxAttempts '${String(obj.maxAttempts)}' (expected positive integer)`,
    )
  }
  if (
    "finalContent" in obj &&
    obj.finalContent !== undefined &&
    typeof obj.finalContent !== "string"
  ) {
    throw new Error(
      `dispatch_validation_retry payload: invalid finalContent type '${typeof obj.finalContent}' (expected string)`,
    )
  }
  if ("retryCount" in obj && obj.retryCount !== undefined) {
    if (
      typeof obj.retryCount !== "number" ||
      !Number.isInteger(obj.retryCount) ||
      obj.retryCount < 0
    ) {
      throw new Error(
        `dispatch_validation_retry payload: invalid retryCount '${String(obj.retryCount)}' (expected non-negative integer)`,
      )
    }
  }
  if ("retryReasons" in obj && obj.retryReasons !== undefined) {
    if (!Array.isArray(obj.retryReasons)) {
      throw new Error(
        `dispatch_validation_retry payload: invalid retryReasons type '${typeof obj.retryReasons}' (expected array)`,
      )
    }
    for (const r of obj.retryReasons) {
      if (typeof r !== "string" || !VALID_REASONS.has(r as DispatchValidationRetryReason)) {
        throw new Error(
          `dispatch_validation_retry payload: invalid retryReasons entry '${String(r)}' (expected nested_call_tag | naked_at_with_real_teammate)`,
        )
      }
    }
  }
  if (!isDispatchValidationRetryPayload(obj)) {
    throw new Error("dispatch_validation_retry payload: failed type guard (string fields)")
  }
  return obj
}

export type DispatchRetryAgentEventRow = {
  id: string
  invocationId: string
  threadId: string
  agentId: string
  eventType: typeof DISPATCH_VALIDATION_RETRY_EVENT_TYPE
  payload: string
  createdAt: string
}

/**
 * agent_events.id 命名空间：把 status 编进 id，避免 retrying / settled / exhausted
 * 同 attemptIndex 撞主键被吞（B021 R-... 教训：非 Claude 兜底分支不递增 attemptIndex 即崩）。
 *
 * - retrying  → `dispatch-retry-${invocationId}-${attemptIndex}`
 * - settled   → `dispatch-retry-${invocationId}-${attemptIndex}-settled`
 * - exhausted → `dispatch-retry-${invocationId}-${attemptIndex}-exhausted`
 */
export function buildDispatchRetryEventId(args: {
  invocationId: string
  attemptIndex: number
  status: DispatchValidationRetryStatus
}): string {
  const base = `dispatch-retry-${args.invocationId}-${args.attemptIndex}`
  if (args.status === "exhausted") return `${base}-exhausted`
  if (args.status === "settled") return `${base}-settled`
  return base
}

export function buildDispatchRetryAgentEventRow(
  payload: DispatchValidationRetryPayload,
  meta: { id: string },
): DispatchRetryAgentEventRow {
  return {
    id: meta.id,
    invocationId: payload.invocationId,
    threadId: payload.threadId,
    agentId: payload.agentId,
    eventType: DISPATCH_VALIDATION_RETRY_EVENT_TYPE,
    payload: JSON.stringify(payload),
    createdAt: payload.occurredAt,
  }
}

export function buildDispatchRetryRealtimeEvent(
  payload: DispatchValidationRetryPayload,
): Extract<RealtimeServerEvent, { type: "dispatch.validation_retry" }> {
  return { type: "dispatch.validation_retry", payload }
}
