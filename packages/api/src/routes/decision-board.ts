import type { FastifyInstance, FastifyRequest } from "fastify"
import type { DecisionManager } from "../orchestrator/decision-manager"
import type { MessageService } from "../services/message-service"

type DecisionBoardRespondBody = {
  sessionGroupId: string
  decisions: Array<{
    itemId: string
    choice:
      | { kind: "option"; optionId: string }
      | { kind: "custom"; text: string }
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
  deps: { messageService: MessageService; decisions: DecisionManager },
): void {
  app.get("/api/decisions/pending", async (request: FastifyRequest) => {
    const { sessionGroupId } = request.query as { sessionGroupId?: string }
    if (!sessionGroupId) return { pending: [] }
    return { pending: deps.decisions.getPendingRequests(sessionGroupId) }
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
