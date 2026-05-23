/**
 * F027 Phase 4 AC-P4-4 · POST /api/wiki/drafts/batch-promote
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-4 (line 215-218)
 *   - BatchPromoteService (packages/api/src/wiki/promote-audit/batch-promote-service.ts)
 *   - 单份 promote endpoint (./promote.ts) — 共用 validation + lease ttl
 *
 * Endpoint shape:
 *   body: {
 *     items: Array<{ srcDraftPath, destWikiPath }>,
 *     callerAlias, reason,
 *     taintedSourceFields?, sourceMessageIds?
 *   }
 *   resp 200 (含部分失败): {
 *     ok: true,
 *     total, success: [...], failed: [...]
 *   }
 *   resp 400: VALIDATION_ERROR (空 items / 重复 srcDraftPath / 超 MAX_BATCH_ITEMS / 缺字段)
 *   resp 500: INTERNAL_ERROR
 *
 * 部分失败语义:
 *   每份独立 lease + promote (continue-on-error)，
 *   即使全部失败 endpoint 仍返 200 + ok=true (业务上是 report，HTTP 不是 error)，
 *   caller 看 failed.length 判断是否需要 retry。
 */

import type { FastifyInstance } from "fastify"

import type { BatchPromoteItem, BatchPromoteService } from "../../wiki/promote-audit/batch-promote-service"

const MAX_BATCH_ITEMS = 50

export interface BatchPromoteRoutesDeps {
  batch: BatchPromoteService
}

type PostBatchPromoteBody = {
  items?: unknown
  callerAlias?: string
  reason?: string
  taintedSourceFields?: readonly string[]
  sourceMessageIds?: string[]
}

export function registerBatchPromoteRoutes(
  app: FastifyInstance,
  deps: BatchPromoteRoutesDeps,
): void {
  app.post("/api/wiki/drafts/batch-promote", async (request, reply) => {
    const body = (request.body ?? {}) as PostBatchPromoteBody
    const v = validateBatchBody(body)
    if (!v.ok) {
      reply.code(400)
      return { ok: false, code: "VALIDATION_ERROR", error: v.error }
    }

    try {
      const summary = deps.batch.batchPromote({
        items: v.items,
        callerAlias: v.callerAlias,
        reason: v.reason,
        taintedSourceFields: body.taintedSourceFields,
        sourceMessageIds: body.sourceMessageIds,
      })
      return {
        ok: true,
        total: summary.total,
        success: summary.success,
        failed: summary.failed,
      }
    } catch (err) {
      request.log.error({ err }, "POST /api/wiki/drafts/batch-promote threw")
      reply.code(500)
      return { ok: false, code: "INTERNAL_ERROR", error: (err as Error).message }
    }
  })
}

type ValidatedBatch =
  | {
      ok: true
      items: BatchPromoteItem[]
      callerAlias: string
      reason: string
    }
  | { ok: false; error: string }

function validateBatchBody(body: PostBatchPromoteBody): ValidatedBatch {
  if (typeof body.callerAlias !== "string" || body.callerAlias.length === 0) {
    return { ok: false, error: "callerAlias required" }
  }
  if (typeof body.reason !== "string" || body.reason.length === 0) {
    return { ok: false, error: "reason required (non-empty)" }
  }
  if (!Array.isArray(body.items)) {
    return { ok: false, error: "items must be an array" }
  }
  if (body.items.length === 0) {
    return { ok: false, error: "items must not be empty" }
  }
  if (body.items.length > MAX_BATCH_ITEMS) {
    return {
      ok: false,
      error: `items exceeds MAX_BATCH_ITEMS (${MAX_BATCH_ITEMS}), got ${body.items.length}`,
    }
  }

  const seenSrc = new Set<string>()
  const seenDest = new Set<string>()
  const items: BatchPromoteItem[] = []
  for (const [i, raw] of body.items.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: `items[${i}] must be an object` }
    }
    const item = raw as Partial<BatchPromoteItem>
    if (typeof item.srcDraftPath !== "string" || item.srcDraftPath.length === 0) {
      return { ok: false, error: `items[${i}].srcDraftPath required` }
    }
    if (typeof item.destWikiPath !== "string" || item.destWikiPath.length === 0) {
      return { ok: false, error: `items[${i}].destWikiPath required` }
    }
    if (seenSrc.has(item.srcDraftPath)) {
      return { ok: false, error: `items[${i}].srcDraftPath duplicated: ${item.srcDraftPath}` }
    }
    if (seenDest.has(item.destWikiPath)) {
      return { ok: false, error: `items[${i}].destWikiPath duplicated: ${item.destWikiPath}` }
    }
    seenSrc.add(item.srcDraftPath)
    seenDest.add(item.destWikiPath)
    items.push({ srcDraftPath: item.srcDraftPath, destWikiPath: item.destWikiPath })
  }

  return {
    ok: true,
    items,
    callerAlias: body.callerAlias,
    reason: body.reason,
  }
}
