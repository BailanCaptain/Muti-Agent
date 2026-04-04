import type { DecisionRequest, Provider, RealtimeServerEvent } from "@multi-agent/shared"

type PendingDecision = {
  request: DecisionRequest
  resolve: (selectedIds: string[]) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Manages decision requests sent to the frontend.
 * Each request blocks until the user responds or timeout.
 */
export class DecisionManager {
  private readonly pending = new Map<string, PendingDecision>()

  constructor(private readonly emit: (event: RealtimeServerEvent) => void) {}

  /**
   * Send a decision request to the frontend and wait for the response.
   * Returns the selected option IDs.
   */
  request(params: {
    kind: DecisionRequest["kind"]
    title: string
    description?: string
    options: DecisionRequest["options"]
    sessionGroupId: string
    sourceProvider?: Provider
    sourceAlias?: string
    multiSelect?: boolean
    timeoutMs?: number
  }): Promise<string[]> {
    const requestId = crypto.randomUUID()
    const request: DecisionRequest = {
      requestId,
      kind: params.kind,
      title: params.title,
      description: params.description,
      options: params.options,
      sessionGroupId: params.sessionGroupId,
      sourceProvider: params.sourceProvider,
      sourceAlias: params.sourceAlias,
      multiSelect: params.multiSelect,
      createdAt: new Date().toISOString(),
    }

    return new Promise<string[]>((resolve) => {
      const timeoutMs = params.timeoutMs ?? 5 * 60 * 1000
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        // Default to first option on timeout
        resolve(request.options.length > 0 ? [request.options[0].id] : [])
        this.emit({
          type: "decision.resolved",
          payload: {
            requestId,
            selectedIds: request.options.length > 0 ? [request.options[0].id] : [],
          },
        })
      }, timeoutMs)

      this.pending.set(requestId, { request, resolve, timer })
      this.emit({ type: "decision.request", payload: request })
    })
  }

  respond(requestId: string, selectedIds: string[]): void {
    const entry = this.pending.get(requestId)
    if (!entry) return

    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve(selectedIds)

    this.emit({
      type: "decision.resolved",
      payload: { requestId, selectedIds },
    })
  }
}
