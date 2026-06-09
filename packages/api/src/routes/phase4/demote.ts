/**
 * F027 Phase 4 AC-P4-3 (d) · POST /api/wiki/drafts/demote route
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-3 (d)
 *   - DemoteWikiService (packages/api/src/wiki/promote-audit/demote-wiki-service.ts)
 *   - 复用 promote route lease 模式 (acquireLease + try/finally release)
 *
 * Endpoint:
 *   - POST /api/wiki/drafts/demote — mv src 到 wiki/_rejected/ + wiki_events action='demote'
 *     body: { srcWikiPath, callerAlias, reason, sourceMessageIds? }
 *     resp 200: { ok: true, rejectedPath, eventId }
 *     resp 403: { ok: false, code: 'DENIED_ACL', error }
 *     resp 404: { ok: false, code: 'SRC_NOT_FOUND', error }
 *     resp 409: { ok: false, code: 'LEASE_HELD' | 'LEASE_FENCING_FAILED' | 'DEST_EXISTS', error }
 *     resp 400: { ok: false, code: 'VALIDATION_ERROR' | 'PATH_INVALID', error }
 *
 * 注意 path 校验跟 promote 不同:
 *   - promote: src 必须 draft (含 /draft/ 或 /_drafts/)
 *   - demote: src 可任意 wiki/ 下 (含 draft + 正式 entity), 但不能在 wiki/_rejected/ 内
 */

import type { FastifyInstance } from "fastify"

import type { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"
import type { DemoteWikiService } from "../../wiki/promote-audit/demote-wiki-service"

const DEFAULT_DEMOTE_LEASE_TTL_SECONDS = 30

export interface DemoteRoutesDeps {
  demote: DemoteWikiService
  leases: WikiLeasesRepository
  leaderTerm: () => string
  demoteLeaseTtlSeconds?: number
}

type PostDemoteBody = {
  srcWikiPath?: string
  callerAlias?: string
  reason?: string
  sourceMessageIds?: string[]
}

export function registerDemoteRoutes(app: FastifyInstance, deps: DemoteRoutesDeps): void {
  const ttl = deps.demoteLeaseTtlSeconds ?? DEFAULT_DEMOTE_LEASE_TTL_SECONDS

  app.post("/api/wiki/drafts/demote", async (request, reply) => {
    const body = (request.body ?? {}) as PostDemoteBody
    const validation = validateDemoteBody(body)
    if (!validation.ok) {
      reply.code(400)
      return { ok: false, code: "VALIDATION_ERROR", error: validation.error }
    }

    const acquired = deps.leases.acquireLease({
      path: validation.body.srcWikiPath,
      ownerAlias: validation.body.callerAlias,
      ttlSeconds: ttl,
      leaderTerm: deps.leaderTerm(),
    })
    if (!acquired) {
      reply.code(409)
      return {
        ok: false,
        code: "LEASE_HELD",
        error: `src lease held by another owner: ${validation.body.srcWikiPath}`,
      }
    }

    try {
      const result = deps.demote.demote({
        srcWikiPath: validation.body.srcWikiPath,
        callerAlias: validation.body.callerAlias,
        reason: validation.body.reason,
        fencingToken: acquired.fencingToken,
        sourceMessageIds: validation.body.sourceMessageIds,
      })

      switch (result.status) {
        case "ok":
          return {
            ok: true,
            rejectedPath: result.rejectedPath,
            eventId: result.eventId,
          }
        case "denied_acl":
          reply.code(403)
          return { ok: false, code: "DENIED_ACL", error: result.error }
        case "lease_expired":
          reply.code(409)
          return { ok: false, code: "LEASE_FENCING_FAILED", error: result.error }
        case "src_not_found":
          reply.code(404)
          return { ok: false, code: "SRC_NOT_FOUND", error: result.error }
        case "dest_exists":
          reply.code(409)
          return { ok: false, code: "DEST_EXISTS", error: result.error }
        case "path_invalid":
          reply.code(400)
          return { ok: false, code: "PATH_INVALID", error: result.error }
        default:
          reply.code(500)
          return { ok: false, code: "INTERNAL_ERROR", error: result.error }
      }
    } finally {
      deps.leases.releaseLease({
        path: validation.body.srcWikiPath,
        fencingToken: acquired.fencingToken,
      })
    }
  })
}

type ValidatedDemote =
  | {
      ok: true
      body: {
        srcWikiPath: string
        callerAlias: string
        reason: string
        sourceMessageIds?: string[]
      }
    }
  | { ok: false; error: string }

function validateDemoteBody(body: PostDemoteBody): ValidatedDemote {
  if (typeof body.srcWikiPath !== "string" || body.srcWikiPath.length === 0) {
    return { ok: false, error: "srcWikiPath required" }
  }
  if (typeof body.callerAlias !== "string" || body.callerAlias.length === 0) {
    return { ok: false, error: "callerAlias required" }
  }
  if (typeof body.reason !== "string" || body.reason.length === 0) {
    return { ok: false, error: "reason required (non-empty)" }
  }
  return {
    ok: true,
    body: {
      srcWikiPath: body.srcWikiPath,
      callerAlias: body.callerAlias,
      reason: body.reason,
      sourceMessageIds: body.sourceMessageIds,
    },
  }
}
