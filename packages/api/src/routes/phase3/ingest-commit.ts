/**
 * F027 Phase 3 P20 · POST /api/wiki/ingest/commit — Week 2 Day 9-10 (AC-P3-10)
 *
 * 真相源：docs/plans/F027-phase3-implementation-plan.md §3 Week 2 Day 9-10
 *   + Phase 1 UpdateWikiService (packages/api/src/wiki/update-wiki-service.ts)
 *   + contracts.ts §7 PostIngestCommitBody / PostIngestCommitResponse
 *
 * 数据流：
 *   1. preview endpoint (Day 5) 已落 sanitizedContent + previewId 到 PreviewStore
 *   2. 本 endpoint 接 previewId → take store → 派生 finalPath →
 *      acquireLease (caller 没传 leaseToken) → updateWiki.updateWiki({path, action:'write',
 *      baseHash:null, content, fencingToken}) → 映射 status 到 HTTP error/200
 *   3. updateWiki 内部：ACL → lease.isCurrent → CAS → PREPARE wiki_events
 *      → final-CAS → atomic-write → COMMIT wiki_events → release lease（一气呵成）
 *
 * E2E 验收（plan v3.1 §4 AC-P3-10 字面）：
 *   - preview 不落盘 (Day 5 ingest-preview.ts 不写文件，已满足)
 *   - commit 才落盘 (本 endpoint 调 updateWiki 走 atomic-write)
 *   - 失败不产生 wiki_events 提交行（updateWiki 抛 error 时 abort pending row，不留 committed）
 *
 * action 选 'write'：
 *   - V16.5 chap 5 'ingest' enum 存在但 update-wiki-service computeAttempted 返
 *     'not_implemented'（line 250-252）
 *   - 'write' = 全量覆盖语义 = preview 已 sanitize 后的 sanitizedContent 直接落
 *   - baseHash=null = 期望新文件（同名撞 → status='conflict' → HTTP 409 LEASE_FENCING_FAILED）
 *
 * 不做（Day 9-10 范围外）：
 *   - 不扩 update-wiki-service 给 'ingest' action 真实现（plan 字面"复用 update_wiki"，复用即 'write'）
 *   - 不接 LLM compile-pipeline（preview 已 sanitize，commit 不再 LLM 编译；Phase 4 接真 LLM 时再加）
 *   - 不写 prompt_audit（Day 8 b 是 A2A prompt 拼装路径；ingest commit 是独立写盘动作）
 *   - 不做 retry/CAS reconcile（status='conflict' 直接返 409，让 client 改名 重新 preview/commit）
 */

import * as path from "node:path"
import type { FastifyInstance } from "fastify"
import type { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"
import type { UpdateWikiResponse, UpdateWikiService } from "../../wiki/update-wiki-service"
import {
  ErrorCode,
  HTTP_STATUS_BY_ERROR,
  type PostIngestCommitBody,
  type PostIngestCommitResponse,
  toErrorResponse,
  validatePostIngestCommit,
} from "./contracts"
import type { PreviewStore } from "./preview-store"

/** 默认 lease TTL（commit endpoint 自己 acquire 时用，足以跑完 updateWiki 同步 path）。 */
const DEFAULT_COMMIT_LEASE_TTL_SECONDS = 30

/** 落盘目录约定：wiki/concepts/draft/_auto/<filename>（V16.5 chap 7 raw drop + ACL default）。 */
const TARGET_DRAFT_DIR = "wiki/concepts/draft/_auto"

export interface IngestCommitServiceDeps {
  store: PreviewStore
  updateWiki: UpdateWikiService
  leases: WikiLeasesRepository
  /** Compiler Leader Lease term 派生（同 update-wiki-service 一致；caller 注入）。 */
  leaderTerm: () => string
  /** 注入 clock（测试 deterministic 用；默认 () => new Date()）。 */
  clock?: () => Date
  /** 注入 commit lease TTL（测试用；默认 30s）。 */
  commitLeaseTtlSeconds?: number
}

export class IngestCommitService {
  private readonly store: PreviewStore
  private readonly updateWiki: UpdateWikiService
  private readonly leases: WikiLeasesRepository
  private readonly leaderTerm: () => string
  private readonly clock: () => Date
  private readonly commitLeaseTtlSeconds: number

  constructor(deps: IngestCommitServiceDeps) {
    this.store = deps.store
    this.updateWiki = deps.updateWiki
    this.leases = deps.leases
    this.leaderTerm = deps.leaderTerm
    this.clock = deps.clock ?? (() => new Date())
    this.commitLeaseTtlSeconds = deps.commitLeaseTtlSeconds ?? DEFAULT_COMMIT_LEASE_TTL_SECONDS
  }

  commit(body: PostIngestCommitBody): CommitResult {
    // 1. 取 preview entry（一次性消费）
    const taken = this.store.take(body.previewId)
    if (taken.entry === null) {
      return {
        ok: false,
        httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.DRAFT_NOT_FOUND],
        error: {
          code: ErrorCode.DRAFT_NOT_FOUND,
          message:
            taken.reason === "expired"
              ? `previewId ${body.previewId} expired`
              : `previewId ${body.previewId} not found (already consumed or never existed)`,
          detail: { reason: taken.reason, previewId: body.previewId },
        },
      }
    }
    const entry = taken.entry

    // 2. 派生 finalPath（落 wiki/concepts/draft/_auto/<filename>）
    const finalPath = derivePath(entry.sourcePath)

    // 3. acquire lease（caller 没传 leaseToken 时由 server 兜底 acquire；
    //    传了的话 Day 9-10 范围下还是再 acquire 一次 — caller 传的 token 当前没
    //    用作"持有 lease" 验证 hint，留 Phase 4 接 long-running lease 场景再设计）
    const lease = this.leases.acquireLease({
      path: finalPath,
      ownerAlias: body.callerAlias,
      ttlSeconds: this.commitLeaseTtlSeconds,
      leaderTerm: this.leaderTerm(),
      now: this.clock().toISOString(),
    })
    if (!lease) {
      return {
        ok: false,
        httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.LEASE_FENCING_FAILED],
        error: {
          code: ErrorCode.LEASE_FENCING_FAILED,
          message: `lease held by another writer on ${finalPath}`,
          detail: { reason: "lease_held", finalPath },
        },
      }
    }

    // 4. 调 updateWiki 走完整 ACL / CAS / PREPARE / final-CAS / atomic-write / COMMIT
    const response = this.updateWiki.updateWiki(
      {
        path: finalPath,
        action: "write",
        baseHash: null, // 新文件（撞名 → status=conflict）
        content: entry.sanitizedContent,
        fencingToken: lease.fencingToken,
        reason: `ingest_commit previewId=${body.previewId} mime=${entry.mimeType}${entry.targetType ? ` targetType=${entry.targetType}` : ""}`,
        sourceMessageIds: undefined,
      },
      { alias: body.callerAlias, isServiceIdentity: false },
    )

    return this.mapUpdateWikiResponse(response, finalPath, lease.fencingToken)
  }

  private mapUpdateWikiResponse(
    res: UpdateWikiResponse,
    finalPath: string,
    fencingToken: string,
  ): CommitResult {
    switch (res.status) {
      case "ok": {
        const eventId = res.eventId ?? 0
        return {
          ok: true,
          response: {
            ingestEventId: String(eventId),
            finalPath,
            committedAt: this.clock().toISOString(),
            fencingToken,
          },
        }
      }
      case "denied_acl":
        return {
          ok: false,
          httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.UNAUTHORIZED],
          error: {
            code: ErrorCode.UNAUTHORIZED,
            message: res.error ?? "denied by ACL",
            detail: { reason: "denied_acl", finalPath },
          },
        }
      case "conflict":
        return {
          ok: false,
          httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.LEASE_FENCING_FAILED],
          error: {
            code: ErrorCode.LEASE_FENCING_FAILED,
            message: res.error ?? "CAS conflict (file exists with different hash)",
            detail: { reason: "conflict", finalPath, currentHash: res.currentHash },
          },
        }
      case "lease_expired":
      case "stale_token":
        return {
          ok: false,
          httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.LEASE_FENCING_FAILED],
          error: {
            code: ErrorCode.LEASE_FENCING_FAILED,
            message: res.error ?? `lease ${res.status}`,
            detail: { reason: res.status, finalPath },
          },
        }
      case "path_invalid":
        return {
          ok: false,
          httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.VALIDATION_FAILED],
          error: {
            code: ErrorCode.VALIDATION_FAILED,
            message: res.error ?? "path invalid",
            detail: { reason: "path_invalid", finalPath },
          },
        }
      case "schema_invalid":
        return {
          ok: false,
          httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.VALIDATION_FAILED],
          error: {
            code: ErrorCode.VALIDATION_FAILED,
            message: res.error ?? "schema invalid",
            detail: { reason: "schema_invalid", finalPath },
          },
        }
      case "not_implemented":
      case "internal":
        return {
          ok: false,
          httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR],
          error: {
            code: ErrorCode.INTERNAL_ERROR,
            message: res.error ?? `updateWiki ${res.status}`,
            detail: { reason: res.status, finalPath },
          },
        }
      default: {
        const exhaustive: never = res.status
        return {
          ok: false,
          httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR],
          error: {
            code: ErrorCode.INTERNAL_ERROR,
            message: `unknown updateWiki status: ${exhaustive}`,
            detail: { finalPath },
          },
        }
      }
    }
  }
}

export type CommitResult =
  | { ok: true; response: PostIngestCommitResponse }
  | {
      ok: false
      httpStatus: number
      error: {
        code: ErrorCode
        message: string
        detail?: Record<string, unknown>
      }
    }

/**
 * 把 sourcePath 派生成 wiki 内 final path。
 *
 * 约定（V16.5 chap 7 raw drop + ACL `wiki/concepts/draft/**`）:
 *   - basename(sourcePath) → filename（去掉 dir）
 *   - 缺 .md / .txt 后缀 → 补 .md（commit 始终落 markdown 文件）
 *   - 最终路径：wiki/concepts/draft/_auto/<filename>
 *
 * 不做 timestamp 前缀（让 client 自己保证 basename 唯一；撞名走 CAS conflict 错误）。
 */
function derivePath(sourcePath: string): string {
  const basenameRaw = path.basename(sourcePath) || sourcePath.replace(/[\\/]/g, "_")
  let filename = basenameRaw
  if (!/\.(md|txt)$/i.test(filename)) {
    filename = `${filename}.md`
  }
  return `${TARGET_DRAFT_DIR}/${filename}`
}

// ─── Route registration ────────────────────────────────────────────

export function registerIngestCommitRoute(
  app: FastifyInstance,
  service: IngestCommitService,
): void {
  app.post("/api/wiki/ingest/commit", async (request, reply) => {
    const validation = validatePostIngestCommit(request.body)
    if (!validation.ok) {
      reply.code(HTTP_STATUS_BY_ERROR[validation.error])
      return toErrorResponse(validation)
    }
    try {
      const result = service.commit(validation.value)
      if (result.ok) {
        return result.response
      }
      reply.code(result.httpStatus)
      return {
        error: result.error.code,
        message: result.error.message,
        detail: result.error.detail,
      }
    } catch (err) {
      request.log.error({ err }, "POST /api/wiki/ingest/commit threw")
      reply.code(HTTP_STATUS_BY_ERROR[ErrorCode.INTERNAL_ERROR])
      return toErrorResponse({
        ok: false,
        error: ErrorCode.INTERNAL_ERROR,
        message: (err as Error).message,
      })
    }
  })
}

// Type re-export
export type { PostIngestCommitBody, PostIngestCommitResponse }
