import type { DecisionRequest, Provider, RealtimeServerEvent } from "@multi-agent/shared"

export type DecisionResponse = {
  decisions: Array<{ optionId: string; verdict: string; modification?: string }>
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

  constructor(
    private readonly emit: (event: RealtimeServerEvent) => void,
    private readonly repository?: {
      listThreadsByGroup: (sessionGroupId: string) => Array<{ id: string; provider: string }>;
      appendMessage: (threadId: string, role: "user" | "assistant", content: string) => unknown;
    },
  ) {}

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
        // Default to approving all options on timeout
        const fallbackDecisions = request.options.map(o => ({ optionId: o.id, verdict: "approved" as const }))
        resolve({ decisions: fallbackDecisions, userInput: "" })
        this.emit({
          type: "decision.resolved",
          payload: { sessionGroupId: request.sessionGroupId, requestId, decisions: fallbackDecisions },
        })
      }, timeoutMs)

      this.pending.set(requestId, { request, resolve, timer })
      this.emit({ type: "decision.request", payload: request })
    })
  }

  respond(requestId: string, decisions: Array<{optionId: string; verdict: string; modification?: string}>, userInput?: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) return

    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve({ decisions, userInput: userInput ?? "" })

    // Write decision result to source agent's thread
    if (this.repository && entry.request.sessionGroupId && entry.request.sourceProvider) {
      this.writeDecisionToThread(entry.request, decisions, userInput)
    }

    this.emit({
      type: "decision.resolved",
      payload: {
        sessionGroupId: entry.request.sessionGroupId,
        requestId,
        decisions,
        ...(userInput ? { userInput } : {}),
      },
    })
  }

  private writeDecisionToThread(
    request: DecisionRequest,
    decisions: Array<{optionId: string; verdict: string; modification?: string}>,
    userInput?: string,
  ): void {
    if (!this.repository) return

    const threads = this.repository.listThreadsByGroup(request.sessionGroupId)
    const thread = threads.find(t => t.provider === request.sourceProvider)
    if (!thread) return

    // Build a readable summary of the decisions
    const lines: string[] = [`你提出的决策已确认：`]
    for (const d of decisions) {
      const option = request.options.find(o => o.id === d.optionId)
      const label = option?.label ?? d.optionId
      if (d.verdict === "approved") {
        lines.push(`✅ ${label}`)
      } else if (d.verdict === "rejected") {
        lines.push(`❌ ${label}（已否决）`)
      } else if (d.verdict === "modified") {
        lines.push(`✏️ ${label}（修改：${d.modification ?? ""})`)
      }
    }
    if (userInput) {
      lines.push(`\n补充说明：${userInput}`)
    }

    this.repository.appendMessage(thread.id, "user", lines.join("\n"))
  }
}
