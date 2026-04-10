import type { FastifyInstance } from "fastify"
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
  deps: { messageService: MessageService },
): void {
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
