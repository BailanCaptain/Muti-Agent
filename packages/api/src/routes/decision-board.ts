import type { DecisionRecord } from "@multi-agent/shared"
import type { FastifyInstance, FastifyRequest } from "fastify"
import type { DecisionManager } from "../orchestrator/decision-manager"
import type { MessageService } from "../services/message-service"

type DecisionBoardRespondBody = {
  sessionGroupId: string
  decisions: Array<{
    itemId: string
    choice: { kind: "option"; optionId: string } | { kind: "custom"; text: string }
  }>
  skipped?: boolean
}

/**
 * F002: POST /decision-board/respond — the user's single-shot response to a
 * `decision.board_flush` modal. Triggers one dispatch to the A2A chain
 * starter thread (see MessageService.handleDecisionBoardRespond).
 */
export function registerDecisionBoardRoutes(
  app: FastifyInstance,
  deps: {
    messageService: MessageService
    decisions: DecisionManager
    // F033: decision_records 账本（可选注入，未接时端点优雅降级为空）
    decisionRecords?: {
      listBySessionGroup: (
        sessionGroupId: string,
        opts?: { excludePending?: boolean; limit?: number },
      ) => DecisionRecord[]
    }
  },
): void {
  app.get("/api/decisions/pending", async (request: FastifyRequest) => {
    const { sessionGroupId } = request.query as { sessionGroupId?: string }
    if (!sessionGroupId) return { pending: [] }
    return { pending: deps.decisions.getPendingRequests(sessionGroupId) }
  })

  // F033 AC2: 已决/超时/孤儿卡片的渲染真相源（pending 的活句柄仍走 /pending 内存 Map）
  app.get("/api/decisions/records", async (request: FastifyRequest) => {
    const { sessionGroupId } = request.query as { sessionGroupId?: string }
    if (!sessionGroupId || !deps.decisionRecords) return { records: [] }
    return {
      records: deps.decisionRecords.listBySessionGroup(sessionGroupId, { excludePending: true }),
    }
  })

  app.get("/api/decisions/board-pending", async (request: FastifyRequest) => {
    const { sessionGroupId } = request.query as { sessionGroupId?: string }
    if (!sessionGroupId) return { items: [] }
    const entries = deps.messageService.getPendingFlushEntries(sessionGroupId)
    if (!entries || entries.length === 0) return { items: [] }
    return {
      sessionGroupId,
      flushedAt: new Date().toISOString(),
      items: entries.map((entry) => ({
        id: entry.id,
        question: entry.question,
        options: entry.options,
        raisers: entry.raisers.map((r) => ({ alias: r.alias, provider: r.provider })),
        firstRaisedAt: entry.firstRaisedAt,
        converged: entry.converged,
      })),
    }
  })

  app.post<{ Body: DecisionBoardRespondBody }>(
    "/decision-board/respond",
    async (request, reply) => {
      const body = request.body
      if (!body?.sessionGroupId || !Array.isArray(body.decisions)) {
        reply.code(400)
        return { ok: false, error: "sessionGroupId and decisions are required" }
      }
      await deps.messageService.handleDecisionBoardRespond(body)
      return { ok: true }
    },
  )
}
