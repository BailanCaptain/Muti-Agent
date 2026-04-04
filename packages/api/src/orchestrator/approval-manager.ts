import crypto from "node:crypto"
import type { ApprovalRequest, ApprovalScope, Provider, RealtimeServerEvent } from "@multi-agent/shared"

type ApprovalResult = { status: "granted" | "denied" | "timeout" }

type PendingEntry = {
  request: ApprovalRequest
  resolve: (result: ApprovalResult) => void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(
    private readonly emit: (event: RealtimeServerEvent) => void,
    private readonly timeoutMs = 120_000,
  ) {}

  requestPermission(params: {
    invocationId: string
    provider: Provider
    agentAlias: string
    threadId: string
    sessionGroupId: string
    action: string
    reason: string
    context?: string
  }): Promise<ApprovalResult> {
    const requestId = crypto.randomUUID()
    const request: ApprovalRequest = {
      requestId,
      provider: params.provider,
      agentAlias: params.agentAlias,
      threadId: params.threadId,
      sessionGroupId: params.sessionGroupId,
      action: params.action,
      reason: params.reason,
      context: params.context,
      createdAt: new Date().toISOString(),
    }

    this.emit({ type: "approval.request", payload: request })

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        this.emit({ type: "approval.resolved", payload: { requestId, granted: false } })
        resolve({ status: "timeout" })
      }, this.timeoutMs)

      this.pending.set(requestId, { request, resolve, timer })
    })
  }

  respond(requestId: string, granted: boolean, _scope: ApprovalScope): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false

    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    this.emit({ type: "approval.resolved", payload: { requestId, granted } })
    entry.resolve({ status: granted ? "granted" : "denied" })
    return true
  }

  cancelAll(sessionGroupId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.request.sessionGroupId === sessionGroupId) {
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        this.emit({ type: "approval.resolved", payload: { requestId, granted: false } })
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
