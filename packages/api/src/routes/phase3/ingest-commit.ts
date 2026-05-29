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
 *   - commit 不重跑 LLM 编译：F027 v3 G11 已接通真编译，但编译在 preview 阶段做（产物存
 *     PreviewStore.compiledMarkdown），commit 直接落盘该产物（见下方 finalContent 取 compiledMarkdown）；
 *     preview 未编译 / 编译失败兜底时 commit 退回 raw sanitizedContent。
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

/**
 * F027 final-vision P1-2 r2 修：commit() 第二参 (internal use 给 docs-watcher caller)。
 * HTTP route 不传；DocsIngestRunner 直接 service-call 时传 versioned path 避免撞名。
 */
export interface CommitInternalOpts {
  /** 覆盖 derivePath；用于 docs-watcher 让 change 事件落新版本化文件名。 */
  targetPathOverride?: string
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

  /**
   * F027 final-vision P1-2 r2 修：opts.targetPathOverride 允许 docs-watcher caller 指定
   * versioned final path（如 `_auto/<basename>-<unixMs>.md`），避免重复 ingest 同源文件
   * 时撞 `_auto/<basename>.md` CAS conflict。
   *
   * HTTP route 调用方不传 opts → 用原 derivePath 行为（向后兼容；Day 9-10 单测不破）。
   * docs-watcher（DocsIngestRunner）直接 service-call 时传 opts.targetPathOverride →
   * 用之作为 finalPath（仍走 ACL/lease/CAS/wiki_events 全链）。
   */
  commit(body: PostIngestCommitBody, opts: CommitInternalOpts = {}): CommitResult {
    // 1. 读 preview entry **不消费**（Week 2 r2 范-r1 P3）。
    //    瞬时失败（CAS conflict / lease_held / internal）后用户可重试同 previewId
    //    而不必重 preview/sanitize；仅在 ok 路径 + 终态错误（denied_acl / path_invalid
    //    / schema_invalid / not_implemented）时 consume。
    const peeked = this.store.peek(body.previewId)
    if (peeked.entry === null) {
      return {
        ok: false,
        httpStatus: HTTP_STATUS_BY_ERROR[ErrorCode.DRAFT_NOT_FOUND],
        error: {
          code: ErrorCode.DRAFT_NOT_FOUND,
          message:
            peeked.reason === "expired"
              ? `previewId ${body.previewId} expired`
              : `previewId ${body.previewId} not found (already consumed or never existed)`,
          detail: { reason: peeked.reason, previewId: body.previewId },
        },
      }
    }
    const entry = peeked.entry

    // 2. 派生 finalPath（落 wiki/concepts/draft/_auto/<filename>）
    //    F027 final-vision P1-2 r2 修：opts.targetPathOverride 优先（docs-watcher 用 versioned path
    //    避免 change 事件 CAS 撞名）。HTTP route 默认走 derivePath（向后兼容）。
    const finalPath = opts.targetPathOverride ?? derivePath(entry.sourcePath)

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
    //
    // Week 2 r2 (范-r1 P2): commit endpoint 既然负责 acquireLease，就必须负责释放。
    // UpdateWikiService 仅在 ok 路径 releaseLease；conflict / denied_acl / internal 等
    // 失败路径不释放 → lease 被本 endpoint 持有到 TTL，撞名 conflict 后用户立刻重试
    // 同 path 会被 lease_held 干扰。try/finally 兜底释放（ok 路径 double-release 是
    // safe noop，因为 releaseLease 用 fencing_token CAS）。
    //
    // F027 P4 Day 10 AC-P4-3 e: 落盘前 inject series_id 进 frontmatter（如 caller 在 preview
    // 时填写了 seriesId）。后续 multi-drop cross-correlation 查 frontmatter 判 chained 跳过。
    // F027 v3 G11: 优先落盘 LLM 编译产物（compiledMarkdown，含 cross_refs/dedup/canonical_owner
    // 完整 frontmatter）。preview 未编译 / 编译失败兜底时退回 raw sanitizedContent。
    //   - compiledMarkdown 已含 series_id（compile pipeline 写进 frontmatter.ingest_metadata）→ 不再 inject。
    //   - sanitizedContent 路径保持原 seriesId top-level inject 行为（向后兼容）。
    const finalContent = entry.compiledMarkdown
      ? entry.compiledMarkdown
      : entry.seriesId
        ? injectSeriesIdIntoFrontmatter(entry.sanitizedContent, entry.seriesId)
        : entry.sanitizedContent

    let response: UpdateWikiResponse
    try {
      response = this.updateWiki.updateWiki(
        {
          path: finalPath,
          action: "write",
          baseHash: null, // 新文件（撞名 → status=conflict）
          content: finalContent,
          fencingToken: lease.fencingToken,
          reason: `ingest_commit previewId=${body.previewId} mime=${entry.mimeType}${entry.targetType ? ` targetType=${entry.targetType}` : ""}${entry.seriesId ? ` seriesId=${entry.seriesId}` : ""}`,
          sourceMessageIds: undefined,
        },
        { alias: body.callerAlias, isServiceIdentity: false },
      )
    } finally {
      // 任意失败路径 + 上面 try 块抛错都兜底释放（fencing_token CAS 保证只能释放我们拿的 lease）
      this.leases.releaseLease({ path: finalPath, fencingToken: lease.fencingToken })
    }

    // Week 2 r2 (范-r1 P3): peek → updateWiki → consume 决策
    //   - ok / 不可恢复终态 (denied_acl / path_invalid / schema_invalid / not_implemented)
    //     → consume preview (重试无意义)
    //   - 可恢复瞬时态 (conflict / lease_expired / stale_token / internal)
    //     → 保留 preview，用户可改名/重试同 previewId 直到 TTL 过期
    const shouldConsume =
      response.status === "ok" ||
      response.status === "denied_acl" ||
      response.status === "path_invalid" ||
      response.status === "schema_invalid" ||
      response.status === "not_implemented"
    if (shouldConsume) {
      this.store.consume(body.previewId)
    }

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
 * F027 P4 Day 10 AC-P4-3 e · 把 series_id 注入到落盘 markdown 的 frontmatter。
 *
 * 两种情形:
 *   1. content 已有 frontmatter (---\n ... \n---\n) → 在闭合 --- 之前插一行 series_id
 *   2. content 无 frontmatter → prepend minimal frontmatter ---\nseries_id: <id>\n---\n
 *
 * 已有 frontmatter 检测:
 *   - 必须以 "---" 开头 (允许尾随 \n 或 \r\n)
 *   - 第二个 "---" 必须在合理距离内 (5KB 内, 防 false-positive)
 *   - 否则当作无 frontmatter 处理 (prepend minimal)
 *
 * 不做 (Day 10 范围外):
 *   - YAML 解析 (KISS — string 操作即可)
 *   - 已有 series_id 字段 dedupe (caller 不应传同 seriesId 二次 commit)
 */
export function injectSeriesIdIntoFrontmatter(content: string, seriesId: string): string {
  const MAX_FM_SCAN = 5 * 1024 // 5KB 内找闭合 ---
  const headerMatch = content.match(/^---\s*\n/)
  if (headerMatch) {
    const startBodyIdx = headerMatch[0].length
    const closeIdx = content.indexOf("\n---", startBodyIdx)
    if (closeIdx > 0 && closeIdx < MAX_FM_SCAN) {
      // 已有 frontmatter — 在闭合 \n--- 之前插 series_id 行
      return `${content.slice(0, closeIdx)}\nseries_id: ${seriesId}${content.slice(closeIdx)}`
    }
  }
  // 无 frontmatter (或闭合 --- 太远) — prepend minimal
  return `---\nseries_id: ${seriesId}\n---\n${content}`
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
