/**
 * F027 Phase 3 P20 · routes/phase3 barrel — registerPhase3Routes 集中入口
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1+2
 *
 * server.ts 末尾调一次 `registerPhase3Routes(app, deps)` 注册所有 Phase 3 endpoint。
 *
 * Week 1 已 wire：
 *   - GET /api/rooms/:id/viewfinder           (Day 3)
 *   - GET /api/wiki/drafts                    (Day 3)
 *   - GET /api/rooms/:id/prompt-inspector     (Day 4)
 *   - POST /api/wiki/ingest/preview           (Day 5)
 *
 * Week 2 已 wire：
 *   - POST /api/rooms/:id/decisions           (Day 6 AC-P3-8)
 *   - GET  /api/rooms/:id/decisions/coverage  (Day 6 AC-P3-8)
 *   - POST /api/wiki/ingest/commit            (Day 9-10 AC-P3-10) — 需 wikiServices 注入
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import type { WikiServices } from "../../wiki/wiki-services"
import { DecisionService, registerDecisionsRoute } from "./decisions"
import { DraftScanner, registerDraftsRoute } from "./drafts"
import { IngestCommitService, registerIngestCommitRoute } from "./ingest-commit"
import { IngestPreviewService, registerIngestPreviewRoute } from "./ingest-preview"
import { PreviewStore } from "./preview-store"
import { PromptInspectorService, registerPromptInspectorRoute } from "./prompt-inspector"
import { ViewfinderService, registerViewfinderRoute } from "./viewfinder"
import { WikiStoryService, registerWikiStoryRoute } from "./wiki-story"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface Phase3RoutesDeps {
  db: DrizzleDb
  wikiRoot: string
  /**
   * F027 Phase 3 P20 Day 9-10 (AC-P3-10) — WikiServices 注入。
   *
   * 传 wikiServices → ingest commit endpoint 启用（preview → updateWiki 全链）。
   * 不传 → ingest commit endpoint 跳过注册（仅 preview endpoint 可用，Day 5 状态）。
   * server.ts boot 已 createWikiServices 后传入。
   */
  wikiServices?: WikiServices
  /**
   * F027 final-vision P1-2 · 共享 ingest services 注入（docs-watcher 也复用同一 PreviewStore）。
   *
   * 不传 → registerPhase3Routes 内部创建（向后兼容 standalone 测试 / 旧 caller）。
   * 传入 → server.ts boot 先创建（一份给 routes，一份给 DocsIngestRunner），同一 PreviewStore
   *        保证 docs-watcher 的 preview/commit 链能跨 service 命中（虽然 runner 内部 preview→commit
   *        在同一 instance，不依赖 cross-instance；但共享更易追踪状态）。
   */
  sharedIngestServices?: {
    previewStore: PreviewStore
    ingestPreview: IngestPreviewService
    ingestCommit?: IngestCommitService
  }
}

export function registerPhase3Routes(app: FastifyInstance, deps: Phase3RoutesDeps): void {
  const viewfinderService = new ViewfinderService({ db: deps.db, wikiRoot: deps.wikiRoot })
  const draftScanner = new DraftScanner({
    wikiRoot: deps.wikiRoot,
    logWarn: (obj, msg) => app.log.warn(obj, msg),
  })
  const promptInspector = new PromptInspectorService({ db: deps.db })
  const previewStore = deps.sharedIngestServices?.previewStore ?? new PreviewStore()
  const ingestPreview =
    deps.sharedIngestServices?.ingestPreview ?? new IngestPreviewService({ store: previewStore })
  const decisionService = new DecisionService({ db: deps.db })

  registerViewfinderRoute(app, viewfinderService)
  registerDraftsRoute(app, draftScanner)
  registerPromptInspectorRoute(app, promptInspector)
  registerIngestPreviewRoute(app, ingestPreview)
  registerDecisionsRoute(app, decisionService)
  // F027 v3 G6 · Wiki 哲学 UI 后端 (GET /api/wiki/story)
  registerWikiStoryRoute(app, new WikiStoryService({ db: deps.db }))

  // F027 Phase 3 P20 Day 9-10 (AC-P3-10) · commit endpoint 仅在 wikiServices 注入时启用
  if (deps.wikiServices) {
    const wikiServices = deps.wikiServices
    const commitService =
      deps.sharedIngestServices?.ingestCommit ??
      new IngestCommitService({
        store: previewStore,
        updateWiki: wikiServices.updateWiki,
        leases: wikiServices.leases,
        leaderTerm: () => wikiServices.leader.getCurrent()?.currentTerm ?? "0",
      })
    registerIngestCommitRoute(app, commitService)
  }
}

export { ViewfinderService, registerViewfinderRoute } from "./viewfinder"
export { DraftScanner, registerDraftsRoute } from "./drafts"
export { PromptInspectorService, registerPromptInspectorRoute } from "./prompt-inspector"
export { IngestPreviewService, registerIngestPreviewRoute } from "./ingest-preview"
export { DecisionService, registerDecisionsRoute } from "./decisions"
export { IngestCommitService, registerIngestCommitRoute } from "./ingest-commit"
export { PreviewStore } from "./preview-store"
export * from "./contracts"
export * from "./frontmatter"
