/**
 * F027 Phase 4 AC-P4-1 · PromoteWikiService — draft → 正式 wiki path 提升的业务编排
 *
 * 真相源:
 *   - docs/plans/V16.5-final.md line 838-846 (Tainted_source promote 二次审计)
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-1 (PromoteModal 流程)
 *   - Phase 1 UpdateWikiService (update-wiki-service.ts) PREPARE+COMMIT pattern
 *
 * 跟 UpdateWikiService 关系:
 *   - UpdateWikiService.execute(action='promote') 是 not-implemented stub (chap 6 没细节)
 *   - Promote 是 src draft → dest 正式 path 双 path 操作，跟 single-path action 模型不 fit
 *   - 独立 PromoteWikiService 复用同一 wiki_events repo + atomic-write + ACL/lease 校验
 *
 * 流程 (PREPARE+COMMIT pattern):
 *   1. path 校验: src 必须 draft 路径 (含 _drafts/ 或 wiki/concepts/draft/) + dest wiki 路径
 *   2. V14 二次审计 (3 步 detection) — fail 返 audit reject 不 mv
 *   3. ACL 校验 (dest path 是否允许 caller alias write)
 *   4. lease 校验 (dest path fencingToken)
 *   5. PREPARE: wiki_events.appendPending(action='promote', state='pending')
 *   6. atomic write: src content → dest path (atomic + retain src 失败 rollback)
 *   7. COMMIT: wiki_events.commit(state='committed')
 *   8. unlink src draft (promote 成功后清理)
 *   9. release lease + notify
 *
 * 不做 (Day 7 范围):
 *   - schema 校验 (frontmatter engine 出来再加)
 *   - LLM 编译派生视图 (P2 WikiCompiler 被通知方)
 *   - Demote / Rollback (AC-P4-3 Day 9 范围)
 *   - 批量 promote (AC-P4-4 Week 3)
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
import { checkExemptionSanitizeBlocked } from "./exemption-tainted-fields"
import {
  type V14PromoteAuditInput,
  V14PromoteAuditService,
  type V14RejectReason,
} from "./v14-promote-audit-service"

export type PromoteStatus =
  | "ok"
  | "audit_rejected"
  | "denied_acl"
  | "lease_expired"
  | "src_not_found"
  | "dest_exists"
  | "path_invalid"
  | "internal"

export interface PromoteRequest {
  /** Draft 相对路径 (如 'wiki/concepts/draft/_auto/2026-05-20-rag-paper.md')。 */
  srcDraftPath: string
  /** 目标正式 wiki 路径 (如 'wiki/concepts/rag-overview.md')。 */
  destWikiPath: string
  /** Promote 操作者 alias (写入 wiki_events.alias + audit_passed_by)。 */
  callerAlias: string
  /** Promote reason (用户在 PromoteModal 输入)。 */
  reason: string
  /** 写入 fencingToken (caller 从 acquireLease 拿)。 */
  fencingToken: string
  /** taintedSourceFields: V14 layer 3 检查用 (drop 时 sanitize 标的 raw text)。可选。 */
  taintedSourceFields?: readonly string[]
  /** sourceMessageIds: 关联 audit trail (V16.5 chap 5)。可选。 */
  sourceMessageIds?: string[]
}

export interface PromoteResponse {
  status: PromoteStatus
  /** ok 时落地的 wiki_events.id */
  eventId?: number
  /** ok 时落地的 dest absolute path */
  finalPath?: string
  /** audit_rejected 时填 V14 reject reason (AC-P4-2 PromoteModal UI 显示) */
  auditReject?: V14RejectReason
  /** 拒因 / error 说明 */
  error?: string
}

export interface PromoteWikiServiceConfig {
  events: WikiEventsRepository
  leases: WikiLeasesRepository
  acl: CompiledACL
  /** Wiki root 绝对路径 (如 `.runtime/wiki/`)。request.path 拼到此根下。 */
  wikiRoot: string
  /** 当前 leader_term (caller 注入，from compiler_leader)。 */
  currentLeaderTerm: () => string
  /** V14 audit service (可选注入测试 stub；默认 new instance)。 */
  auditService?: V14PromoteAuditService
}

export class PromoteWikiService {
  private readonly audit: V14PromoteAuditService

  constructor(private readonly cfg: PromoteWikiServiceConfig) {
    this.audit = cfg.auditService ?? new V14PromoteAuditService()
  }

  // posture C：audit 含 LLM 语义判官 → async。caller（promote route / batch service）已 await。
  async promote(req: PromoteRequest): Promise<PromoteResponse> {
    // ─── 1. path 校验 ──────────────────────────────────────────────────────
    let srcAbsolute: string
    let destAbsolute: string
    try {
      srcAbsolute = safeWikiPath(this.cfg.wikiRoot, req.srcDraftPath)
      destAbsolute = safeWikiPath(this.cfg.wikiRoot, req.destWikiPath)
    } catch (err) {
      if (err instanceof WikiPathInvalidError) {
        return { status: "path_invalid", error: err.message }
      }
      throw err
    }
    if (!this.isDraftPath(req.srcDraftPath)) {
      return {
        status: "path_invalid",
        error: `src must be a draft path (contain '/draft/' or '/_drafts/'), got: ${req.srcDraftPath}`,
      }
    }
    // 德彪 wiki-ux r1 P2 · _superseded 归档版本不可转正（single + batch 共用本闸口）
    if (isSupersededDraftRelativePath(req.srcDraftPath)) {
      return {
        status: "path_invalid",
        error: `src is a superseded (archived) draft — promote the newest same-source draft instead, got: ${req.srcDraftPath}`,
      }
    }
    if (this.isDraftPath(req.destWikiPath)) {
      return {
        status: "path_invalid",
        error: `dest must NOT be a draft path, got: ${req.destWikiPath}`,
      }
    }

    if (!fs.existsSync(srcAbsolute)) {
      return { status: "src_not_found", error: `src draft not found: ${req.srcDraftPath}` }
    }
    if (fs.existsSync(destAbsolute)) {
      return {
        status: "dest_exists",
        error: `dest wiki path already exists (use update_wiki to overwrite): ${req.destWikiPath}`,
      }
    }

    // ─── 2. V14 二次审计 (read src body 跑 3 步 detection) ─────────────────
    const srcContent = fs.readFileSync(srcAbsolute, "utf-8")
    // 德彪 r3 P1 · 人审豁免文档(frontmatter 带 ingest_exemption)promote 二道关:对编译产物
    // 跑 sanitize 复检,仍 blocked 直接拒。r2 的 layer3 substring 注入被 r3 实测推翻(matched
    // 归一化后形态 ≠ 原文域,同形字注入 includes 必漏);blocked 判定在归一化域内全文生效、
    // 无跨域盲区。普通 draft(无 exemption)放行,零回归。client 不可绕(服务端自取 src)。
    const exemptionCheck = checkExemptionSanitizeBlocked(srcContent)
    if (exemptionCheck.blocked) {
      return {
        status: "audit_rejected",
        auditReject: {
          layer: "exemption_sanitize_blocked",
          matchedPatterns: exemptionCheck.reasons,
          hint: "人审豁免文档 promote 复检仍触发 sanitize 红线（编译产物残留危险内容）。请人工改写 draft 去除攻击样例/同形字注入后再转正。",
        },
      }
    }
    const auditInput: V14PromoteAuditInput = {
      body: srcContent,
      taintedSourceFields: req.taintedSourceFields,
    }
    const auditResult = await this.audit.audit(auditInput)
    if (!auditResult.passed) {
      return {
        status: "audit_rejected",
        auditReject: auditResult.rejectReason,
      }
    }

    // ─── 3. ACL 校验 ───────────────────────────────────────────────────────
    const aclCtx: ACLContext = {
      alias: req.callerAlias,
      isServiceIdentity: isServiceAlias(req.callerAlias),
    }
    const aclDecision = decide(this.cfg.acl, aclCtx, req.destWikiPath, "promote")
    if (!aclDecision.allowed) {
      return {
        status: "denied_acl",
        error: `ACL denied: ${aclDecision.reason}${aclDecision.matchedPattern ? ` (rule: ${aclDecision.matchedPattern})` : ""}`,
      }
    }

    // ─── 4. lease 校验 (fencingToken) ──────────────────────────────────────
    const leaseOk = this.cfg.leases.isCurrent(req.destWikiPath, req.fencingToken)
    if (!leaseOk) {
      return {
        status: "lease_expired",
        error: "fencingToken 无效 / lease 过期 / 已 release",
      }
    }

    // ─── 5. PREPARE: wiki_events appendPending ────────────────────────────
    const ts = new Date().toISOString()
    const contentHash = sha256(srcContent)
    let eventId = 0
    try {
      const event = this.cfg.events.appendPending({
        ts,
        alias: req.callerAlias,
        action: "promote",
        path: req.destWikiPath,
        baseHash: null, // promote 是新建 dest path，无 baseHash
        attemptedHash: contentHash,
        diffSummary: `promote ${req.srcDraftPath} → ${req.destWikiPath}`,
        sourceMessageIds: req.sourceMessageIds,
        promotionTarget: req.destWikiPath,
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

    // ─── 6. atomic write: src content → dest path ─────────────────────────
    try {
      writeFileAtomic(destAbsolute, srcContent)
    } catch (err) {
      // PREPARE 已落，但 atomic write fail → abort wiki_events
      this.cfg.events.abort(eventId, {
        error: `atomic write failed: ${(err as Error).message}`,
      })
      return {
        status: "internal",
        error: `atomic write to dest failed: ${(err as Error).message}`,
      }
    }

    // ─── 7. COMMIT: wiki_events.commit ────────────────────────────────────
    const committed = this.cfg.events.commit(eventId, { contentHash })
    if (!committed) {
      // 罕见: 已被并行 abort (不应在 promote 路径发生)，但防御
      // 此时 dest 文件已写，回滚 src/dest 都不安全 — 留状态供 reconciler
      return {
        status: "internal",
        error: "wiki_events commit returned false (row already settled)",
      }
    }

    // ─── 8. unlink src draft (promote 成功后清理) ─────────────────────────
    try {
      fs.unlinkSync(srcAbsolute)
    } catch (err) {
      // unlink fail 不影响 promote 已成功 — 但 src draft 留盘 (后续 KB list 会看到)
      // 不返 error 让 caller 知道 — 由 caller log 决定是否警告
    }

    return {
      status: "ok",
      eventId,
      finalPath: destAbsolute,
    }
  }

  private isDraftPath(p: string): boolean {
    return isDraftRelativePath(p)
  }
}

/**
 * Module-level draft-path predicate (codex r2 P2-1 修):
 *   - 复用给 routes/phase4/promote.ts preview endpoint，防止 preview 越界 readFile
 *   - normalize backslash 兼容 Windows path
 */
export function isDraftRelativePath(p: string): boolean {
  // 德彪 r3 P1 · 大小写不敏感:WIKI_PATH_PREFIX(L4)用 /i,Windows fs 大小写不敏感,
  // `DRAFT/`/`_DRAFTS/` 大写形态在 Windows 上能读到真 draft 文件 → 必须同样判为 draft,
  // 否则 L4/promote 闸门被大小写旁路。SQLite LIKE 对 ASCII 本就大小写不敏感,toLowerCase
  // 让 JS 判定与之对齐(单一口径)。
  const normalized = p.replace(/\\/g, "/").toLowerCase()
  return normalized.includes("/draft/") || normalized.includes("/_drafts/")
}

/**
 * 德彪 wiki-ux r1 P2 · 归档区判定。`_superseded` 是 AC-W2 同源收敛归档区——已被更新
 * 版本取代，promote/preview/batch 三入口一律拒绝直接转正（要转正应转最新版本）。
 *
 * 德彪 r2 P2：匹配前做 POSIX normalize——`draft/./_superseded/`、`draft//_superseded/`、
 * `draft/foo/../_superseded/` 等非规范变体经 safeWikiPath 解析后读的是同一归档文件，
 * 裸 includes 会被绕过。normalize 折叠 `.`/`..`/重复斜杠后再判（与 fs 解析同构）。
 */
export function isSupersededDraftRelativePath(p: string): boolean {
  const normalized = path.posix.normalize(p.replace(/\\/g, "/")).toLowerCase()
  return normalized.includes("/draft/_superseded/")
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex")
}
