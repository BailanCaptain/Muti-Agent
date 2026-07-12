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

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"
import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import { WikiPathInvalidError, readContainedFile, safeWikiPath } from "../../wiki/path-containment"
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
  events: WikiEventsRepository
  wikiRoot: string
  /** Compiler Leader Lease term (caller 注入, default '999')。 */
  leaderTerm: () => string
  /** Lease TTL (测试用; 默认 30s)。 */
  promoteLeaseTtlSeconds?: number
  /** 德彪 r1 P1-4 · promote 成功（含 supersede/replace）后踢索引收敛（5s debounce reindex）。 */
  onWikiMutated?: () => void
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
  /** dest_exists 替换补丁：true = dest 已存在时归档旧页后覆盖（见 PromoteRequest.allowReplace）。 */
  allowReplace?: boolean
  /** 德彪 replace-r1 P1 · CAS 闸：allowReplace 时必填——对比面板看到的现有页 contentHash。 */
  expectedDestHash?: string
  /** F042 AC3 · 同源撞车显式取代：SAME_SOURCE_EXISTS 返回的 conflicts 中用户确认取代的路径。 */
  supersedePaths?: string[]
}

/**
 * dest_exists 替换补丁 · GET /api/wiki/page/content 的读取围栏：只读正式区四桶 +
 * feedback/work（与 PromoteModal ALLOWED_DEST_PREFIXES 同口径），draft/_rejected/
 * _superseded/warnings/index 一律不经此端点（各有专用端点或不该被 UI 裸读）。
 */
const FORMAL_PAGE_PREFIXES = [
  "wiki/concepts/",
  "wiki/rules/",
  "wiki/methods/",
  "wiki/people/",
  "wiki/feedback/",
  "wiki/work/",
] as const

export function registerPromoteRoutes(app: FastifyInstance, deps: PromoteRoutesDeps): void {
  const ttl = deps.promoteLeaseTtlSeconds ?? DEFAULT_PROMOTE_LEASE_TTL_SECONDS

  app.get("/api/wiki/drafts/partial-supersedes", async () => {
    const resolutions = new Set(
      deps.events
        .getByAction("supersede_resolution", 1_000)
        .map((event) => parseResolutionEventId(event.path))
        .filter((id): id is number => id !== null),
    )
    const failures = deps.events
      .getByState("aborted", 1_000)
      .filter((event) => event.action === "supersede" && !resolutions.has(event.id))
      .filter((event) => {
        const laterResolution = deps.events
          .getByPath(event.path, 100)
          .some(
            (candidate) =>
              candidate.id > event.id &&
              candidate.state === "committed" &&
              (candidate.action === "demote" || candidate.action === "supersede"),
          )
        if (laterResolution) return false
        try {
          return fs.existsSync(safeWikiPath(deps.wikiRoot, event.path))
        } catch {
          return false
        }
      })
      .map((event) => ({
        eventId: event.id,
        path: event.path,
        promotionTarget: event.promotionTarget ?? "",
        error: event.error ?? "supersede failed",
      }))
    return { ok: true, failures }
  })

  app.post("/api/wiki/drafts/partial-supersedes/resolve", async (request, reply) => {
    const body = (request.body ?? {}) as {
      failureEventId?: number
      callerAlias?: string
      resolution?: string
    }
    if (
      !Number.isInteger(body.failureEventId) ||
      (body.failureEventId ?? 0) <= 0 ||
      typeof body.callerAlias !== "string" ||
      body.callerAlias.length === 0 ||
      body.resolution !== "dismissed"
    ) {
      reply.code(400)
      return { ok: false, code: "VALIDATION_ERROR", error: "invalid resolution request" }
    }
    const failureEventId = body.failureEventId as number
    const failed = deps.events.get(failureEventId)
    if (!failed || failed.action !== "supersede" || failed.state !== "aborted") {
      reply.code(404)
      return { ok: false, code: "FAILURE_NOT_FOUND", error: "supersede failure not found" }
    }
    const resolutionPath = resolutionEventPath(failureEventId)
    const existing = deps.events.getByPath(resolutionPath, 1)[0]
    if (existing?.state === "committed") return { ok: true, eventId: existing.id }

    const attemptedHash = crypto
      .createHash("sha256")
      .update(`${failureEventId}:dismissed`, "utf-8")
      .digest("hex")
    const event = deps.events.appendPending({
      ts: new Date().toISOString(),
      alias: body.callerAlias,
      action: "supersede_resolution",
      path: resolutionPath,
      attemptedHash,
      promotionTarget: failed.promotionTarget,
      reason: "dismissed",
      fencingToken: failed.fencingToken,
      leaderTerm: deps.leaderTerm(),
    })
    deps.events.commit(event.id, { contentHash: attemptedHash })
    return { ok: true, eventId: event.id }
  })

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
        allowReplace: validation.body.allowReplace,
        expectedDestHash: validation.body.expectedDestHash,
        supersedePaths: validation.body.supersedePaths,
      })

      switch (result.status) {
        case "ok":
          // 德彪 r1 P1-4 · 落盘成功（promote 本体 + 可能的 supersede/replace 归档）→ 踢
          // 索引收敛：不踢则召回面/同源检测最多滞后 5min 周期安全网（fail-soft 不阻响应）。
          try {
            deps.onWikiMutated?.()
          } catch {
            // 通知失败不影响 promote 结果——周期安全网兜底
          }
          return {
            ok: true,
            finalPath: result.finalPath,
            eventId: result.eventId,
            replacedArchivePath: result.replacedArchivePath,
            supersededPaths: result.supersededPaths,
            supersedeFailures: result.supersedeFailures,
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
        case "dest_conflict":
          reply.code(409)
          return { ok: false, code: "DEST_CONFLICT", error: result.error }
        case "same_source_exists":
          // F042 AC3 · 双胞胎撞车：前端弹同源对比面板（取代 / 去合并二选一）
          reply.code(409)
          return {
            ok: false,
            code: "SAME_SOURCE_EXISTS",
            conflicts: result.sameSourceConflicts,
            error: result.error,
          }
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

  // dest_exists 替换补丁 · GET /api/wiki/page/content?path=<正式区路径> —— 替换前对比现有页。
  // 围栏与 drafts/content 同款三道（家规 list/read 同 containment）：
  //   ① safeWikiPath（防 ../ 逃逸 / NUL / 绝对路径）② 收窄到正式区白名单前缀 + 拒 draft/ADS/非 .md
  //   ③ readContainedFile 真实路径 containment（防 symlink/junction/hardlink 跟随逃逸）
  app.get("/api/wiki/page/content", async (request, reply) => {
    const { path: pagePath } = request.query as { path?: string }
    if (typeof pagePath !== "string" || pagePath.length === 0) {
      reply.code(400)
      return { ok: false, error: "VALIDATION_FAILED", message: "query param 'path' is required" }
    }
    try {
      let abs: string
      try {
        abs = safeWikiPath(deps.wikiRoot, pagePath)
      } catch (err) {
        if (err instanceof WikiPathInvalidError) {
          reply.code(400)
          return { ok: false, error: "PATH_INVALID", message: err.message }
        }
        throw err
      }
      // NTFS ADS（`x.md:stream.md`）+ 非 .md + draft/归档区拒（与 drafts readContent 同口径）
      if (pagePath.includes(":")) {
        reply.code(400)
        return {
          ok: false,
          error: "PATH_INVALID",
          message: `path must not contain ':': ${pagePath}`,
        }
      }
      if (!abs.toLowerCase().endsWith(".md")) {
        reply.code(400)
        return { ok: false, error: "PATH_INVALID", message: `only .md is readable: ${pagePath}` }
      }
      const normalized = path.posix.normalize(pagePath.replace(/\\/g, "/")).toLowerCase()
      const inFormalBucket = FORMAL_PAGE_PREFIXES.some((p) => normalized.startsWith(p))
      // 德彪 replace-r1 P3：拒**任意路径段**的归档区（wiki/concepts/_rejected/x.md 会过
      // formal 前缀检查）——对齐 demote 的 isInRejectedBin 语义，_superseded 同口径。
      const inArchiveBin =
        normalized.includes("/_rejected/") || normalized.includes("/_superseded/")
      if (!inFormalBucket || inArchiveBin || isDraftRelativePath(normalized)) {
        reply.code(400)
        return {
          ok: false,
          error: "PATH_INVALID",
          message: `path must be a formal wiki page under ${FORMAL_PAGE_PREFIXES.join("/")} (non-draft/non-archive): ${pagePath}`,
        }
      }
      // 词法子树快速失败 + 真实路径 containment（防 symlink 逃逸），root = <wikiRoot>/wiki
      const formalRoot = path.resolve(deps.wikiRoot, "wiki")
      const formalRootSep = formalRoot.endsWith(path.sep) ? formalRoot : formalRoot + path.sep
      if (!abs.startsWith(formalRootSep)) {
        reply.code(400)
        return {
          ok: false,
          error: "PATH_INVALID",
          message: `path not under wiki root: ${pagePath}`,
        }
      }
      const result = await readContainedFile(abs, formalRoot)
      if (!result) {
        reply.code(404)
        return { ok: false, error: "NOT_FOUND", message: "wiki page not found" }
      }
      // 德彪 replace-r1 P1 · contentHash 给对比面板做 CAS：替换请求带回 expectedDestHash，
      // 服务端校验「替换的就是用户看过的这一版」。
      return {
        ...result,
        contentHash: crypto.createHash("sha256").update(result.content, "utf-8").digest("hex"),
      }
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        reply.code(400)
        return { ok: false, error: "PATH_INVALID", message: err.message }
      }
      request.log.error({ err }, "GET /api/wiki/page/content threw")
      reply.code(500)
      return { ok: false, error: "INTERNAL_ERROR", message: (err as Error).message }
    }
  })
}

const SUPERSEDE_RESOLUTION_PREFIX = "audit/supersede-resolution/"

function resolutionEventPath(failureEventId: number): string {
  return `${SUPERSEDE_RESOLUTION_PREFIX}${failureEventId}`
}

function parseResolutionEventId(eventPath: string): number | null {
  if (!eventPath.startsWith(SUPERSEDE_RESOLUTION_PREFIX)) return null
  const id = Number(eventPath.slice(SUPERSEDE_RESOLUTION_PREFIX.length))
  return Number.isInteger(id) && id > 0 ? id : null
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
        allowReplace?: boolean
        expectedDestHash?: string
        supersedePaths?: string[]
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
  // 替换是破坏性升级动作：只接受严格 boolean，truthy 字符串/数字一律拒（防误触发归档覆盖）。
  if (body.allowReplace !== undefined && typeof body.allowReplace !== "boolean") {
    return { ok: false, error: "allowReplace 必须是 boolean" }
  }
  // 德彪 replace-r1 P1 · CAS 闸在 API 面就闭合：allowReplace 必带对比面板的现有页哈希
  // （sha256 hex），没对过 diff 的调用方拿不到 → 无盲替换入口。
  if (body.allowReplace === true) {
    if (
      typeof body.expectedDestHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.expectedDestHash)
    ) {
      return {
        ok: false,
        error: "allowReplace 需要 expectedDestHash（sha256 hex，来自 page/content 对比）",
      }
    }
  }
  // F042 AC3 · supersedePaths 是破坏性确认（旧条目归档），只接受字符串数组
  if (
    body.supersedePaths !== undefined &&
    (!Array.isArray(body.supersedePaths) ||
      body.supersedePaths.some((p) => typeof p !== "string" || p.length === 0))
  ) {
    return { ok: false, error: "supersedePaths 必须是非空字符串数组" }
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
      allowReplace: body.allowReplace,
      expectedDestHash: body.expectedDestHash,
      supersedePaths: body.supersedePaths,
    },
  }
}
