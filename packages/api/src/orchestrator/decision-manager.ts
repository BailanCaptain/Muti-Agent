import type {
  DecisionRequest,
  DecisionVerdict,
  OptionVerdict,
  Provider,
  RealtimeServerEvent,
} from "@multi-agent/shared"

export type DecisionResponse = {
  decisions: Array<{ optionId: string; verdict: OptionVerdict; modification?: string }>
  userInput: string
}

type PendingDecision = {
  request: DecisionRequest
  resolve: (response: DecisionResponse) => void
  timer: ReturnType<typeof setTimeout>
}

// F033: decision_records 生命周期账本窄 facade（DecisionRecordRepository 结构子集）
type DecisionRecordsFacade = {
  insertPending: (record: DecisionRequest) => void
  markResolved: (
    requestId: string,
    status: "resolved" | "timeout",
    verdicts: DecisionVerdict[],
    userInput: string,
  ) => boolean
}

const VALID_VERDICTS: ReadonlySet<string> = new Set(["approved", "rejected", "modified"])

// F033 德彪 r1 P1-1 · decision.respond 运行时校验（WS JSON 是不可信输入）。
// 规则：optionId 必须已知且不重复；verdict 必须在枚举内；
// 基数按 kind：单选（multiSelect≠true）approved+modified ≤1（与 message-service
// 的 selected 过滤口径一致）；inline_confirmation 恰好 1 个 approved 且 0 个 modified
// （确认卡没有"修改"语义）。零 decisions + 纯文字回答对非 confirm kind 合法（存量行为）。
export function validateDecisions(
  request: DecisionRequest,
  decisions: Array<{ optionId: string; verdict: OptionVerdict; modification?: string }>,
): boolean {
  const knownIds = new Set(request.options.map((o) => o.id))
  const seen = new Set<string>()
  let selectedCount = 0
  let approvedCount = 0
  let modifiedCount = 0
  for (const d of decisions) {
    if (!knownIds.has(d.optionId)) return false
    if (seen.has(d.optionId)) return false
    seen.add(d.optionId)
    if (!VALID_VERDICTS.has(d.verdict)) return false
    if (d.verdict === "approved") {
      approvedCount++
      selectedCount++
    } else if (d.verdict === "modified") {
      modifiedCount++
      selectedCount++
    }
  }
  if (request.kind === "inline_confirmation") {
    return approvedCount === 1 && modifiedCount === 0
  }
  if (!(request.multiSelect ?? false) && selectedCount > 1) return false
  return true
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
      listThreadsByGroup: (sessionGroupId: string) => Array<{ id: string; provider: string }>
      appendMessage: (threadId: string, role: "user" | "assistant", content: string) => unknown
    },
    private readonly records?: DecisionRecordsFacade,
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
        // 德彪 r1 P1-2: 整体兜底——setTimeout 回调里逃逸的异常是进程级未捕获异常
        try {
          this.pending.delete(requestId)
          // F033 timeout 语义：inline_confirmation（confirm 卡）fail-closed 全 rejected——
          // "确认操作"绝不能超时自动通过；multi_choice/fan_in_selector 保持全 approved（零回归）。
          const fallbackVerdict =
            request.kind === "inline_confirmation" ? ("rejected" as const) : ("approved" as const)
          const fallbackDecisions = request.options.map((o) => ({
            optionId: o.id,
            verdict: fallbackVerdict,
          }))
          resolve({ decisions: fallbackDecisions, userInput: "" })
          this.persistAndAudit(request, requestId, "timeout", fallbackDecisions, "", {
            timedOut: true,
          })
          this.emit({
            type: "decision.resolved",
            payload: {
              sessionGroupId: request.sessionGroupId,
              requestId,
              decisions: fallbackDecisions,
            },
          })
        } catch (err) {
          console.error(`[decision-manager] timeout finalization failed (requestId=${requestId})`, err)
        }
      }, timeoutMs)

      this.pending.set(requestId, { request, resolve, timer })
      this.records?.insertPending(request)
      this.emit({ type: "decision.request", payload: request })
    })
  }

  getPendingRequests(sessionGroupId: string): DecisionRequest[] {
    const results: DecisionRequest[] = []
    for (const entry of this.pending.values()) {
      if (entry.request.sessionGroupId === sessionGroupId) {
        results.push(entry.request)
      }
    }
    return results
  }

  respond(
    requestId: string,
    decisions: Array<{ optionId: string; verdict: OptionVerdict; modification?: string }>,
    userInput?: string,
  ): void {
    const entry = this.pending.get(requestId)
    if (!entry) return

    // 德彪 r1 P1-1: WS 边界运行时校验。非法 payload fail-closed 拒收——
    // 不 resolve、不出终态事件、保持 pending（真人仍可继续响应或等超时）。
    if (!validateDecisions(entry.request, decisions)) {
      console.error(
        `[decision-manager] invalid decision.respond payload rejected (requestId=${requestId})`,
      )
      return
    }

    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    entry.resolve({ decisions, userInput: userInput ?? "" })
    this.persistAndAudit(entry.request, requestId, "resolved", decisions, userInput ?? "")

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

  // 德彪 r1 P1-2: DB 落库与审计留痕是非关键副作用——任何异常记日志后吞掉，
  // 保证终态 emit 必达、异常不逃出 timer/WS 调用栈。
  private persistAndAudit(
    request: DecisionRequest,
    requestId: string,
    status: "resolved" | "timeout",
    decisions: Array<{ optionId: string; verdict: OptionVerdict; modification?: string }>,
    userInput: string,
    opts?: { timedOut?: boolean },
  ): void {
    try {
      this.records?.markResolved(requestId, status, decisions, userInput)
    } catch (err) {
      console.error(`[decision-manager] markResolved failed (requestId=${requestId})`, err)
    }
    try {
      if (this.repository && request.sessionGroupId && request.sourceProvider) {
        this.writeDecisionToThread(request, decisions, userInput, opts)
      }
    } catch (err) {
      console.error(`[decision-manager] audit write failed (requestId=${requestId})`, err)
    }
  }

  private writeDecisionToThread(
    request: DecisionRequest,
    decisions: Array<{ optionId: string; verdict: OptionVerdict; modification?: string }>,
    userInput?: string,
    opts?: { timedOut?: boolean },
  ): void {
    if (!this.repository) return

    const threads = this.repository.listThreadsByGroup(request.sessionGroupId)
    const thread = threads.find((t) => t.provider === request.sourceProvider)
    if (!thread) return

    // F033 AC3: 审计消息自带上下文（title + description），
    // 单看这条消息就能知道确认的是什么（clowder B2 教训）。
    const lines: string[] = [`【决策卡】${request.title}`]
    if (request.description) {
      lines.push(request.description)
    }
    lines.push(
      opts?.timedOut ? "（超时自动处理，无人响应，以下为默认结果）" : "你提出的决策已确认：",
    )
    for (const d of decisions) {
      const option = request.options.find((o) => o.id === d.optionId)
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
