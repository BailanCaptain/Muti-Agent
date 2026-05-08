import type { MentionGrayZonePayload, RealtimeServerEvent } from "@multi-agent/shared"

/**
 * F026 P5 T2 · mention-router Layer 3 灰区可观测事件 helpers
 *
 * 单一定义点（mirror dispatch-retry-event.ts 风格）：
 *   - DB 行 eventType 列写 "mention_gray_zone" 字面量（持久化挪 T4 · 等 schema nullable invocation_id）
 *   - WS event 走 RealtimeServerEvent 联合类型 "mention.gray_zone"
 *   - payload schema 验证统一在此模块（轻量 type guard，避免引入 zod 依赖）
 *
 * a2a-gateway.planBetaDispatch 在 user 路径 classifyMention 命中 gray 时调用：
 *   broadcaster.broadcast(buildMentionGrayZoneRealtimeEvent(payload))
 */

export const MENTION_GRAY_ZONE_EVENT_TYPE = "mention_gray_zone" as const

const REQUIRED_KEYS = [
  "sessionGroupId",
  "traceId",
  "source",
  "sourceMessageId",
  "target",
  "targetProvider",
  "contentSample",
  "decision",
  "occurredAt",
] as const

export function isMentionGrayZonePayload(value: unknown): value is MentionGrayZonePayload {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) return false
  }
  if (typeof obj.sessionGroupId !== "string") return false
  if ("threadId" in obj && obj.threadId !== undefined && typeof obj.threadId !== "string")
    return false
  if (typeof obj.traceId !== "string" || obj.traceId.length === 0) return false
  if (typeof obj.source !== "string") return false
  if (typeof obj.sourceMessageId !== "string") return false
  if (typeof obj.target !== "string") return false
  if (typeof obj.targetProvider !== "string") return false
  if (typeof obj.contentSample !== "string") return false
  if (obj.decision !== "skip") return false
  if (typeof obj.occurredAt !== "string") return false
  return true
}

export function parseMentionGrayZonePayload(value: unknown): MentionGrayZonePayload {
  if (!value || typeof value !== "object") {
    throw new Error("mention_gray_zone payload: expected object")
  }
  const obj = value as Record<string, unknown>
  for (const k of REQUIRED_KEYS) {
    if (!(k in obj)) throw new Error(`mention_gray_zone payload: missing field '${k}'`)
  }
  if (obj.decision !== "skip") {
    throw new Error(
      `mention_gray_zone payload: invalid decision '${String(obj.decision)}' (expected 'skip')`,
    )
  }
  if (typeof obj.traceId !== "string" || obj.traceId.length === 0) {
    throw new Error("mention_gray_zone payload: traceId must be non-empty string")
  }
  if (!isMentionGrayZonePayload(obj)) {
    throw new Error("mention_gray_zone payload: failed type guard (string fields)")
  }
  return obj
}

export function buildMentionGrayZoneRealtimeEvent(
  payload: MentionGrayZonePayload,
): Extract<RealtimeServerEvent, { type: "mention.gray_zone" }> {
  return { type: "mention.gray_zone", payload }
}

export function clipContentSample(content: string, max = 200): string {
  if (content.length <= max) return content
  return `${content.slice(0, max)}…`
}

/**
 * F026 P5 T4 · agent_events 行 helper（schema invocation_id nullable 已落）。
 * id deterministic from traceId — gray hit 第二次重发同一 traceId 不会重复（CAS via PK）。
 */
export type MentionGrayZoneAgentEventRow = {
  id: string
  invocationId: string | null
  threadId: string
  agentId: string
  eventType: typeof MENTION_GRAY_ZONE_EVENT_TYPE
  payload: string
  createdAt: string
}

export function buildMentionGrayZoneEventId(traceId: string): string {
  return `mention-gray-${traceId}`
}

export function buildMentionGrayZoneAgentEventRow(
  payload: MentionGrayZonePayload,
  meta: { id?: string; invocationId?: string | null } = {},
): MentionGrayZoneAgentEventRow {
  return {
    id: meta.id ?? buildMentionGrayZoneEventId(payload.traceId),
    invocationId: meta.invocationId ?? null,
    threadId: payload.threadId ?? "",
    agentId: payload.source,
    eventType: MENTION_GRAY_ZONE_EVENT_TYPE,
    payload: JSON.stringify(payload),
    createdAt: payload.occurredAt,
  }
}
