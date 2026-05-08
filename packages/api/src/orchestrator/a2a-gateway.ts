/**
 * F026 Phase 1 · A2A Gateway (wiring helper)
 *
 * 把 Round 2 协议地基（call-registry / mention-router 三层+on-behalf+rate-limit /
 * envelope-builder β/γ）缝合成一个单入口函数。
 *
 * 本文件**不修改**现有 dispatch.ts / return-path.ts / message-service.ts 主干。
 * Phase 1 仅以 flag-gated 模式提供新入口，Phase 2 再 wire into dispatch 的 happy path。
 *
 * 契约（ADR-004 透明原则）：agent 只提供自然语言消息 + source 身份；其他字段全部
 * 从 router/registry 推断。
 */

import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { EnvelopeV1, RealtimeServerEvent } from "@multi-agent/shared"
import {
  buildMentionGrayZoneAgentEventRow,
  buildMentionGrayZoneRealtimeEvent,
  clipContentSample,
} from "../services/mention-gray-zone-event"
import type { CallRegistry } from "./call-registry"
import {
  type BuildGammaEnvelopeInput,
  buildBetaEnvelope,
  buildGammaEnvelope,
} from "./envelope-builder"
import {
  type DispatchMention,
  type MentionRateLimiter,
  type MentionSourceRole,
  type ProviderAliases,
  inferOnBehalfOf,
  resolveCallTagMentions,
  resolveMentionsClassified,
} from "./mention-router"
import { isSiblingCrossCall } from "./sibling-guard"
import type { WorklistRegistry } from "./worklist-registry"

/**
 * F026 P5 T2 · 灰区可观测注入点。生产 wire 由 server.ts → a2a-gateway-bootstrap 透传
 * RealtimeBroadcaster.broadcast；测试可替换以断言 emit 调用次数 / payload 字段。
 */
export interface A2AGatewayBroadcaster {
  broadcast(event: RealtimeServerEvent): void
}

export interface A2AGatewayDeps {
  db: DatabaseSync
  registry: CallRegistry
  rateLimiter: MentionRateLimiter
  aliases: ProviderAliases
  now?: () => string
  defaultDeadlineMs?: number
  /**
   * F026 P5 T2 · 灰区命中实时广播。可选：缺省时 fallback console.warn（向后兼容旧测试 harness）。
   * spec I1' / line 74 / 269 / 390：fail-closed 默认不派 + 写日志（现升级为 WS 事件）。
   */
  broadcaster?: A2AGatewayBroadcaster
  /**
   * F026 P3 · sibling-guard 反查依赖。可选 —— 缺省 / undefined 时 sibling 互调
   * 静默放行（向后兼容历史测试 harness）。生产 wire 由 a2a-gateway-bootstrap
   * 透传 server.ts 创建的 WorklistRegistry。
   */
  worklistRegistry?: Pick<WorklistRegistry, "findActiveByParentCallId">
}

export interface A2ADispatchInput {
  sourceAgentId: string // agent alias 或 user id
  sourceReplyTo: string // agent:黄仁勋 / user:小孙 / ...
  messageId: string
  content: string
  sessionGroupId: string
  parentCallId?: string
  /**
   * F026 方案 X · 双契约 source role guard。
   *   "assistant" → 只识别 [Call: @X 描述] 显式标签；自由文本 @ 一律不派发
   *   "user" / undefined → 现有 ADR-003 三层分类路径（line-start/anywhere）
   */
  sourceRole?: MentionSourceRole
}

export interface A2ADispatchPlan {
  mention: DispatchMention
  callId: string
  envelope: EnvelopeV1
  blocked?: never
}

export interface A2ADispatchBlocked {
  mention: DispatchMention
  blocked: true
  reason: string
  callId?: never
  envelope?: never
}

export type A2ADispatchOutcome = A2ADispatchPlan | A2ADispatchBlocked

export interface A2AGrayZoneHit {
  provider: string
  alias: string
  index: number
}

export interface A2AGatewayResult {
  dispatched: A2ADispatchPlan[]
  blocked: A2ADispatchBlocked[]
  grayZone: A2AGrayZoneHit[]
}

/**
 * Public so message-service (1A.2 user-root call) and other call-builders share
 * the same deadline contract — keeping cleanup-timer / pendingOf TTL aligned
 * across user-root and gateway-built child calls.
 */
export const DEFAULT_A2A_CALL_DEADLINE_MS = 30 * 60 * 1000 // 30 min
const DEFAULT_DEADLINE_MS = DEFAULT_A2A_CALL_DEADLINE_MS

/**
 * Single entry-point for the β (conversation) path.
 *
 * Runs mention-router 3-layer → for each `dispatch` or `gray` match:
 *   - check rate-limit
 *   - openCall() in registry with resolved issuer/convener/on_behalf_of
 *   - buildBetaEnvelope()
 *
 * Gray-zone matches are NOT dispatched (ADR-003 默认不派 + 日志). They are
 * recorded in `grayZone` and emitted via console.warn so the white-list can be
 * tightened from real samples — but the safety net remains in place to block
 * 段中描述 / 第三人称转述 / 装饰性引用等本就不该派的样本。Layer 2 白名单
 * （POLITE_HEAD + VERB_HEAD）负责把真祈使句吃进 hard-positive 通道。
 */
export function planBetaDispatch(deps: A2AGatewayDeps, input: A2ADispatchInput): A2AGatewayResult {
  const now = deps.now ?? (() => new Date().toISOString())
  const deadlineMs = deps.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS

  // F026 方案 X · assistant 双契约：放弃白名单/POLITE_HEAD/VERB_HEAD 猜测路径，
  // 改为只识别 [Call: @X 描述] 显式标签；自由文本 @ 全部静默。
  if (input.sourceRole === "assistant") {
    return planAssistantCallTagDispatch(deps, input, now, deadlineMs)
  }

  const classified = resolveMentionsClassified(input.content, deps.aliases)

  const grayZone: A2AGrayZoneHit[] = classified
    .filter((m) => m.classification === "gray")
    .map((m) => ({ provider: m.provider, alias: m.alias, index: m.index }))

  const dispatched: A2ADispatchPlan[] = []
  const blocked: A2ADispatchBlocked[] = []

  for (const c of classified) {
    if (c.classification === "gray") {
      // F026 P5 T2 + T4 · spec I1' / line 74 / 269 / 390 灰区可观测：
      //   - WS broadcast `mention.gray_zone`（前端 /debug/a2a F10 视图实时订阅）
      //   - agent_events 持久化（T4 schema invocation_id nullable 已落 · 历史回查走 DB）
      const grayPayload = {
        sessionGroupId: input.sessionGroupId,
        traceId: `gray-${randomUUID()}`,
        source: input.sourceAgentId,
        sourceMessageId: input.messageId,
        target: c.alias,
        targetProvider: c.provider,
        contentSample: clipContentSample(input.content),
        decision: "skip" as const,
        occurredAt: now(),
      }

      if (deps.broadcaster) {
        deps.broadcaster.broadcast(buildMentionGrayZoneRealtimeEvent(grayPayload))
      } else {
        console.warn(
          `[a2a-gateway] gray-zone NOT dispatched source=${input.sourceAgentId} target=${c.provider}:${c.alias} messageId=${input.messageId}`,
        )
      }

      // 持久化（INSERT OR IGNORE 用 traceId-based PK 自洽 CAS）
      const row = buildMentionGrayZoneAgentEventRow(grayPayload)
      try {
        deps.db
          .prepare(
            `INSERT OR IGNORE INTO agent_events
              (id, invocation_id, thread_id, agent_id, event_type, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.invocationId,
            row.threadId,
            row.agentId,
            row.eventType,
            row.payload,
            row.createdAt,
          )
      } catch (err) {
        // fail-silent — gray-zone 持久化失败不应阻断主流派发链
        console.warn(`[a2a-gateway] mention_gray_zone persist failed: ${String(err)}`)
      }

      continue
    }
    const atIndex = input.content.indexOf("@" + c.alias, c.index)
    const aliasEnd = atIndex >= 0 ? atIndex + 1 + c.alias.length : c.index + 1 + c.alias.length
    const behalf = inferOnBehalfOf(input.content, { atIndex: Math.max(0, atIndex), aliasEnd })
    const mention: DispatchMention = {
      provider: c.provider,
      alias: c.alias,
      index: c.index,
      traceId: `trace-${randomUUID()}`,
      onBehalfOf: behalf.onBehalfOf,
      convenerTransfer: behalf.convenerTransfer,
    }

    // F026 P3 sibling-guard：caller 派给同 fan-out 内另一 sibling → 拒绝
    if (
      deps.worklistRegistry &&
      input.parentCallId &&
      isSiblingCrossCall(
        { callRegistry: deps.registry, worklistRegistry: deps.worklistRegistry },
        {
          callerCallId: input.parentCallId,
          callerAlias: input.sourceAgentId,
          targetAlias: c.alias,
        },
      )
    ) {
      blocked.push({ mention, blocked: true, reason: "sibling-cross-call" })
      continue
    }

    const rl = deps.rateLimiter.allow({
      source: input.sourceAgentId,
      target: mention.provider,
      messageId: input.messageId,
      sessionGroupId: input.sessionGroupId,
    })
    if (!rl.allowed) {
      blocked.push({ mention, blocked: true, reason: rl.reason })
      continue
    }

    // Resolve convener: default = source (self), lifted when on-behalf inference transfers.
    const effectiveOnBehalfOf = resolveOnBehalfValue(behalf.onBehalfOf, input.sourceAgentId)
    const convenerId =
      behalf.convenerTransfer && effectiveOnBehalfOf ? effectiveOnBehalfOf : input.sourceAgentId

    const deadlineAt = new Date(new Date(now()).getTime() + deadlineMs).toISOString()

    const callId = deps.registry.openCall({
      parentCallId: input.parentCallId,
      issuerId: input.sourceAgentId,
      convenerId,
      onBehalfOf: effectiveOnBehalfOf,
      replyTo: input.sourceReplyTo,
      sessionGroupId: input.sessionGroupId,
      deadlineAt,
    })

    const envelope = buildBetaEnvelope({
      callId,
      registry: deps.registry,
      sourceMessage: input.content,
    })

    dispatched.push({ mention, callId, envelope })
  }

  return { dispatched, blocked, grayZone }
}

/**
 * γ path entry: skill-driven structured handoff. No mention-router / rate-limit —
 * the skill itself is the structured trigger, not a natural-language parse.
 * Still uses call-registry (for Call Tree身份) and builder (for envelope).
 */
export interface GammaDispatchInput {
  sourceAgentId: string
  sourceReplyTo: string
  sessionGroupId: string
  parentCallId?: string
  convenerId: string
  onBehalfOf?: string | null
  task: string
  taskInput: Record<string, unknown>
  expectedOutput: string | null
  constraints: string[] | null
}

export function planGammaDispatch(
  deps: Omit<A2AGatewayDeps, "rateLimiter" | "aliases">,
  input: GammaDispatchInput,
): { callId: string; envelope: EnvelopeV1 } {
  const now = deps.now ?? (() => new Date().toISOString())
  const deadlineMs = deps.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS
  const deadlineAt = new Date(new Date(now()).getTime() + deadlineMs).toISOString()

  const callId = deps.registry.openCall({
    parentCallId: input.parentCallId,
    issuerId: input.sourceAgentId,
    convenerId: input.convenerId,
    onBehalfOf: input.onBehalfOf ?? null,
    replyTo: input.sourceReplyTo,
    sessionGroupId: input.sessionGroupId,
    deadlineAt,
  })

  const envelope = buildGammaEnvelope({
    callId,
    registry: deps.registry,
    task: input.task,
    input: input.taskInput,
    expectedOutput: input.expectedOutput,
    constraints: input.constraints,
  } satisfies BuildGammaEnvelopeInput)

  return { callId, envelope }
}

/**
 * F026 方案 X · assistant call-tag 派发路径。
 *
 * 严格契约：
 *   - 只识别 [Call: @X 描述] 标签；位置无关（行首/句中/段中皆可）
 *   - 自由文本里的 @X 不派发（避免白名单永远漏一个动词的脆弱猜测）
 *   - 同消息重复 [Call: @X] 走 rate-limiter 去重（与 user 路径同语义）
 *   - 不走 inferOnBehalfOf —— assistant 显式声明意图，不再猜 on-behalf
 *     （需要时由 description 显式带 "代小孙 ..." 字样，下游做语义路由）
 */
function planAssistantCallTagDispatch(
  deps: A2AGatewayDeps,
  input: A2ADispatchInput,
  now: () => string,
  deadlineMs: number,
): A2AGatewayResult {
  const tags = resolveCallTagMentions(input.content, deps.aliases)
  const dispatched: A2ADispatchPlan[] = []
  const blocked: A2ADispatchBlocked[] = []

  for (const tag of tags) {
    const mention: DispatchMention = {
      provider: tag.provider,
      alias: tag.alias,
      index: tag.index,
      traceId: `trace-${randomUUID()}`,
      onBehalfOf: null,
      convenerTransfer: false,
    }

    // F026 P3 sibling-guard：[Call:] 派给同 fan-out 内另一 sibling → 拒绝
    if (
      deps.worklistRegistry &&
      input.parentCallId &&
      isSiblingCrossCall(
        { callRegistry: deps.registry, worklistRegistry: deps.worklistRegistry },
        {
          callerCallId: input.parentCallId,
          callerAlias: input.sourceAgentId,
          targetAlias: tag.alias,
        },
      )
    ) {
      blocked.push({ mention, blocked: true, reason: "sibling-cross-call" })
      continue
    }

    const rl = deps.rateLimiter.allow({
      source: input.sourceAgentId,
      target: mention.provider,
      messageId: input.messageId,
      sessionGroupId: input.sessionGroupId,
    })
    if (!rl.allowed) {
      blocked.push({ mention, blocked: true, reason: rl.reason })
      continue
    }

    const deadlineAt = new Date(new Date(now()).getTime() + deadlineMs).toISOString()

    const callId = deps.registry.openCall({
      parentCallId: input.parentCallId,
      issuerId: input.sourceAgentId,
      convenerId: input.sourceAgentId,
      onBehalfOf: null,
      replyTo: input.sourceReplyTo,
      sessionGroupId: input.sessionGroupId,
      deadlineAt,
    })

    const envelope = buildBetaEnvelope({
      callId,
      registry: deps.registry,
      sourceMessage: input.content,
    })

    dispatched.push({ mention, callId, envelope })
  }

  return { dispatched, blocked, grayZone: [] }
}

// ---------- helpers ----------

function resolveOnBehalfValue(raw: string | null, issuerId: string): string | null {
  if (raw === null) return null
  if (raw === "self") return issuerId
  return raw
}
