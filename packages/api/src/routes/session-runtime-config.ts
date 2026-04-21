import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

type SessionRuntimeConfig = Record<string, unknown>

// Minimal repo surface the route needs. Duck-typed so both the legacy
// SqliteStore-backed SessionRepository (tests) and the DrizzleSessionRepository
// (server) satisfy it without an awkward shared base class.
export type SessionRuntimeConfigRepo = {
  getSessionGroupById: (groupId: string) => { id: string } | undefined
  getSessionRuntimeConfig: (groupId: string) => Record<string, unknown>
  setSessionRuntimeConfig: (groupId: string, config: Record<string, unknown>) => void
  // F021 Phase 3.3: pending layer for running-guard.
  getSessionPendingConfig: (groupId: string) => Record<string, unknown>
  setSessionPendingConfig: (groupId: string, pending: Record<string, unknown>) => void
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function registerSessionRuntimeConfigRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionRuntimeConfigRepo },
) {
  app.get(
    "/api/sessions/:id/runtime-config",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params
      const group = deps.sessions.getSessionGroupById(id)
      if (!group) {
        reply.code(404)
        return { error: `Session ${id} not found` }
      }
      const config = deps.sessions.getSessionRuntimeConfig(id) as SessionRuntimeConfig
      const pending = deps.sessions.getSessionPendingConfig(id) as SessionRuntimeConfig
      return { config, pending }
    },
  )

  app.put(
    "/api/sessions/:id/runtime-config",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params
      const body = request.body as { config?: unknown; pending?: unknown } | null
      if (!body || typeof body !== "object") {
        reply.code(400)
        return { error: "Body must be an object with optional { config, pending }." }
      }
      const hasConfig = "config" in body
      const hasPending = "pending" in body
      if (!hasConfig && !hasPending) {
        reply.code(400)
        return { error: "Body must include at least one of { config, pending }." }
      }
      if (hasConfig && !isPlainObject(body.config)) {
        reply.code(400)
        return { error: "config must be a plain object." }
      }
      if (hasPending && !isPlainObject(body.pending)) {
        reply.code(400)
        return { error: "pending must be a plain object." }
      }

      const group = deps.sessions.getSessionGroupById(id)
      if (!group) {
        reply.code(404)
        return { error: `Session ${id} not found` }
      }

      try {
        if (hasConfig) deps.sessions.setSessionRuntimeConfig(id, body.config as Record<string, unknown>)
        if (hasPending) deps.sessions.setSessionPendingConfig(id, body.pending as Record<string, unknown>)
      } catch (error) {
        reply.code(500)
        return {
          error: `Failed to save session runtime config: ${(error as Error).message}`,
        }
      }

      return {
        ok: true,
        config: deps.sessions.getSessionRuntimeConfig(id),
        pending: deps.sessions.getSessionPendingConfig(id),
      }
    },
  )
}
