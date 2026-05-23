/**
 * F027 Phase 4 · routes/phase4 barrel — registerPhase4Routes 集中入口
 *
 * 真相源: docs/plans/F027-phase4-implementation-plan.md
 *
 * server.ts 调一次 registerPhase4Routes(app, deps) 注册所有 Phase 4 endpoint:
 *   - POST /api/wiki/drafts/promote/preview  (AC-P4-1 b · V14 audit preview)
 *   - POST /api/wiki/drafts/promote          (AC-P4-1 · full promote 含 mv + wiki_events)
 *   - POST /api/wiki/drafts/batch-promote   (AC-P4-4 · 批量审批 部分失败语义)
 *   - GET  /api/wiki/warnings               (AC-P4-9 a · warnings tab 派生)
 *   - GET  /api/wiki/index                  (AC-P4-9 b · KB tab 派生)
 *
 * Week 4-5 待加 (TBD):
 *   - POST /api/wiki/drafts/demote     (AC-P4-3 · DemoteModal)
 *   - GET  /api/wiki/drafts/rollback   (AC-P4-3 · RollbackPreview read-only)
 */

import type { FastifyInstance } from "fastify"

import type { WikiServices } from "../../wiki/wiki-services"
import { BatchPromoteService } from "../../wiki/promote-audit/batch-promote-service"
import { PromoteWikiService } from "../../wiki/promote-audit/promote-wiki-service"
import { V14PromoteAuditService } from "../../wiki/promote-audit/v14-promote-audit-service"
import { registerBatchPromoteRoutes } from "./batch-promote"
import { registerPromoteRoutes } from "./promote"
import { registerWikiMetaRoutes, WikiMetaScanner } from "./wiki-meta"

export interface Phase4RoutesDeps {
  /** WikiServices (createWikiServices(...) 已在 Phase 3 wired) — 包 events/leases/acl/wikiRoot/leader. */
  wikiServices: WikiServices
  /** Wiki 派生视图根 (warnings/index 文件位置)。
   *  默认 = wikiServices.wikiRoot；worktree-preview 模式下应传 .runtime/worktree-preview/data/wiki/
   *  (跟 worktree-preview-wiki-fixtures copier dest 一致)。
   */
  metaWikiRoot?: string
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

  const batch = new BatchPromoteService({
    promote,
    leases: deps.wikiServices.leases,
    currentLeaderTerm: () => deps.wikiServices.leader.getCurrent()?.currentTerm ?? "999",
  })
  registerBatchPromoteRoutes(app, { batch })

  // AC-P4-9 a/b · wiki/warnings + wiki/index 派生视图 endpoint (Day 17)
  // codex Week 4 mid-r1 P2 修: 注入 events repo merge wiki_events warning_raised rows
  const metaScanner = new WikiMetaScanner({
    wikiRoot: deps.metaWikiRoot ?? deps.wikiServices.wikiRoot,
    events: deps.wikiServices.events,
  })
  registerWikiMetaRoutes(app, { scanner: metaScanner })
}

export { registerPromoteRoutes } from "./promote"
export { registerBatchPromoteRoutes } from "./batch-promote"
export { registerWikiMetaRoutes, WikiMetaScanner } from "./wiki-meta"
