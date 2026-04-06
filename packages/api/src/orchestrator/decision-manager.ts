import type { DecisionRequest, Provider, RealtimeServerEvent } from "@multi-agent/shared"

export type DecisionResponse = {
  selectedIds: string[]
  userInput: string
}

type PendingDecision = {
  request: DecisionRequest
  resolve: (response: DecisionResponse) => void
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
   * Returns the user's selections and (optional) free-text input.
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
    allowTextInput?: boolean
    textInputPlaceholder?: string
    timeoutMs?: number
    anchorMessageId?: string
  }): Promise<DecisionResponse> {
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
      allowTextInput: params.allowTextInput,
      textInputPlaceholder: params.textInputPlaceholder,
      anchorMessageId: params.anchorMessageId,
      createdAt: new Date().toISOString(),
    }

    return new Promise<DecisionResponse>((resolve) => {
      const timeoutMs = params.timeoutMs ?? 5 * 60 * 1000
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        // Default to first option on timeout
        const fallbackIds = request.options.length > 0 ? [request.options[0].id] : []
        resolve({ selectedIds: fallbackIds, userInput: "" })
        this.emit({
          type: "decision.resolved",
          payload: { requestId, selectedIds: fallbackIds },
        })
      }, timeoutMs)

      this.pending.set(requestId, { request, resolve, timer })
      this.emit({ type: "decision.request", payload: request })
    })
  }

  respond(requestId: string, selectedIds: string[], userInput?: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return

    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve({ selectedIds, userInput: userInput ?? "" })

    this.emit({
      type: "decision.resolved",
      payload: {
        requestId,
        selectedIds,
        ...(userInput ? { userInput } : {}),
      },
    })
  }
}
