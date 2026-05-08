import type { FastifyInstance, FastifyRequest } from "fastify"
import type { CallRegistry, CallStatus } from "../orchestrator/call-registry"

/**
 * F026 P1 Wiring · GET /debug/a2a — read-only window into the call-registry.
 *
 * Query shapes (P1 + P5 T3):
 *   ?root=<callId>            → getTree(rootCallId)             (full call tree, P1)
 *   ?parent=<callId>          → pendingOf(parentCallId)          (P1)
 *   ?status=<CallStatus>      → findByStatus(status)             (P5 T3 全表过滤)
 *   ?session=<gid>&view=tree  → getSessionTrees(sessionGroupId)  (P5 T3 房间聚合)
 *
 * Used by:
 *   - dev/preview manual verification (this is the eye-level proof that
 *     advance/settle hooks actually fire)
 *   - F026 P5 F10 /debug/a2a 前端视图（依赖 status filter / session-trees 两种新形态）
 *
 * Not for: production user traffic. 400 when no query / unknown status / 用法非法。
 */
const VALID_STATUSES: ReadonlySet<CallStatus> = new Set([
  "pending",
  "working",
  "done",
  "failed",
  "timeout",
  "cancelled",
])

export function registerDebugA2ARoutes(
  app: FastifyInstance,
  deps: { callRegistry: CallRegistry },
): void {
  app.get("/debug/a2a", async (request: FastifyRequest, reply) => {
    const { root, parent, status, session, view } = request.query as {
      root?: string
      parent?: string
      status?: string
      session?: string
      view?: string
    }

    if (root) {
      return { kind: "tree", rootCallId: root, calls: deps.callRegistry.getTree(root) }
    }
    if (parent) {
      return { kind: "pending", parentCallId: parent, calls: deps.callRegistry.pendingOf(parent) }
    }
    if (status) {
      if (!VALID_STATUSES.has(status as CallStatus)) {
        reply.code(400)
        return {
          error: `invalid status '${status}' (expected: ${[...VALID_STATUSES].join(" | ")})`,
        }
      }
      return {
        kind: "status",
        status,
        calls: deps.callRegistry.findByStatus(status as CallStatus),
      }
    }
    if (session) {
      if (view !== "tree") {
        reply.code(400)
        return { error: "session query requires view=tree (e.g. ?session=g1&view=tree)" }
      }
      return {
        kind: "session_trees",
        sessionGroupId: session,
        trees: deps.callRegistry.getSessionTrees(session),
      }
    }

    reply.code(400)
    return {
      error:
        "missing query: ?root=<callId> | ?parent=<callId> | ?status=<CallStatus> | ?session=<gid>&view=tree",
    }
  })
}
