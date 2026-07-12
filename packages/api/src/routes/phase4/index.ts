/**
 * F027 Phase 4 · routes/phase4 barrel — registerPhase4Routes 集中入口
 *
 * 真相源: docs/plans/F027-phase4-implementation-plan.md
 *
 * server.ts 调一次 registerPhase4Routes(app, deps) 注册所有 Phase 4 endpoint:
 *   - POST /api/wiki/drafts/promote/preview  (AC-P4-1 b · V14 audit preview)
 *   - POST /api/wiki/drafts/promote          (AC-P4-1 · full promote 含 mv + wiki_events)
 *   - POST /api/wiki/drafts/batch-promote   (AC-P4-4 · 批量审批 部分失败语义)
 *   - POST /api/wiki/drafts/demote          (AC-P4-3 d · DemoteModal — mv 到 wiki/_rejected/ + wiki_events action='demote')
 *   - GET  /api/wiki/warnings               (AC-P4-9 a · warnings tab 派生)
 *   - GET  /api/wiki/index                  (AC-P4-9 b · KB tab 派生)
 *
 * 推 F028 (per F028-FOLLOWUP-BACKLOG.md):
 *   - GET  /api/wiki/drafts/rollback   (推 F028-2 · 写型 rollback 一起做)
 */

import type { FastifyInstance } from "fastify"

import type { WikiServices } from "../../wiki/wiki-services"
import { BatchPromoteService } from "../../wiki/promote-audit/batch-promote-service"
import { DemoteWikiService } from "../../wiki/promote-audit/demote-wiki-service"
import { PromoteWikiService } from "../../wiki/promote-audit/promote-wiki-service"
import {
  createFsSameSourceLookup,
  detectSameSourceConflicts,
} from "../../wiki/promote-audit/same-source-detector"
import { V14PromoteAuditService } from "../../wiki/promote-audit/v14-promote-audit-service"
import { registerBatchPromoteRoutes } from "./batch-promote"
import { registerDemoteRoutes } from "./demote"
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
  /**
   * 德彪 r1 P1-4 · promote/demote/supersede 落盘成功后的索引收敛通知。server.ts 传
   * fireWikiCommit forwarder → WikiCompilerDebounce（5s）→ reindexWiki——把召回面
   * 收敛窗口从 5min 周期安全网缩到秒级。不传 = 只靠周期安全网（测试/旧 caller 零回归）。
   */
  onWikiMutated?: () => void
}

export function registerPhase4Routes(app: FastifyInstance, deps: Phase4RoutesDeps): void {
  const audit = new V14PromoteAuditService()
  // F042 AC3 · 同源检测（德彪 r1 P1-4：数据源从 wiki_entity_index 换 FS 权威——index 靠
  // 5min 周期收敛，连续同源 promote 会绕过 409；FS 落盘即可见零滞后）。
  // detector 依赖 promote-wiki-service 的路径谓词，这里闭包注入防 import 环。
  const fsLookup = createFsSameSourceLookup(deps.wikiServices.wikiRoot)
  const findSameSource = (srcContent: string, destWikiPath: string) =>
    detectSameSourceConflicts(fsLookup, srcContent, destWikiPath)
  const promote = new PromoteWikiService({
    events: deps.wikiServices.events,
    leases: deps.wikiServices.leases,
    acl: deps.wikiServices.acl,
    wikiRoot: deps.wikiServices.wikiRoot,
    currentLeaderTerm: () => deps.wikiServices.leader.getCurrent()?.currentTerm ?? "999",
    auditService: audit,
    findSameSource,
  })

  registerPromoteRoutes(app, {
    promote,
    audit,
    leases: deps.wikiServices.leases,
    events: deps.wikiServices.events,
    wikiRoot: deps.wikiServices.wikiRoot,
    leaderTerm: () => deps.wikiServices.leader.getCurrent()?.currentTerm ?? "999",
    onWikiMutated: deps.onWikiMutated,
  })

  const batch = new BatchPromoteService({
    promote,
    leases: deps.wikiServices.leases,
    currentLeaderTerm: () => deps.wikiServices.leader.getCurrent()?.currentTerm ?? "999",
  })
  registerBatchPromoteRoutes(app, { batch, onWikiMutated: deps.onWikiMutated })

  // AC-P4-3 (d) · DemoteService + route (codex Week 5 j2 FAIL Red→Green)
  const demote = new DemoteWikiService({
    events: deps.wikiServices.events,
    leases: deps.wikiServices.leases,
    acl: deps.wikiServices.acl,
    wikiRoot: deps.wikiServices.wikiRoot,
    currentLeaderTerm: () => deps.wikiServices.leader.getCurrent()?.currentTerm ?? "999",
  })
  registerDemoteRoutes(app, {
    demote,
    leases: deps.wikiServices.leases,
    leaderTerm: () => deps.wikiServices.leader.getCurrent()?.currentTerm ?? "999",
    onWikiMutated: deps.onWikiMutated,
  })

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
export { registerDemoteRoutes } from "./demote"
export { registerWikiMetaRoutes, WikiMetaScanner } from "./wiki-meta"
