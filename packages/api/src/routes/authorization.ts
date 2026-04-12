import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import type { ApprovalManager } from "../orchestrator/approval-manager"
import type { AuthorizationRuleStore } from "../orchestrator/authorization-rule-store"

export function registerAuthorizationRoutes(
  app: FastifyInstance,
  options: { approvals: ApprovalManager; ruleStore: AuthorizationRuleStore },
) {
  app.get("/api/authorization/pending", async (request: FastifyRequest) => {
    const { sessionGroupId } = request.query as { sessionGroupId?: string }
    if (!sessionGroupId) return { pending: [] }
    return { pending: options.approvals.getPending(sessionGroupId) }
  })

  app.get("/api/authorization/rules", async (request: FastifyRequest) => {
    const { provider, threadId } = request.query as {
      provider?: string
      threadId?: string
    }
    const filter = provider || threadId ? { provider, threadId } : undefined
    return { rules: options.ruleStore.listRules(filter) }
  })

  app.post("/api/authorization/rules", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      provider?: string
      action?: string
      scope?: string
      decision?: string
      threadId?: string
      sessionGroupId?: string
      reason?: string
    } | null
    if (
      !body ||
      !body.provider ||
      !body.action ||
      !body.scope ||
      !body.decision
    ) {
      reply.code(400)
      return { error: "Missing required fields: provider, action, scope, decision" }
    }
    if (!["thread", "global"].includes(body.scope)) {
      reply.code(400)
      return { error: "scope must be 'thread' or 'global'" }
    }
    if (!["allow", "deny"].includes(body.decision)) {
      reply.code(400)
      return { error: "decision must be 'allow' or 'deny'" }
    }
    const rule = options.ruleStore.addRule({
      provider: body.provider,
      action: body.action,
      scope: body.scope as "thread" | "global",
      decision: body.decision as "allow" | "deny",
      threadId: body.threadId,
      sessionGroupId: body.sessionGroupId,
      reason: body.reason,
    })
    return { status: "ok", rule }
  })

  app.delete("/api/authorization/rules/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const removed = options.ruleStore.removeRule(id)
    if (!removed) {
      reply.code(404)
      return { error: "Rule not found" }
    }
    return { status: "ok" }
  })
}
