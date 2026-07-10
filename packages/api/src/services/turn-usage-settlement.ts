import type { TokenUsageSnapshot } from "@multi-agent/shared"
import { detectFBloat } from "../orchestrator/fbloat-detector"
import type { RunTurnResult, SealDecision } from "../runtime/cli-orchestrator"

export type TurnUsageSettlement = {
  /**
   * 写入 threads.last_fill_ratio 的值。三态语义（updateThread 契约）：
   * number = 本轮 fill；null = 清列（封存复位）；undefined = 不动列（本轮无判定）。
   */
  lastFillRatio: number | null | undefined
  /**
   * F043 AC5/AC7 · threads 面板真值三列，与 lastFillRatio 同三态同步：
   * 封存 → null 清三列；有快照 → 真值；无快照 → undefined 不动列。
   */
  threadUsage:
    | { usedTokens: number; windowTokens: number; source: "exact" | "approx" }
    | null
    | undefined
  fBloatDetected: boolean
}

/**
 * F043 AC4 · turn 收尾的 fill / F-BLOAT 基线记账（从 message-service seal 段同位提取）。
 *
 * 封存轮特殊化两刀：
 * 1. lastFillRatio 复位 null —— 旧代码把 sealDecision.fillRatio（≥action）落库，
 *    native_session_id 已清但 fill 还挂着 95%/100%，面板在新 session 上长期显示假满。
 * 2. F-BLOAT 基线清零且本轮不记账 —— 旧代码把 sealed 轮的 usage 写进 prevUsedTokens，
 *    新 session 首轮 token 骤降必误报「CLI 内部压缩」并 invalidate 摘要。
 *
 * 非封存轮行为与提取前 1:1：无判定 → undefined（updateThread 跳过该列）；
 * warn/正常 → fillRatio 照落；F-BLOAT 检出 → status + invalidateSummary + 置旗标。
 */
export function settleTurnUsage(args: {
  threadId: string
  alias: string
  sessionGroupId: string
  usage: TokenUsageSnapshot | null
  sealDecision: SealDecision | null
  prevUsedTokens: Map<string, number>
  emit: (event: {
    type: "status"
    payload: { sessionGroupId: string; message: string }
  }) => void
  invalidateSummary: () => void
}): TurnUsageSettlement {
  if (args.sealDecision?.shouldSeal) {
    args.prevUsedTokens.delete(args.threadId)
    return { lastFillRatio: null, threadUsage: null, fBloatDetected: false }
  }

  let fBloatDetected = false
  if (args.usage) {
    const prevTokens = args.prevUsedTokens.get(args.threadId) ?? 0
    const bloat = detectFBloat(prevTokens, args.usage.usedTokens)
    if (bloat.detected) {
      fBloatDetected = true
      args.emit({
        type: "status",
        payload: {
          sessionGroupId: args.sessionGroupId,
          message: `${args.alias} CLI 内部压缩检测到（token 突降 ${Math.round(bloat.dropRatio * 100)}%），下轮将强制重注入 system prompt。`,
        },
      })
      args.invalidateSummary()
    }
    args.prevUsedTokens.set(args.threadId, args.usage.usedTokens)
  }
  return {
    lastFillRatio: args.sealDecision?.fillRatio,
    threadUsage: args.usage
      ? {
          usedTokens: args.usage.usedTokens,
          windowTokens: args.usage.windowTokens,
          source: args.usage.source,
        }
      : undefined,
    fBloatDetected,
  }
}

type TurnTotals = NonNullable<RunTurnResult["turnTotals"]>

/** 计费聚合：totalTokens 相加；detail 任一侧存在即逐字段求和（缺侧按 0）。 */
function aggregateTurnTotals(a: TurnTotals | null, b: TurnTotals | null): TurnTotals | null {
  if (!a) return b
  if (!b) return a
  const detail =
    a.detail || b.detail
      ? {
          inputTokens: (a.detail?.inputTokens ?? 0) + (b.detail?.inputTokens ?? 0),
          outputTokens: (a.detail?.outputTokens ?? 0) + (b.detail?.outputTokens ?? 0),
          cacheReadTokens: (a.detail?.cacheReadTokens ?? 0) + (b.detail?.cacheReadTokens ?? 0),
          cacheCreationTokens:
            (a.detail?.cacheCreationTokens ?? 0) + (b.detail?.cacheCreationTokens ?? 0),
        }
      : undefined
  return { totalTokens: a.totalTokens + b.totalTokens, ...(detail ? { detail } : {}) }
}

/**
 * F043 P1-3（德彪 r1）· 派发协议 retry 后的最终生效结果。
 *
 * 病灶：retry 成功只回填 content/nativeSessionId，settlement/updateThread/token
 * 落库仍消费重试前的 loopResult.lastResult —— retry 把上下文推过阈值时漏封存，
 * 收尾快照还会用旧值反向覆盖轮中 retry 快照。
 *
 * 语义：上下文足迹（usage）/ seal 判定 / session 身份 = 末次成功尝试（当前
 * 上下文的真实状态）；turnTotals（计费）= 所有实际尝试之和（失败尝试的 token
 * 真实花掉了，只算末次会低报本轮成本）。无 retry → 原对象直返，common path 1:1。
 */
export function resolveEffectiveTurnResult(
  base: RunTurnResult,
  retries: RunTurnResult[],
): RunTurnResult {
  if (retries.length === 0) return base
  let totals: TurnTotals | null = base.turnTotals ?? null
  for (const retry of retries) {
    totals = aggregateTurnTotals(totals, retry.turnTotals ?? null)
  }
  const last = retries[retries.length - 1]
  return { ...last, turnTotals: totals }
}

/**
 * F043 修2（德彪 r2）· seal 生命周期唯一谓词。
 *
 * continuation-loop 的 stoppedReason==="sealed" 与末次 result.sealDecision 同源
 * （continuation-loop.ts:52），但它定格在派发协议 retry 之前 —— retry 越阈时仍是
 * "complete"，digest/ThreadMemory/sessionChain/auto-resume 钩子全被跳过，而 seal
 * 事件 + session 清空（吃生效结果）照常发生 → 脑裂。
 *
 * 所有 seal 后处理一律以最终生效 RunTurnResult 的 sealDecision 为真相源：
 * 非 retry 路径与旧谓词严格等价（1:1）；retry 路径双向收敛（越阈补封存 /
 * 回读改判不封则钩子同步不跑）。
 */
export function sealedThisTurn(result: RunTurnResult): boolean {
  return result.sealDecision?.shouldSeal === true
}
