/**
 * F027 P3 · UpdateWikiService — chap 6 写入流程的业务编排（pure logic）
 * 真相源：docs/plans/V16.5-final.md chap 6 step 5-10
 *
 * 责任：
 *   1. ACL.decide → denied_acl
 *   2. lease.isCurrent → lease_expired（fencing_token 校验 1）
 *   3. CAS: 当前 path 文件 hash == base_hash? → conflict + current_hash
 *   4. PREPARE: wiki_events.appendPending(state='pending')
 *   5. ★ final-CAS fencing 二次：lease.isCurrent → stale_token + abort
 *   6. atomic write（temp + rename）
 *   7. COMMIT: wiki_events.commit(state='committed', content_hash)
 *   8. release lease
 *   9. notify(event_id, path) → caller 触发 compiler debounce
 *
 * 不做：
 *   - service identity 鉴权（caller 在 MCP 入口处用 socket peer creds 解 alias）
 *   - schema 校验（chap 6 step 5d；P4 frontmatter schema engine 出来再加）
 *   - LLM 编译派生视图（P2 WikiCompiler 是被通知方）
 *   - lease acquire（caller 自己调 leases.acquireLease）—— service 只校验 token
 *
 * action 语义（V16.5 chap 5 enum 7 个）：
 *   - write   : 全量覆盖（content 即新文件内容）
 *   - append  : 追加 content 到末尾
 *   - delete  : 删除 path 文件（content 必须是空字符串）
 *   - patch / ingest / promote / demote : 暂留 not-implemented（chap 6 没给细节）
 */

import crypto from "node:crypto"
import fs from "node:fs"
import type { WikiEventsRepository } from "../db/repositories/wiki-events-repository"
import type { WikiLeasesRepository } from "../db/repositories/wiki-leases-repository"
import type { CompiledACL } from "./acl-engine"
import { decide } from "./acl-engine"
import type { ACLContext, WikiAction } from "./acl-types"
import { writeFileAtomic } from "./atomic-write"
import { WikiPathInvalidError, safeWikiPath } from "./path-containment"

export interface UpdateWikiRequest {
  /** wiki 相对路径（如 'wiki/concepts/foo.md'）；service 内部解 wikiRoot 后绝对化。 */
  path: string
  action: WikiAction
  /** null = 创建新文件；非空 = CAS 期望当前 hash。 */
  baseHash: string | null
  content: string
  fencingToken: string
  reason?: string
  sourceMessageIds?: string[]
}

export type UpdateWikiStatus =
  | "ok"
  | "denied_acl"
  | "conflict"
  | "lease_expired"
  | "schema_invalid"
  | "stale_token"
  | "not_implemented"
  /** [范-r1 P3] internal IO failure（atomic-write/disk full/permissions），≠ CAS conflict */
  | "internal"
  /** [范-r1 P1] path 校验失败（traversal / 非 wiki/ 前缀 / NUL byte）—— security 先于 ACL */
  | "path_invalid"

export interface UpdateWikiResponse {
  status: UpdateWikiStatus
  /** conflict 时返回当前实际 hash（caller 拿去 reconcile） */
  currentHash?: string
  /** 落地 wiki_events.id（commit / abort 都返） */
  eventId?: number
  /** 拒因 / abort 错误说明 */
  error?: string
}

export interface UpdateWikiServiceConfig {
  leases: WikiLeasesRepository
  events: WikiEventsRepository
  acl: CompiledACL
  /** 真实 wiki 文件目录绝对路径根（如 .runtime/wiki/）。request.path 拼到此根下。 */
  wikiRoot: string
  /** chap 5 Compiler Leader Lease 当前 term（caller 注入：可来自 in-memory cache 或 DB 查）。 */
  leaderTerm: () => string
  /**
   * 提交后回调（caller 用来触发 compiler debounce）。同步调，service 不 await。
   * 失败抛出会污染 commit 结果 —— caller 应自行 try/catch。
   */
  onCommit?: (eventId: number, path: string) => void
  /** 注入时钟，便于测试 deterministic timestamps。 */
  now?: () => Date
}

export class UpdateWikiService {
  constructor(private readonly cfg: UpdateWikiServiceConfig) {}

  updateWiki(req: UpdateWikiRequest, context: ACLContext): UpdateWikiResponse {
    // 0. [范-r1 P1] path containment —— security 必须先于 ACL（防 ACL 通过后 ../ 逃逸）
    let absPath: string
    try {
      absPath = safeWikiPath(this.cfg.wikiRoot, req.path)
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        return { status: "path_invalid", error: err.message }
      }
      throw err
    }

    // 1. ACL
    const aclDecision = decide(this.cfg.acl, context, req.path, req.action)
    if (!aclDecision.allowed) {
      return { status: "denied_acl", error: aclDecision.reason }
    }

    // 2. lease 校验 1（pre-write）
    const nowIso = this.nowIso()
    if (!this.cfg.leases.isCurrent(req.path, req.fencingToken, nowIso)) {
      return { status: "lease_expired", error: "fencing_token_not_current_or_expired" }
    }

    // 3. CAS：读当前文件 hash + content（append 用） 比 baseHash
    const existing = readFileTextIfExists(absPath)
    const currentHash = existing === null ? null : sha256(existing)
    if (currentHash !== req.baseHash) {
      return {
        status: "conflict",
        currentHash: currentHash ?? undefined,
        error: `base_hash mismatch (current=${currentHash ?? "null"}, expected=${req.baseHash ?? "null"})`,
      }
    }

    // 5. action 派发：计算 attempted content + attemptedHash
    const dispatch = computeAttempted(req, existing)
    if (dispatch.kind === "not_implemented") {
      return { status: "not_implemented", error: `action '${req.action}' not yet implemented` }
    }

    // 6. PREPARE: wiki_events state='pending'
    const event = this.cfg.events.appendPending({
      ts: nowIso,
      alias: context.alias,
      action: req.action,
      path: req.path,
      baseHash: req.baseHash,
      attemptedHash: dispatch.attemptedHash,
      sourceMessageIds: req.sourceMessageIds ?? null,
      reason: req.reason ?? null,
      fencingToken: req.fencingToken,
      leaderTerm: this.cfg.leaderTerm(),
      result: "ok",
    })

    // 7. ★ final-CAS fencing 二次：临界区开始前再校 lease
    if (!this.cfg.leases.isCurrent(req.path, req.fencingToken, this.nowIso())) {
      this.cfg.events.abort(event.id, { error: "stale_token", reason: "lease_changed_mid_write" })
      return { status: "stale_token", eventId: event.id, error: "lease lost during write" }
    }

    // 7d. atomic write（含 delete 分支）
    try {
      if (dispatch.kind === "delete") {
        deleteFileIfExists(absPath)
      } else {
        writeFileAtomic(absPath, dispatch.content)
      }
    } catch (err) {
      const msg = (err as Error).message
      this.cfg.events.abort(event.id, { error: msg, reason: "atomic_write_failed" })
      // [范-r1 P3] 不再返 'conflict'（误导 client 按 CAS 重试）；用 'internal' 让
      // route layer 映射 5xx
      return { status: "internal", eventId: event.id, error: `atomic_write_failed: ${msg}` }
    }

    // [范-r1 P2] 临界区收尾再校 lease：写已落盘但 lease 在 atomic-write 期间被
    // 抢占的情况（TTL race window），revert 文件 + abort，避免脏数据 + 错误 commit
    if (!this.cfg.leases.isCurrent(req.path, req.fencingToken, this.nowIso())) {
      // 回滚：删除本次写入的文件（delete 分支的 revert 拿不回来，但 lease 已抢占
      // 意味着新 owner 立刻就会重写，临时不一致窗口可接受）
      if (dispatch.kind !== "delete") {
        deleteFileIfExists(absPath)
      }
      this.cfg.events.abort(event.id, {
        error: "stale_token",
        reason: "lease_changed_after_write",
      })
      return { status: "stale_token", eventId: event.id, error: "lease lost after write" }
    }

    // 8. COMMIT
    this.cfg.events.commit(event.id, { contentHash: dispatch.attemptedHash })

    // 9. release lease（caller 拿到 ok 后再 release 也可以，但 service 替 caller 释放更安全）
    this.cfg.leases.releaseLease({ path: req.path, fencingToken: req.fencingToken })

    // 10. notify compiler
    if (this.cfg.onCommit) {
      this.cfg.onCommit(event.id, req.path)
    }

    return { status: "ok", eventId: event.id, currentHash: dispatch.attemptedHash }
  }

  private nowIso(): string {
    return (this.cfg.now ? this.cfg.now() : new Date()).toISOString()
  }
}

interface DispatchWrite {
  kind: "write"
  content: string
  attemptedHash: string
}
interface DispatchDelete {
  kind: "delete"
  attemptedHash: string
}
interface DispatchNotImpl {
  kind: "not_implemented"
}

function computeAttempted(
  req: UpdateWikiRequest,
  existing: string | null,
): DispatchWrite | DispatchDelete | DispatchNotImpl {
  switch (req.action) {
    case "write":
      return { kind: "write", content: req.content, attemptedHash: sha256(req.content) }
    case "append": {
      // append 把 content 当增量；append 到不存在文件 = 等价于 write 该 content
      const merged = (existing ?? "") + req.content
      return { kind: "write", content: merged, attemptedHash: sha256(merged) }
    }
    case "delete":
      return { kind: "delete", attemptedHash: sha256("") }
    default:
      return { kind: "not_implemented" }
  }
}

function readFileTextIfExists(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

function deleteFileIfExists(absPath: string): void {
  try {
    fs.unlinkSync(absPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
}

function sha256(s: string): string {
  return `sha256:${crypto.createHash("sha256").update(s).digest("hex")}`
}
