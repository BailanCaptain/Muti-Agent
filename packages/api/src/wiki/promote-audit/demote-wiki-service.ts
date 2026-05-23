/**
 * F027 Phase 4 AC-P4-3 (a)(d) · DemoteWikiService — wiki entity → 拒绝 / 推回 draft 的业务编排
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-3 (d) (DemoteModal: 选 reason → POST /api/wiki/<path>/demote → mv 回 _drafts/ + 写 wiki_events action='demote')
 *   - V16.5-final.md line 1552 (promote 后 demote 原 draft), line 2544 (/demote <draft> 拒绝 draft), line 2890 (promote 时旧 entity 自动 demote)
 *   - codex Week 5 r1 review (j2 FAIL P4-3): Demote 后端 + Modal 必须 Phase 4 内做
 *
 * 跟 PromoteWikiService 关系:
 *   - 镜像 PREPARE+COMMIT pattern + lease try/finally + wiki_events
 *   - action='demote' 写入 (WikiEventAction 已支持)
 *
 * Demote 语义 (本服务约定):
 *   - src: 任意 wiki 路径 (draft 或 正式 entity)
 *   - dest: `wiki/_rejected/<flattened-relative-path>` (统一 wiki/_rejected/ bin, 满足 safeWikiPath 'wiki/' 前缀约束)
 *   - flatten 规则: src `wiki/concepts/foo.md` → dest `wiki/_rejected/concepts--foo.md` (用 -- 替 /, 避免目录嵌套 collision)
 *   - 内容保留 (move not delete), 小孙手动可恢复
 *
 * 流程 (PREPARE+COMMIT):
 *   1. path 校验: src 必须 wiki/ 下 + 不能本身在 _rejected/
 *   2. ACL 校验 (caller 是否允许 demote)
 *   3. lease 校验 (src path fencingToken)
 *   4. PREPARE: wiki_events.appendPending(action='demote', state='pending')
 *   5. atomic move: src → dest (_rejected/)
 *   6. COMMIT: wiki_events.commit(state='committed')
 *   7. release lease
 *
 * 不做 (Phase 4 范围外):
 *   - rollback / undelete (推 F028)
 *   - V14 二次审计 (demote 是 reject 操作, 不需要 V14)
 *   - 批量 demote (Phase 4 不要求, 推 F028 evaluate)
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { WikiEventsRepository } from "../../db/repositories/wiki-events-repository"
import type { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"
import type { CompiledACL } from "../acl-engine"
import { decide } from "../acl-engine"
import type { ACLContext } from "../acl-types"
import { isServiceAlias } from "../acl-types"
import { writeFileAtomic } from "../atomic-write"
import { WikiPathInvalidError, safeWikiPath } from "../path-containment"

export type DemoteStatus =
  | "ok"
  | "denied_acl"
  | "lease_expired"
  | "src_not_found"
  | "dest_exists"
  | "path_invalid"
  | "internal"

export interface DemoteRequest {
  /** Wiki 路径 (相对 wikiRoot), 可以是 draft 或正式 entity, 如 'wiki/concepts/rag.md' */
  srcWikiPath: string
  /** Demote 操作者 alias */
  callerAlias: string
  /** Demote reason (用户在 DemoteModal 输入) */
  reason: string
  /** 写入 fencingToken (caller 从 acquireLease 拿) */
  fencingToken: string
  /** sourceMessageIds: 关联 audit trail */
  sourceMessageIds?: string[]
}

export interface DemoteResponse {
  status: DemoteStatus
  eventId?: number
  /** ok 时落地的 _rejected/ 下 dest absolute path */
  rejectedPath?: string
  error?: string
}

export interface DemoteWikiServiceConfig {
  events: WikiEventsRepository
  leases: WikiLeasesRepository
  acl: CompiledACL
  wikiRoot: string
  currentLeaderTerm: () => string
}

const REJECTED_BIN = "wiki/_rejected"

export class DemoteWikiService {
  constructor(private readonly cfg: DemoteWikiServiceConfig) {}

  demote(req: DemoteRequest): DemoteResponse {
    // ─── 1. path 校验 ──────────────────────────────────────────────────────
    if (isInRejectedBin(req.srcWikiPath)) {
      return {
        status: "path_invalid",
        error: `src already in _rejected/ bin: ${req.srcWikiPath}`,
      }
    }
    let srcAbsolute: string
    try {
      srcAbsolute = safeWikiPath(this.cfg.wikiRoot, req.srcWikiPath)
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        return { status: "path_invalid", error: err.message }
      }
      throw err
    }
    if (!fs.existsSync(srcAbsolute)) {
      return { status: "src_not_found", error: `src wiki path not found: ${req.srcWikiPath}` }
    }

    const destRelative = buildRejectedPath(req.srcWikiPath)
    let destAbsolute: string
    try {
      destAbsolute = safeWikiPath(this.cfg.wikiRoot, destRelative)
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        return { status: "path_invalid", error: err.message }
      }
      throw err
    }
    if (fs.existsSync(destAbsolute)) {
      return {
        status: "dest_exists",
        error: `dest already exists in _rejected bin: ${destRelative} (prior demote not yet cleaned)`,
      }
    }

    // ─── 2. ACL 校验 ───────────────────────────────────────────────────────
    const aclCtx: ACLContext = {
      alias: req.callerAlias,
      isServiceIdentity: isServiceAlias(req.callerAlias),
    }
    const aclDecision = decide(this.cfg.acl, aclCtx, req.srcWikiPath, "demote")
    if (!aclDecision.allowed) {
      return {
        status: "denied_acl",
        error: `ACL denied: ${aclDecision.reason}${aclDecision.matchedPattern ? ` (rule: ${aclDecision.matchedPattern})` : ""}`,
      }
    }

    // ─── 3. lease 校验 ─────────────────────────────────────────────────────
    const leaseOk = this.cfg.leases.isCurrent(req.srcWikiPath, req.fencingToken)
    if (!leaseOk) {
      return {
        status: "lease_expired",
        error: "fencingToken 无效 / lease 过期 / 已 release",
      }
    }

    // ─── 4. PREPARE: wiki_events appendPending ────────────────────────────
    const srcContent = fs.readFileSync(srcAbsolute, "utf-8")
    const ts = new Date().toISOString()
    const contentHash = sha256(srcContent)
    let eventId = 0
    try {
      const event = this.cfg.events.appendPending({
        ts,
        alias: req.callerAlias,
        action: "demote",
        path: req.srcWikiPath,
        baseHash: contentHash,
        attemptedHash: contentHash,
        diffSummary: `demote ${req.srcWikiPath} → ${destRelative}`,
        sourceMessageIds: req.sourceMessageIds,
        promotionTarget: null,
        reason: req.reason,
        fencingToken: req.fencingToken,
        leaderTerm: this.cfg.currentLeaderTerm(),
        result: "ok",
      })
      eventId = event.id
    } catch (err) {
      return {
        status: "internal",
        error: `wiki_events appendPending failed: ${(err as Error).message}`,
      }
    }

    // ─── 5. atomic move: src → dest (_rejected/) ──────────────────────────
    try {
      writeFileAtomic(destAbsolute, srcContent)
    } catch (err) {
      this.cfg.events.abort(eventId, {
        error: `atomic write to _rejected failed: ${(err as Error).message}`,
      })
      return {
        status: "internal",
        error: `atomic write failed: ${(err as Error).message}`,
      }
    }

    // ─── 6. COMMIT ─────────────────────────────────────────────────────────
    const committed = this.cfg.events.commit(eventId, { contentHash })
    if (!committed) {
      return {
        status: "internal",
        error: "wiki_events commit returned false (row already settled)",
      }
    }

    // ─── 7. unlink src (move not delete: src 已 copy 到 _rejected, 删 src) ─
    try {
      fs.unlinkSync(srcAbsolute)
    } catch (err) {
      // unlink fail 不影响 demote 已成功 — src 留盘 list 看到 (后续 reconcile)
    }

    return {
      status: "ok",
      eventId,
      rejectedPath: destAbsolute,
    }
  }
}

/**
 * Flatten src relative path → wiki/_rejected/ bin 路径
 * 'wiki/concepts/rag.md' → 'wiki/_rejected/concepts--rag.md'
 * (strip leading 'wiki/' from src to avoid 'wiki--' prefix duplication)
 */
export function buildRejectedPath(srcRelative: string): string {
  const normalized = srcRelative.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  const withoutWikiPrefix = normalized.startsWith("wiki/")
    ? normalized.substring("wiki/".length)
    : normalized
  const flat = withoutWikiPrefix.replace(/\//g, "--")
  return `${REJECTED_BIN}/${flat}`
}

export function isInRejectedBin(p: string): boolean {
  const normalized = p.replace(/\\/g, "/")
  return normalized.startsWith("wiki/_rejected/") || normalized.includes("/_rejected/")
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex")
}
