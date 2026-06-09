/**
 * F026 · server 启动路径装 A2A Gateway hook
 *
 * 把 hook 安装收拢为一个函数：server.ts 只加一行，
 * `a2a-gateway-bootstrap.test.ts` 单测里直接复现生产路径。
 * 没装 hook 时 dispatch 退回旧 regex 路由，CallRegistry 不写、Envelope 不产。
 */

import type { DatabaseSync } from "node:sqlite"
import type { EnvelopeV1, Provider } from "@multi-agent/shared"

import { type A2AGatewayBroadcaster, planBetaDispatch } from "./a2a-gateway"
import { CallRegistry } from "./call-registry"
import type {
  A2AGatewayHook,
  A2AGatewayPlanInput,
  A2AGatewayPlanResult,
  DispatchOrchestrator,
} from "./dispatch"
import { MentionRateLimiter, type ProviderAliases } from "./mention-router"
import type { WorklistRegistry } from "./worklist-registry"

/**
 * F027 P4-A3 fallback j2 P1 修 (V16.5 §M1 line 422-431)：
 * derive handoffContext from F026 EnvelopeV1，给 A2AGatewayPlanResult.mentions[] 用。
 *
 * 规则（V16.5 §M1 line 428-429）:
 * - receiverAlias = on_behalf_of ?? convener_id ?? mention.alias（fallback）
 *   理由：on-behalf-of 反推按 ADR-003，displays who task is "for"；convener_id 是 group lead。
 * - taskSummary = β path: envelope.task.input.source_message（agent 原文整段，task='conversation'）
 *                 γ path: envelope.task.task（cross-role-handoff skill 模板字符串，task!='conversation'）
 *
 * envelope 失败时返 undefined → caller-side helper fallback 到现有 simplified shape。
 */
function deriveHandoffContext(
  envelope: EnvelopeV1 | undefined,
  fallbackReceiverAlias: string,
): { receiverAlias: string; taskSummary: string } | undefined {
  if (!envelope) return undefined
  const receiverAlias =
    envelope.protocol.on_behalf_of ?? envelope.protocol.convener_id ?? fallbackReceiverAlias
  let taskSummary: string | undefined
  if (envelope.task.task === "conversation") {
    // β path
    const input = envelope.task.input as { source_message?: unknown }
    if (typeof input?.source_message === "string") {
      taskSummary = input.source_message
    }
  } else {
    // γ path
    taskSummary = envelope.task.task
  }
  if (!receiverAlias || !taskSummary) return undefined
  return { receiverAlias, taskSummary }
}

export interface InstallA2AGatewayDeps {
  db: DatabaseSync
  aliases: ProviderAliases
  now?: () => string
  /** 测试用注入点；生产环境用默认内存实现。 */
  rateLimiter?: MentionRateLimiter
  registry?: CallRegistry
  /**
   * F026 P5 T2 · 灰区可观测 broadcaster。生产由 server.ts 透传 RealtimeBroadcaster，
   * 测试 / a2a-gateway-bootstrap.test 缺省 — planBetaDispatch fallback console.warn。
   */
  broadcaster?: A2AGatewayBroadcaster
  /**
   * F026 P3 · sibling-guard 反查依赖。生产由 server.ts 透传 WorklistRegistry；
   * 测试缺省时 sibling-guard 静默放行（向后兼容）。
   */
  worklistRegistry?: Pick<WorklistRegistry, "findActiveByParentCallId">
}

export function installA2AGateway(
  dispatch: DispatchOrchestrator,
  deps: InstallA2AGatewayDeps,
): { registry: CallRegistry } {
  const registry =
    deps.registry ??
    new CallRegistry({
      db: deps.db,
      now: deps.now,
      // F026 P5 T4 · pending_change WS emit：CallRegistry mutation 后广播 pendingSet
      // 让前端 F1 @pill / F6 Pulse / F10 /debug/a2a 视图实时刷新。
      broadcaster: deps.broadcaster,
    })
  const rateLimiter = deps.rateLimiter ?? new MentionRateLimiter()

  const hook: A2AGatewayHook = {
    planMentions(input: A2AGatewayPlanInput): A2AGatewayPlanResult {
      const plan = planBetaDispatch(
        {
          db: deps.db,
          registry,
          rateLimiter,
          aliases: deps.aliases,
          now: deps.now,
          broadcaster: deps.broadcaster,
          worklistRegistry: deps.worklistRegistry,
        },
        {
          sourceAgentId: input.sourceAgentId,
          sourceReplyTo: input.sourceReplyTo,
          messageId: input.messageId,
          content: input.content,
          sessionGroupId: input.sessionGroupId,
          // F026 acceptance-guardian R-204 · 父 invocation 处理的 dispatchedCallId 由
          // dispatch.enqueuePublicMentions 从 invocationContexts 反查后透传过来 —
          // 这样 child a2a_calls.parent_call_id 不再 NULL, call tree 真接起来,
          // 下游 P5 视觉原语 (Visual Silo / 折叠群组 / 结论卡) + R-066 收敛全部依赖此。
          parentCallId: input.parentCallId ?? undefined,
          sourceRole: input.sourceRole,
        },
      )

      return {
        mentions: plan.dispatched.map((d) => ({
          provider: d.mention.provider,
          alias: d.mention.alias,
          callId: d.callId,
          // F027 P4-A3 fallback j2 P1 修 (V16.5 §M1 line 422-431)：
          // derive handoffContext from F026 envelope；message-service caller 直接透传。
          //   receiverAlias = on_behalf_of ?? convener_id ?? mention.alias
          //     （on-behalf-of 反推按 ADR-003；convenerTransfer 时 convener_id 已是 on_behalf_of，
          //      此处仍优先取显式 on_behalf_of 字段以兜底）
          //   taskSummary = β path: envelope.task.input.source_message（agent 原文整段）
          //                 γ path: envelope.task.task（cross-role-handoff skill 模板）
          handoffContext: deriveHandoffContext(d.envelope, d.mention.alias),
        })),
        blockedByGateway: [
          ...plan.blocked.map((b) => ({
            provider: b.mention.provider,
            alias: b.mention.alias,
            reason: b.reason,
          })),
          ...plan.grayZone.map((gz) => ({
            provider: gz.provider as Provider,
            alias: gz.alias,
            reason: "gray-zone",
          })),
        ],
      }
    },
  }

  dispatch.setA2AGatewayHook(hook)
  return { registry }
}
