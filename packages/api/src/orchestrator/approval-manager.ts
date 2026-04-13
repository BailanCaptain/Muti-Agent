import crypto from "node:crypto"
import type {
  ApprovalFingerprint,
  ApprovalRequest,
  ApprovalScope,
  Provider,
  RealtimeServerEvent,
} from "@multi-agent/shared"
import type { AuthorizationRuleStore } from "./authorization-rule-store"

export type ApprovalResult = { status: "granted" | "denied" | "timeout" }

type PendingEntry = {
  request: ApprovalRequest
  resolve: (result: ApprovalResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(
    private readonly emit: (event: RealtimeServerEvent) => void,
    private readonly ruleStore?: AuthorizationRuleStore,
    private readonly timeoutMs = 120_000,
  ) {}

  requestPermission(params: {
    invocationId: string
    provider: Provider
    agentAlias: string
    threadId: string
    sessionGroupId: string
    action: string
    fingerprint?: ApprovalFingerprint
    reason: string
    context?: string
  }): Promise<ApprovalResult> {
    const fingerprint: ApprovalFingerprint = params.fingerprint ?? {
      tool: params.action,
      risk: "medium",
    }

    if (this.ruleStore) {
      const rule = this.ruleStore.match(params.provider, params.action, params.threadId)
      if (rule) {
        if (rule.decision === "allow") {
          this.emit({
            type: "approval.auto_granted",
            payload: { sessionGroupId: params.sessionGroupId, provider: params.provider, action: params.action, ruleId: rule.id },
          })
          return Promise.resolve({ status: "granted" })
        }
        return Promise.resolve({ status: "denied" })
      }
    }

    const requestId = crypto.randomUUID()
    const request: ApprovalRequest = {
      requestId,
      provider: params.provider,
      agentAlias: params.agentAlias,
      threadId: params.threadId,
      sessionGroupId: params.sessionGroupId,
      action: params.action,
      fingerprint,
      reason: params.reason,
      context: params.context,
      createdAt: new Date().toISOString(),
    }

    this.emit({ type: "approval.request", payload: request })

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.emit({ type: "approval.resolved", payload: { sessionGroupId: request.sessionGroupId, requestId, granted: false } })
        resolve({ status: "timeout" })
      }, this.timeoutMs)

      this.pending.set(requestId, { request, resolve, timer })
    })
  }

  respond(requestId: string, granted: boolean, scope: ApprovalScope): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false

    clearTimeout(entry.timer)
    this.pending.delete(requestId)

    if (scope !== "once" && this.ruleStore) {
      this.ruleStore.addRule({
        provider: entry.request.provider,
        action: entry.request.action,
        scope,
        decision: granted ? "allow" : "deny",
        ...(scope === "thread"
          ? { threadId: entry.request.threadId, sessionGroupId: entry.request.sessionGroupId }
          : {}),
      })
    }

    this.emit({ type: "approval.resolved", payload: { sessionGroupId: entry.request.sessionGroupId, requestId, granted } })
    entry.resolve({ status: granted ? "granted" : "denied" })
    return true
  }

  getPending(sessionGroupId: string): ApprovalRequest[] {
    const result: ApprovalRequest[] = []
    for (const entry of this.pending.values()) {
      if (entry.request.sessionGroupId === sessionGroupId) {
        result.push(entry.request)
      }
    }
    return result
  }

  cancelAll(sessionGroupId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.request.sessionGroupId === sessionGroupId) {
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        this.emit({ type: "approval.resolved", payload: { sessionGroupId, requestId, granted: false } })
        entry.resolve({ status: "denied" })
      }
    }
  }

  hasPending(sessionGroupId: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.request.sessionGroupId === sessionGroupId) return true
    }
    return false
  }
}
