/**
 * F027 Phase 3 P20 · routes/phase3 barrel — registerPhase3Routes 集中入口
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 1
 *
 * server.ts 末尾调一次 `registerPhase3Routes(app, deps)` 注册所有 Phase 3 endpoint。
 *
 * Week 1 已 wire：
 *   - GET /api/rooms/:id/viewfinder   (Day 3)
 *   - GET /api/wiki/drafts            (Day 3)
 *
 * 后续 Day 4-10 实施时加 registerXxxRoute 调用 — 一行 wire 不污染 server.ts。
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import type { FastifyInstance } from "fastify"
import type * as schema from "../../db/schema"
import { DecisionService, registerDecisionsRoute } from "./decisions"
import { DraftScanner, registerDraftsRoute } from "./drafts"
import { IngestPreviewService, registerIngestPreviewRoute } from "./ingest-preview"
import { PromptInspectorService, registerPromptInspectorRoute } from "./prompt-inspector"
import { ViewfinderService, registerViewfinderRoute } from "./viewfinder"

type DrizzleDb = BetterSQLite3Database<typeof schema>

export interface Phase3RoutesDeps {
  db: DrizzleDb
  wikiRoot: string
}

export function registerPhase3Routes(app: FastifyInstance, deps: Phase3RoutesDeps): void {
  const viewfinderService = new ViewfinderService({ db: deps.db, wikiRoot: deps.wikiRoot })
  const draftScanner = new DraftScanner({
    wikiRoot: deps.wikiRoot,
    logWarn: (obj, msg) => app.log.warn(obj, msg),
  })
  const promptInspector = new PromptInspectorService({ db: deps.db })
  const ingestPreview = new IngestPreviewService()
  const decisionService = new DecisionService({ db: deps.db })

  registerViewfinderRoute(app, viewfinderService)
  registerDraftsRoute(app, draftScanner)
  registerPromptInspectorRoute(app, promptInspector)
  registerIngestPreviewRoute(app, ingestPreview)
  registerDecisionsRoute(app, decisionService)
}

export {
  ViewfinderService,
  registerViewfinderRoute,
} from "./viewfinder"
export { DraftScanner, registerDraftsRoute } from "./drafts"
export {
  PromptInspectorService,
  registerPromptInspectorRoute,
} from "./prompt-inspector"
export {
  IngestPreviewService,
  registerIngestPreviewRoute,
} from "./ingest-preview"
export { DecisionService, registerDecisionsRoute } from "./decisions"
export * from "./contracts"
export * from "./frontmatter"
