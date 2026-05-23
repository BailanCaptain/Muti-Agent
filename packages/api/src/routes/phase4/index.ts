/**
 * F027 Phase 4 · routes/phase4 barrel — registerPhase4Routes 集中入口
 *
 * 真相源: docs/plans/F027-phase4-implementation-plan.md
 *
 * server.ts 调一次 registerPhase4Routes(app, deps) 注册所有 Phase 4 endpoint:
 *   - POST /api/wiki/drafts/promote/preview  (AC-P4-1 b · V14 audit preview)
 *   - POST /api/wiki/drafts/promote          (AC-P4-1 · full promote 含 mv + wiki_events)
 *
 * Week 2-3 待加 (TBD):
 *   - POST /api/wiki/drafts/demote     (AC-P4-3 · DemoteModal)
 *   - GET  /api/wiki/drafts/rollback   (AC-P4-3 · RollbackPreview read-only)
 *   - POST /api/wiki/drafts/batch-promote (AC-P4-4)
 */

import type { FastifyInstance } from "fastify"

import type { WikiServices } from "../../wiki/wiki-services"
import { PromoteWikiService } from "../../wiki/promote-audit/promote-wiki-service"
import { V14PromoteAuditService } from "../../wiki/promote-audit/v14-promote-audit-service"
import { registerPromoteRoutes } from "./promote"

export interface Phase4RoutesDeps {
  /** WikiServices (createWikiServices(...) 已在 Phase 3 wired) — 包 events/leases/acl/wikiRoot/leader. */
  wikiServices: WikiServices
}

export function registerPhase4Routes(app: FastifyInstance, deps: Phase4RoutesDeps): void {
  const audit = new V14PromoteAuditService()
  const promote = new PromoteWikiService({
    events: deps.wikiServices.events,
    leases: deps.wikiServices.leases,
    acl: deps.wikiServices.acl,
    wikiRoot: deps.wikiServices.wikiRoot,
    currentLeaderTerm: () => deps.wikiServices.leader.getCurrent()?.currentTerm ?? "999",
    auditService: audit,
  })

  registerPromoteRoutes(app, {
    promote,
    audit,
    leases: deps.wikiServices.leases,
    wikiRoot: deps.wikiServices.wikiRoot,
    leaderTerm: () => deps.wikiServices.leader.getCurrent()?.currentTerm ?? "999",
  })
}

export { registerPromoteRoutes } from "./promote"
