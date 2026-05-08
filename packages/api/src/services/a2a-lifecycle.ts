import type { CallRegistry, CallRow, TerminalStatus } from "../orchestrator/call-registry"

/**
 * F026 P1 Wiring · single source of truth for advance/settle on call-registry.
 *
 * Two design contracts you can rely on:
 *   1. `callId === undefined` → every method is a noop. The classic dispatch
 *      path (no gateway hook installed) injects invocations without ever
 *      opening a call row, and we must not throw at its release.
 *   2. settle on a terminal row is a CAS noop (already enforced by registry).
 *      Cleanup timer + normal release race is therefore safe — first one wins.
 *
 * Kept deliberately thin: it owns no state and forwards to CallRegistry.
 * The point of the wrapper is so callers don't sprinkle `if (callId) registry.settle(...)`
 * across runtime / message-service / future P5 code.
 */
export class A2ALifecycleService {
  constructor(private readonly registry: CallRegistry) {}

  /**
   * F026 P2 Step 1A · 建 user-root call —— call tree 的源点。
   *
   * 为什么要这条 API：handleSendMessage 入口（message-service.ts:835）调
   * enqueuePublicMentions 不传 parentCallId → user 派发的所有 child call 全是
   * orphan root。R-080 实证 user → 黄仁勋 → 桂芬 这条链 user 不在树上，链尾
   * 闭环时无法回追 user，续推机制（Step 1B）也没锚点。
   *
   * issuerId / convenerId / replyTo 全部 = "user"（自家发起、自家收件），
   * parentCallId 缺省 → registry.openCall 视为 root，rootCallId === callId。
   */
  openRootCall(input: {
    issuerAlias: string
    sessionGroupId: string
    deadlineAt: string
  }): string {
    return this.registry.openCall({
      issuerId: input.issuerAlias,
      convenerId: input.issuerAlias,
      replyTo: input.issuerAlias,
      sessionGroupId: input.sessionGroupId,
      deadlineAt: input.deadlineAt,
    })
  }

  /**
   * F026 P2 Step 1A.2 · 建 child call —— directTurn 路径下 thread agent 自己回复
   * 不走 a2a-gateway（gateway 只处理 mention 派发），message-service 必须在
   * runThreadTurn 调用前自建 child call 挂在 user-root 下，并把 callId 透
   * dispatchedCallId 给 runThreadTurn，让 advance/settle/cleanup 全链路生效。
   *
   * 与 openRootCall 对称：thin wrapper of registry.openCall，让 message-service
   * 不必拿 registry（registry 是 lifecycle 的 private 字段），保持封装。
   *
   * convenerAlias / replyTo 缺省 = issuerAlias。
   */
  openCall(input: {
    parentCallId: string
    issuerAlias: string
    sessionGroupId: string
    deadlineAt: string
    convenerAlias?: string
    replyTo?: string
    onBehalfOf?: string | null
  }): string {
    return this.registry.openCall({
      parentCallId: input.parentCallId,
      issuerId: input.issuerAlias,
      convenerId: input.convenerAlias ?? input.issuerAlias,
      replyTo: input.replyTo ?? input.issuerAlias,
      onBehalfOf: input.onBehalfOf ?? null,
      sessionGroupId: input.sessionGroupId,
      deadlineAt: input.deadlineAt,
    })
  }

  /**
   * F026 P2 v2 · 反查 call row（thin wrapper of registry.get）—— message-service
   * 续推派发要拿 replyTo / sessionGroupId / rootCallId，不直接持 registry 引用。
   */
  getCall(callId: string | undefined | null): CallRow | null {
    if (!callId) return null
    try {
      return this.registry.get(callId)
    } catch {
      return null
    }
  }

  /** pending → working. Noop if callId is undefined. Noop if already past pending. */
  advance(callId: string | undefined): void {
    if (!callId) return
    try {
      this.registry.advance(callId, "working")
    } catch {
      // CAS guard — illegal target / unknown call id should not break the
      // turn loop. Registry tests cover the happy path; here we only need to
      // promise the caller "this never throws".
    }
  }

  settleDone(callId: string | undefined): void {
    this.settle(callId, "done")
  }

  settleFailed(callId: string | undefined): void {
    this.settle(callId, "failed")
  }

  settleTimeout(callId: string | undefined): void {
    this.settle(callId, "timeout")
  }

  settleCancelled(callId: string | undefined): void {
    this.settle(callId, "cancelled")
  }

  private settle(callId: string | undefined, to: TerminalStatus): void {
    if (!callId) return
    try {
      this.registry.settle(callId, to)
    } catch {
      // Same defensive contract as advance(): never let a stray settle break
      // the invocation cleanup path.
    }
  }
}
