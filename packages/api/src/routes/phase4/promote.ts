/**
 * F027 Phase 4 AC-P4-1 · POST /api/wiki/drafts/promote(/preview) routes
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-1 / AC-P4-2
 *   - PromoteWikiService (packages/api/src/wiki/promote-audit/promote-wiki-service.ts)
 *   - Phase 3 ingest-commit endpoint pattern (packages/api/src/routes/phase3/ingest-commit.ts)
 *
 * 两个 endpoint:
 *   - POST /api/wiki/drafts/promote/preview — 结构层 audit only (frontend mount 时调，禁用 [Promote] 按钮 if reject)
 *     body: { srcDraftPath, taintedSourceFields? }
 *     resp 200: V14PromoteAuditResult { passed, rejectReason? }
 *     resp 400/404: src path invalid / not found
 *     【posture C · 设计审 critique P1】preview 只跑 auditStructural（结构标记 + tainted 直引 +
 *       豁免 sanitize 复检，确定性、0 LLM）——不每次挂载/列表渲染就烧 LLM。权威 LLM 语义判官
 *       只在真 promote/batch 跑（见下方 promote endpoint）。结构层 pass = 按钮放行，最终语义裁决
 *       在转正时做（可能 422 llm_semantic_injection，前端按 reject hint 提示改写/重试）。
 *
 *   - POST /api/wiki/drafts/promote — full V14 + mv + wiki_events
 *     body: { srcDraftPath, destWikiPath, callerAlias, reason, taintedSourceFields?, sourceMessageIds? }
 *     endpoint 内部 acquireLease + service.promote + releaseLease (try/finally)
 *     resp 200: { ok: true, finalPath, eventId }
 *     resp 422: { ok: false, audit: { layer, matchedPatterns, hint } } (AC-P4-2 reject)
 *     resp 4xx/5xx: { ok: false, error, code }
 *
 * Lease 处理 (跟 ingest-commit 一致):
 *   endpoint 自己 acquire (caller 不传 fencingToken) — client UX 简化
 *   service.promote() 完后 releaseLease (try/finally 确保不留 lease)
 */

import type { FastifyInstance } from "fastify"

import fs from "node:fs"
import type { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"
import { WikiPathInvalidError, safeWikiPath } from "../../wiki/path-containment"
import { checkExemptionSanitizeBlocked } from "../../wiki/promote-audit/exemption-tainted-fields"
import type { PromoteWikiService } from "../../wiki/promote-audit/promote-wiki-service"
import {
  isDraftRelativePath,
  isSupersededDraftRelativePath,
} from "../../wiki/promote-audit/promote-wiki-service"
import type { V14PromoteAuditService } from "../../wiki/promote-audit/v14-promote-audit-service"
import { INVALID_TAINTED, normalizeTaintedSourceFields } from "./tainted-source-validation"

// 德彪 r1 P1：lease 在 LLM 判官跑之前 acquire、判官后才 isCurrent 校验 → TTL 必须覆盖判官最坏耗时。
// 后台化补丁德彪 r1 P2：audit 对 judge_parse_failed 自动重试一次 → 最坏 = 2×(primary 60s +
// fallback 60s) = 240s，150s 会出现「审计安全通过却 LEASE_FENCING_FAILED」。留 60s 余量取 300s。
// promote 是人工唯一-dest 动作，长租无并发代价。
const DEFAULT_PROMOTE_LEASE_TTL_SECONDS = 300

export interface PromoteRoutesDeps {
  promote: PromoteWikiService
  audit: V14PromoteAuditService
  leases: WikiLeasesRepository
  wikiRoot: string
  /** Compiler Leader Lease term (caller 注入, default '999')。 */
  leaderTerm: () => string
  /** Lease TTL (测试用; 默认 30s)。 */
  promoteLeaseTtlSeconds?: number
}

type PostPromotePreviewBody = {
  srcDraftPath?: string
  taintedSourceFields?: readonly string[]
}

type PostPromoteBody = {
  srcDraftPath?: string
  destWikiPath?: string
  callerAlias?: string
  reason?: string
  taintedSourceFields?: readonly string[]
  sourceMessageIds?: string[]
}

export function registerPromoteRoutes(app: FastifyInstance, deps: PromoteRoutesDeps): void {
  const ttl = deps.promoteLeaseTtlSeconds ?? DEFAULT_PROMOTE_LEASE_TTL_SECONDS

  app.post("/api/wiki/drafts/promote/preview", async (request, reply) => {
    const body = (request.body ?? {}) as PostPromotePreviewBody
    if (typeof body.srcDraftPath !== "string" || body.srcDraftPath.length === 0) {
      reply.code(400)
      return { ok: false, code: "VALIDATION_ERROR", error: "srcDraftPath required" }
    }

    // codex r2 P2-1 修: path containment + draft 校验，防 caller 传 '../' 或绝对路径越界读
    let absSrcPath: string
    try {
      absSrcPath = safeWikiPath(deps.wikiRoot, body.srcDraftPath)
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        reply.code(400)
        return { ok: false, code: "PATH_INVALID", error: err.message }
      }
      throw err
    }
    if (!isDraftRelativePath(body.srcDraftPath)) {
      reply.code(400)
      return {
        ok: false,
        code: "PATH_INVALID",
        error: `src must be a draft path (contain '/draft/' or '/_drafts/'), got: ${body.srcDraftPath}`,
      }
    }
    // 德彪 wiki-ux r1 P2 · 归档版本 preview 同口径拒绝（与 service.promote 一致，防体验割裂）
    if (isSupersededDraftRelativePath(body.srcDraftPath)) {
      reply.code(400)
      return {
        ok: false,
        code: "PATH_INVALID",
        error: `src is a superseded (archived) draft — preview/promote the newest same-source draft instead, got: ${body.srcDraftPath}`,
      }
    }

    let srcContent: string
    try {
      srcContent = fs.readFileSync(absSrcPath, "utf-8")
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === "ENOENT") {
        reply.code(404)
        return {
          ok: false,
          code: "SRC_NOT_FOUND",
          error: `src draft not found: ${body.srcDraftPath}`,
        }
      }
      request.log.error({ err }, "promote preview readFile failed")
      reply.code(500)
      return { ok: false, code: "INTERNAL_ERROR", error: (err as Error).message }
    }

    // 德彪 r2 P2 · taintedSourceFields 运行时校验(传非 string[] → 400,防 spread/for-of 抛 500)。
    const tainted = normalizeTaintedSourceFields(body.taintedSourceFields)
    if (tainted === INVALID_TAINTED) {
      reply.code(400)
      return { ok: false, code: "VALIDATION_ERROR", error: "taintedSourceFields 必须是字符串数组" }
    }
    // 德彪 r3 P1 · 与 service.promote 同口径:豁免文档 preview 也跑 sanitize blocked 复检,
    // 仍 blocked → audit.passed=false(否则前端 preview 显示 pass、真 promote 被拒,体验割裂)。
    const exemptionCheck = checkExemptionSanitizeBlocked(srcContent)
    if (exemptionCheck.blocked) {
      return {
        ok: true,
        audit: {
          passed: false,
          rejectReason: {
            layer: "exemption_sanitize_blocked",
            matchedPatterns: exemptionCheck.reasons,
            hint: "人审豁免文档复检仍触发 sanitize 红线，需人工改写 draft 去除危险内容后再转正。",
          },
        },
      }
    }
    // 结构层 only（确定性、0 LLM）：preview 即时禁用判断，权威 LLM 判官留真 promote 跑
    const result = deps.audit.auditStructural({
      body: srcContent,
      taintedSourceFields: tainted,
    })
    return { ok: true, audit: result }
  })

  app.post("/api/wiki/drafts/promote", async (request, reply) => {
    const body = (request.body ?? {}) as PostPromoteBody
    const validation = validatePromoteBody(body)
    if (!validation.ok) {
      reply.code(400)
      return { ok: false, code: "VALIDATION_ERROR", error: validation.error }
    }

    // acquire lease for dest path
    const acquired = deps.leases.acquireLease({
      path: validation.body.destWikiPath,
      ownerAlias: validation.body.callerAlias,
      ttlSeconds: ttl,
      leaderTerm: deps.leaderTerm(),
    })
    if (!acquired) {
      reply.code(409)
      return {
        ok: false,
        code: "LEASE_HELD",
        error: `dest path lease held by another owner: ${validation.body.destWikiPath}`,
      }
    }

    try {
      const result = await deps.promote.promote({
        srcDraftPath: validation.body.srcDraftPath,
        destWikiPath: validation.body.destWikiPath,
        callerAlias: validation.body.callerAlias,
        reason: validation.body.reason,
        fencingToken: acquired.fencingToken,
        taintedSourceFields: validation.body.taintedSourceFields,
        sourceMessageIds: validation.body.sourceMessageIds,
      })

      switch (result.status) {
        case "ok":
          return {
            ok: true,
            finalPath: result.finalPath,
            eventId: result.eventId,
          }
        case "audit_rejected":
          reply.code(422)
          return {
            ok: false,
            code: "AUDIT_REJECTED",
            audit: result.auditReject,
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
      // release lease — 不管 promote 成功/失败/抛错都 release (除非 promote ok 时 service 已隐式持有
      // — 但 PromoteWikiService 不 release，所以这里负责所有 path 的 release)
      deps.leases.releaseLease({
        path: validation.body.destWikiPath,
        fencingToken: acquired.fencingToken,
      })
    }
  })
}

type ValidatedPromote =
  | {
      ok: true
      body: {
        srcDraftPath: string
        destWikiPath: string
        callerAlias: string
        reason: string
        taintedSourceFields?: readonly string[]
        sourceMessageIds?: string[]
      }
    }
  | { ok: false; error: string }

function validatePromoteBody(body: PostPromoteBody): ValidatedPromote {
  if (typeof body.srcDraftPath !== "string" || body.srcDraftPath.length === 0) {
    return { ok: false, error: "srcDraftPath required" }
  }
  if (typeof body.destWikiPath !== "string" || body.destWikiPath.length === 0) {
    return { ok: false, error: "destWikiPath required" }
  }
  if (typeof body.callerAlias !== "string" || body.callerAlias.length === 0) {
    return { ok: false, error: "callerAlias required" }
  }
  if (typeof body.reason !== "string" || body.reason.length === 0) {
    return { ok: false, error: "reason required (non-empty)" }
  }
  // 德彪 r2 P2 · taintedSourceFields 运行时校验(非 string[] → 拒;service union 前必须确定是数组)。
  const tainted = normalizeTaintedSourceFields(body.taintedSourceFields)
  if (tainted === INVALID_TAINTED) {
    return { ok: false, error: "taintedSourceFields 必须是字符串数组" }
  }
  return {
    ok: true,
    body: {
      srcDraftPath: body.srcDraftPath,
      destWikiPath: body.destWikiPath,
      callerAlias: body.callerAlias,
      reason: body.reason,
      taintedSourceFields: tainted,
      sourceMessageIds: body.sourceMessageIds,
    },
  }
}
