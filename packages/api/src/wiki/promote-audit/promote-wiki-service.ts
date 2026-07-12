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
import { writeFileAtomic, writeFileAtomicIfAbsent } from "../atomic-write"
import { WikiPathInvalidError, safeWikiPath } from "../path-containment"
import { checkExemptionSanitizeBlocked } from "./exemption-tainted-fields"
// type-only：detector 运行时依赖本文件的路径谓词，值 import 会成环（cfg.findSameSource 闭包注入解耦）
import type { SameSourceConflict } from "./same-source-detector"
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
  /** 替换 CAS 失配（德彪 replace-r1 P1）：现有页与用户对比时看到的版本不一致 → 刷新对比后重试。 */
  | "dest_conflict"
  /** F042 AC3 · 正式区已有 sources[0].path 相同的条目（双胞胎）——须显式选择取代或去合并。 */
  | "same_source_exists"
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
  /**
   * dest_exists 替换补丁（小孙「失败了都不知道该不该丢弃」）：dest 已存在时不拒绝，
   * 而是把现有页归档进 wiki/_rejected/（带时间戳，move not delete 可恢复）后落新页。
   * 归档发生在审计/ACL/lease 全部通过**之后**——被拒的 promote 绝不动现有页。
   * 默认 false 保持 dest_exists 语义。
   */
  allowReplace?: boolean
  /**
   * 德彪 replace-r1 P1 · CAS 闸：allowReplace 时**必填**——用户在对比面板看到的现有页
   * contentHash（page/content 端点返回）。归档前/写盘前双点校验，现有页已被并发改动
   * → dest_conflict 拒绝（绝不盲替换用户没看过的版本）。
   */
  expectedDestHash?: string
  /**
   * F042 AC3 · 同源撞车的显式取代确认：same_source_exists 返回的 conflicts 中用户选择
   * 取代的旧条目路径。promote 落盘成功后归档进 wiki/_superseded/（move not delete +
   * wiki_events action='supersede' 留痕，可恢复）。检测到同源而此处未覆盖 → 拒。
   */
  supersedePaths?: string[]
}

export interface PromoteResponse {
  status: PromoteStatus
  /** ok 时落地的 wiki_events.id */
  eventId?: number
  /** ok 时落地的 dest absolute path */
  finalPath?: string
  /** allowReplace 替换发生时：旧页归档到的 _rejected/ 相对路径（可恢复）。 */
  replacedArchivePath?: string
  /** audit_rejected 时填 V14 reject reason (AC-P4-2 PromoteModal UI 显示) */
  auditReject?: V14RejectReason
  /** F042 AC3 · same_source_exists 时：未被 supersedePaths 覆盖的同源冲突（前端对比面板数据源）。 */
  sameSourceConflicts?: SameSourceConflict[]
  /** F042 AC3 · ok 且执行了取代：旧条目归档后的 wiki/_superseded/ 相对路径（可恢复）。 */
  supersededPaths?: string[]
  /** F042 AC3 · ok 但个别取代失败（promote 本体已成功，不回滚）：路径+原因，人工善后。 */
  supersedeFailures?: SupersedeFailure[]
  /** 拒因 / error 说明 */
  error?: string
}

export interface SupersedeFailure {
  path: string
  error: string
  /** aborted wiki_events supersede row；前端显式忽略时据此写 resolution 对账。 */
  eventId?: number
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
  /**
   * F042 AC3 · 同源检测回调（装配点注入 detectSameSourceConflicts over wiki_entity_index；
   * 缺省 = 跳过检测，存量装配零回归）。闭包注入而非直接 import——detector 依赖本文件的
   * 路径谓词，反向 import 会成环。
   */
  findSameSource?: (srcContent: string, destWikiPath: string) => SameSourceConflict[]
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
    const destExists = fs.existsSync(destAbsolute)
    if (destExists && !req.allowReplace) {
      return {
        status: "dest_exists",
        error: `dest wiki path already exists (前端可对比后选「替换」——旧页归档到 _rejected/ 可恢复): ${req.destWikiPath}`,
      }
    }

    // ─── 2. V14 二次审计 (read src body 跑 3 步 detection) ─────────────────
    const srcContent = fs.readFileSync(srcAbsolute, "utf-8")
    // F027 bucket-routing 补丁：落盘内容 = owner_path 刷成 dest 后的版本（审计/哈希/写盘
    // 三者用同一份，保「审的即写的」）。src 文件本身不动。
    const destContent = rewriteCanonicalOwnerPath(srcContent, req.destWikiPath)

    // ─── 2.5 F042 AC3 · 同源撞车检测（sources[0].path 精确匹配正式区）──────────
    // 在 V14 判官（可能调 LLM）之前拦：双胞胎是结构性问题，先于内容审计。
    // 检测异常直接上抛（route 500 可见）——不静默 fail-open 放双胞胎进正式区。
    let confirmedSupersedes: SameSourceConflict[] = []
    if (this.cfg.findSameSource) {
      const conflicts = this.cfg.findSameSource(srcContent, req.destWikiPath)
      const chosen = new Set(req.supersedePaths ?? [])
      const unresolved = conflicts.filter((c) => !chosen.has(c.path))
      if (unresolved.length > 0) {
        return {
          status: "same_source_exists",
          sameSourceConflicts: unresolved,
          error: `正式区已有同源条目（sources.path 相同）——须显式选择「取代旧版」或去合并: ${unresolved
            .map((c) => c.path)
            .join(", ")}`,
        }
      }
      // 只执行「本次检测确认的冲突」——supersedePaths 里的过期/无关路径自然忽略
      confirmedSupersedes = conflicts
    }
    // 德彪 r3 P1 · 人审豁免文档(frontmatter 带 ingest_exemption)promote 二道关:对编译产物
    // 跑 sanitize 复检,仍 blocked 直接拒。r2 的 layer3 substring 注入被 r3 实测推翻(matched
    // 归一化后形态 ≠ 原文域,同形字注入 includes 必漏);blocked 判定在归一化域内全文生效、
    // 无跨域盲区。普通 draft(无 exemption)放行,零回归。client 不可绕(服务端自取 src)。
    const exemptionCheck = checkExemptionSanitizeBlocked(destContent)
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
      body: destContent,
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

    // ─── 4.5 替换归档（allowReplace && dest 已存在）───────────────────────────
    // 位置关键：审计/ACL/lease 全过之后才动现有页——被拒的 promote 绝不归档；归档失败
    // 则整个 promote 失败，dest 原样（归档是 copy，dest 由 step 6 原子覆盖，全程无空窗）。
    let replacedArchivePath: string | undefined
    let replacedOldHash: string | null = null
    // 德彪 replace-r2 P2：归档事件保持 pending，promote 真正落盘 commit 后才 commit——
    // 终检 abort 的 replace 不能留下 committed demote 假象（副本文件无害留 _rejected/）。
    let archiveEventId: number | undefined
    if (destExists && req.allowReplace) {
      const archived = this.archiveExistingDest(req, destAbsolute)
      if (archived.failure) return archived.failure
      replacedArchivePath = archived.archiveRelative
      replacedOldHash = archived.oldHash
      archiveEventId = archived.archiveEventId
    }
    const abortArchive = (reason: string): void => {
      if (archiveEventId !== undefined) {
        this.cfg.events.abort(archiveEventId, { error: reason })
      }
    }

    // ─── 5. PREPARE: wiki_events appendPending ────────────────────────────
    const ts = new Date().toISOString()
    const contentHash = sha256(destContent)
    let eventId = 0
    try {
      const event = this.cfg.events.appendPending({
        ts,
        alias: req.callerAlias,
        action: "promote",
        path: req.destWikiPath,
        // 替换时 baseHash = 被覆盖旧页的内容哈希（审计可追「覆盖了什么」）；新建仍 null。
        baseHash: replacedOldHash,
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
      abortArchive("promote appendPending failed")
      return {
        status: "internal",
        error: `wiki_events appendPending failed: ${(err as Error).message}`,
      }
    }

    // ─── 5.5 终检 fencing + CAS（德彪 replace-r1 P1 + r2 存在性分支）─────────────
    // lease 在 step 4 验过，但 LLM 判官/归档之后已过去很久——写盘前重验（对齐
    // UpdateWikiService final-check 思路）。失租 → abort 事件，dest 一个字节不动。
    if (!this.cfg.leases.isCurrent(req.destWikiPath, req.fencingToken)) {
      this.cfg.events.abort(eventId, { error: "lease lost before final write" })
      abortArchive("lease lost before final write")
      return {
        status: "lease_expired",
        error: "写盘前 lease 已失效（判官/归档窗口被并发抢占），promote 未落盘",
      }
    }
    if (replacedArchivePath && replacedOldHash) {
      // replace 终检 CAS：归档与写盘的窄窗里 dest 被并发改动/删除都算「用户看过的版本
      // 已变化」→ 不写（德彪 r2 P1-2：删除同样是变化，stale replace 不许复活已删页）。
      // 归档副本已落 _rejected/ 无害多留一份；dest 保留并发 writer 的状态。
      let destNowHash: string | null = null
      try {
        destNowHash = sha256(fs.readFileSync(destAbsolute, "utf-8"))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.cfg.events.abort(eventId, { error: "pre-write dest re-read failed" })
          abortArchive("pre-write dest re-read failed")
          return {
            status: "internal",
            error: `pre-write dest re-read failed: ${(err as Error).message}`,
          }
        }
      }
      if (destNowHash !== replacedOldHash) {
        const what = destNowHash === null ? "被并发删除" : "被并发修改"
        this.cfg.events.abort(eventId, { error: `dest ${what} between archive and write (CAS)` })
        abortArchive(`dest ${what} between archive and write (CAS)`)
        return {
          status: "dest_conflict",
          error: `现有页在归档与写盘之间${what}，本次替换已中止——请刷新对比后重试`,
        }
      }
    } else if (fs.existsSync(destAbsolute)) {
      // 德彪 r2 P1-1 · 存在性「无→有」：开头判定 dest 不存在（普通 promote / 归档前
      // 消失的 replace），判官/PREPARE 窗口里被并发创建 → 绝不盲覆盖，按 dest_exists 拒。
      this.cfg.events.abort(eventId, { error: "dest appeared before final write" })
      abortArchive("dest appeared before final write")
      return {
        status: "dest_exists",
        error: `dest 在写盘前被并发创建（判官窗口竞态）——请刷新列表对比后再决定是否替换: ${req.destWikiPath}`,
      }
    }

    // ─── 6. atomic write: src content → dest path ─────────────────────────
    // 德彪 replace-r3 P1 · 两种写法按语义分流：
    //   - 新建（非替换）：writeFileAtomicIfAbsent（linkSync 内核级 create-if-absent）——
    //     5.5 的 existsSync 只是提前失败的礼貌检查，真正闭合「无→有」竞态的是这里：
    //     并发在 check 与写之间创建 dest → EEXIST → dest_exists，一个字节不覆盖。
    //   - 替换：writeFileAtomic（rename 覆盖）。哈希重验(5.5)与 rename 之间的极窄窗口
    //     属协作锁模型既定接受：lease 是全体生产 writer（update/promote/demote/ingest）
    //     的协议锁，绕过 lease 的写入方本身违反 wiki 写协议（与 warnings 端点
    //     realpath→open TOCTOU 同类，纯 userland 无 OS 级 CAS 关不死）。
    try {
      if (replacedArchivePath) {
        writeFileAtomic(destAbsolute, destContent)
      } else {
        const created = writeFileAtomicIfAbsent(destAbsolute, destContent)
        if (created === "exists") {
          this.cfg.events.abort(eventId, { error: "dest appeared at atomic link (EEXIST)" })
          abortArchive("dest appeared at atomic link (EEXIST)")
          return {
            status: "dest_exists",
            error: `dest 在写盘瞬间被并发创建（内核级 EEXIST 拒绝，未覆盖）——请刷新列表对比后再决定: ${req.destWikiPath}`,
          }
        }
      }
    } catch (err) {
      // PREPARE 已落，但 atomic write fail → abort wiki_events
      this.cfg.events.abort(eventId, {
        error: `atomic write failed: ${(err as Error).message}`,
      })
      abortArchive("promote atomic write failed")
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
      abortArchive("promote commit returned false")
      return {
        status: "internal",
        error: "wiki_events commit returned false (row already settled)",
      }
    }
    // 替换真正生效（新页已落盘）→ 此刻才 commit 归档 demote 事件（德彪 r2 P2）
    if (archiveEventId !== undefined && replacedOldHash) {
      this.cfg.events.commit(archiveEventId, { contentHash: replacedOldHash })
    }

    // ─── 8. unlink src draft (promote 成功后清理) ─────────────────────────
    try {
      fs.unlinkSync(srcAbsolute)
    } catch (err) {
      // unlink fail 不影响 promote 已成功 — 但 src draft 留盘 (后续 KB list 会看到)
      // 不返 error 让 caller 知道 — 由 caller log 决定是否警告
    }

    // ─── 9. F042 AC3 · 同源取代执行（post-commit 收尾）─────────────────────
    // promote 本体已成功；旧版归档失败不回滚新页（failures 透出人工善后）。
    // 血缘走事件账本（action='supersede' + promotionTarget=新路径），不做新页 frontmatter
    // 手术（NHC deadSupersedes 校验目标存在性，指向搬走前路径必炸——账本可查即显式）。
    let supersededPaths: string[] | undefined
    let supersedeFailures: SupersedeFailure[] | undefined
    if (confirmedSupersedes.length > 0) {
      const sup = this.executeSupersedes(req, confirmedSupersedes)
      supersededPaths = sup.superseded.length > 0 ? sup.superseded : undefined
      supersedeFailures = sup.failures.length > 0 ? sup.failures : undefined
    }

    return {
      status: "ok",
      eventId,
      finalPath: destAbsolute,
      replacedArchivePath,
      supersededPaths,
      supersedeFailures,
    }
  }

  /**
   * F042 AC3 · 逐条取代：旧同源条目 rename 进 wiki/_superseded/（flatten+时间戳，同
   * buildReplacedArchivePath 惯例），wiki_events action='supersede' PREPARE→rename→COMMIT。
   * 单条失败 abort 事件 + 记 failure 继续下一条——promote 已成功，不因归档翻车。
   */
  private executeSupersedes(
    req: PromoteRequest,
    conflicts: SameSourceConflict[],
  ): { superseded: string[]; failures: SupersedeFailure[] } {
    const superseded: string[] = []
    const failures: SupersedeFailure[] = []
    for (const conflict of conflicts) {
      const oldRelative = conflict.path
      let eventId: number | undefined
      try {
        const oldAbsolute = safeWikiPath(this.cfg.wikiRoot, oldRelative)
        const oldContent = fs.readFileSync(oldAbsolute, "utf-8")
        const oldHash = sha256(oldContent)
        const archiveRelative = buildSupersededArchivePath(oldRelative, Date.now())
        const archiveAbsolute = safeWikiPath(this.cfg.wikiRoot, archiveRelative)
        const event = this.cfg.events.appendPending({
          ts: new Date().toISOString(),
          alias: req.callerAlias,
          action: "supersede",
          path: oldRelative,
          baseHash: oldHash,
          attemptedHash: oldHash,
          diffSummary: `supersede-archive ${oldRelative} → ${archiveRelative}`,
          sourceMessageIds: req.sourceMessageIds,
          promotionTarget: req.destWikiPath,
          reason: `superseded by promote of ${req.srcDraftPath}: ${req.reason}`,
          fencingToken: req.fencingToken,
          leaderTerm: this.cfg.currentLeaderTerm(),
          result: "ok",
        })
        eventId = event.id
        if (fs.existsSync(archiveAbsolute)) {
          const error = `archive path collision: ${archiveRelative}`
          this.cfg.events.abort(event.id, { error })
          failures.push({ path: oldRelative, error, eventId })
          continue
        }
        try {
          fs.mkdirSync(path.dirname(archiveAbsolute), { recursive: true })
          fs.renameSync(oldAbsolute, archiveAbsolute)
        } catch (moveErr) {
          this.cfg.events.abort(event.id, {
            error: `supersede rename failed: ${(moveErr as Error).message}`,
          })
          failures.push({ path: oldRelative, error: (moveErr as Error).message, eventId })
          continue
        }
        this.cfg.events.commit(event.id, { contentHash: oldHash })
        superseded.push(archiveRelative)
      } catch (err) {
        const error = (err as Error).message
        if (eventId !== undefined) {
          this.cfg.events.abort(eventId, { error })
        } else {
          eventId = this.recordSupersedeFailure(req, oldRelative, error)
        }
        failures.push({ path: oldRelative, error, eventId })
      }
    }
    return { superseded, failures }
  }

  private recordSupersedeFailure(
    req: PromoteRequest,
    oldRelative: string,
    error: string,
  ): number | undefined {
    try {
      const attemptedHash = sha256(`supersede-failure:${oldRelative}`)
      const event = this.cfg.events.appendPending({
        ts: new Date().toISOString(),
        alias: req.callerAlias,
        action: "supersede",
        path: oldRelative,
        attemptedHash,
        diffSummary: `supersede-archive failed before move: ${oldRelative}`,
        sourceMessageIds: req.sourceMessageIds,
        promotionTarget: req.destWikiPath,
        reason: `superseded by promote of ${req.srcDraftPath}: ${req.reason}`,
        fencingToken: req.fencingToken,
        leaderTerm: this.cfg.currentLeaderTerm(),
        result: "ok",
      })
      this.cfg.events.abort(event.id, { error })
      return event.id
    } catch {
      return undefined
    }
  }

  /**
   * dest_exists 替换补丁 · 把现有 dest 页归档进 wiki/_rejected/（带时间戳后缀防与历史
   * demote 撞名）。归档是安全副本（move not delete、wiki_events action='demote' 留痕、
   * 小孙可从 _rejected/ 恢复），走 replace 专用路径命名以免覆盖既有归档。
   *
   * 德彪 replace-r1 P1-2 · 授权口径：replace **不要求 demote ACL**——它不是独立的治理
   * demote（那个继续全员收紧），而是「promote 授权 + 用户对过 diff 的 CAS 确认」的覆盖：
   * expectedDestHash 必填且必须等于现有页当前哈希，看没看过的版本一律拒（fail-closed）。
   */
  private archiveExistingDest(
    req: PromoteRequest,
    destAbsolute: string,
  ): {
    failure?: PromoteResponse
    archiveRelative?: string
    oldHash: string | null
    /** 归档 demote 事件保持 pending——promote 真落盘后 caller 才 commit（德彪 r2 P2）。 */
    archiveEventId?: number
  } {
    if (!req.expectedDestHash) {
      return {
        oldHash: null,
        failure: {
          status: "dest_conflict",
          error:
            "allowReplace 需要 expectedDestHash（对比面板提供的现有页 contentHash）——不允许盲替换",
        },
      }
    }

    let oldContent: string
    try {
      oldContent = fs.readFileSync(destAbsolute, "utf-8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // 德彪 r2 P1-2 同口径：删除也是「用户看过的版本已变化」——CAS 语义下 stale replace
        // 不许复活已删页，一律 conflict 让用户刷新对比再决定。
        return {
          oldHash: null,
          failure: {
            status: "dest_conflict",
            error: "现有页在你确认替换前已被删除——请刷新对比后再决定（可能只需普通 Promote）",
          },
        }
      }
      return {
        oldHash: null,
        failure: {
          status: "internal",
          error: `read existing dest for archive failed: ${(err as Error).message}`,
        },
      }
    }
    const oldHash = sha256(oldContent)
    // CAS 第一点（归档前）：现有页 ≠ 用户对比时看到的版本 → 拒（第二点在写盘前，见 5.5）
    if (oldHash !== req.expectedDestHash) {
      return {
        oldHash,
        failure: {
          status: "dest_conflict",
          error: "现有页内容已与你对比时的版本不同（可能被并发修改）——请刷新对比后重试",
        },
      }
    }

    const archiveRelative = buildReplacedArchivePath(req.destWikiPath, Date.now())
    let archiveAbsolute: string
    try {
      archiveAbsolute = safeWikiPath(this.cfg.wikiRoot, archiveRelative)
    } catch (err) {
      return {
        oldHash,
        failure: { status: "internal", error: `archive path invalid: ${(err as Error).message}` },
      }
    }
    if (fs.existsSync(archiveAbsolute)) {
      return {
        oldHash,
        failure: {
          status: "internal",
          error: `archive path collision (retry promote): ${archiveRelative}`,
        },
      }
    }

    // 归档留痕：wiki_events action='demote'（PREPARE→写归档→COMMIT，与 DemoteWikiService 同构）
    let archiveEventId = 0
    try {
      const event = this.cfg.events.appendPending({
        ts: new Date().toISOString(),
        alias: req.callerAlias,
        action: "demote",
        path: req.destWikiPath,
        baseHash: oldHash,
        attemptedHash: oldHash,
        diffSummary: `replace-archive ${req.destWikiPath} → ${archiveRelative}`,
        sourceMessageIds: req.sourceMessageIds,
        promotionTarget: null,
        reason: `replaced by promote of ${req.srcDraftPath}: ${req.reason}`,
        fencingToken: req.fencingToken,
        leaderTerm: this.cfg.currentLeaderTerm(),
        result: "ok",
      })
      archiveEventId = event.id
    } catch (err) {
      return {
        oldHash,
        failure: {
          status: "internal",
          error: `wiki_events appendPending (replace-archive) failed: ${(err as Error).message}`,
        },
      }
    }
    try {
      writeFileAtomic(archiveAbsolute, oldContent)
    } catch (err) {
      this.cfg.events.abort(archiveEventId, {
        error: `replace-archive atomic write failed: ${(err as Error).message}`,
      })
      return {
        oldHash,
        failure: {
          status: "internal",
          error: `replace-archive write failed (dest 未动): ${(err as Error).message}`,
        },
      }
    }
    // 注意：此处**不 commit**——归档事件保持 pending，promote 写盘 commit 成功后由 caller
    // commit（德彪 r2 P2：终检 abort 的 replace 不能留 committed demote 假象）。
    return { archiveRelative, oldHash, archiveEventId }
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

/**
 * F042 AC3 · 召回面归档判定（单一真相源）：demote → `wiki/_rejected/`、supersede →
 * `wiki/_superseded/` 的条目一律不进 search_wiki / preflight / adaptive-recall L2 /
 * embedded records。normalize + 小写口径同 isDraftRelativePath（Windows 大小写旁路防护）。
 * 注意与 isSupersededDraftRelativePath 分工：那个挡「归档 draft 转正」，这个挡「归档进召回」。
 */
export function isArchivedRelativePath(p: string): boolean {
  const normalized = path.posix.normalize(p.replace(/\\/g, "/")).toLowerCase()
  return normalized.includes("/_superseded/") || normalized.includes("/_rejected/")
}

/**
 * F027 bucket-routing 补丁 · promote 落盘时把 frontmatter 的 canonical_owner_path 刷成
 * dest 正式路径（此前 src 原样拷贝 → 存量正式区 entity 的 owner_path 全指着 draft 旧址）。
 * 只在「文件以 frontmatter 开头 且 frontmatter 区内已有 canonical_owner_path 单行字段」时
 * 替换；无 frontmatter / 无该字段不注入（最小改动，不拼 YAML 结构）。正文同名字样不受影响。
 * 已知边界：compile pipeline 写的 owner_path 恒为单行；若未来出现 YAML 折行值，替换不命中
 * 原样保留（fail-safe 方向）。
 */
export function rewriteCanonicalOwnerPath(content: string, destWikiPath: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content
  const fmEnd = content.indexOf("\n---", 3)
  if (fmEnd < 0) return content
  const fmRegion = content.slice(0, fmEnd)
  // 德彪 r1 P2-1 + r2 P2：只改「单行普通标量」——值首字符非空白/>/|/#（排除 YAML 折行 `>`、
  // 字面量 `|`、空值+缩进续行、`# 注释`+续行四种形态，替换会留孤儿续行写坏 frontmatter）；
  // (\r?) 捕获保留 CRLF 行尾。
  const rewritten = fmRegion.replace(
    /^canonical_owner_path:[ \t]*[^\s>|#][^\n\r]*(\r?)$/m,
    `canonical_owner_path: ${destWikiPath}$1`,
  )
  if (rewritten === fmRegion) return content
  return rewritten + content.slice(fmEnd)
}

/**
 * dest_exists 替换补丁 · replace 归档路径：demote 的 flatten 规则 + `--replaced-<epoch>` 后缀。
 * 'wiki/concepts/foo.md' → 'wiki/_rejected/concepts--foo--replaced-1782988170125.md'
 * 时间戳后缀防与既有 demote 归档（无后缀版）及历史 replace 撞名——归档只增不覆盖。
 */
export function buildReplacedArchivePath(destRelative: string, epochMs: number): string {
  const normalized = destRelative.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  const withoutWikiPrefix = normalized.startsWith("wiki/")
    ? normalized.substring("wiki/".length)
    : normalized
  const flat = withoutWikiPrefix.replace(/\//g, "--")
  const stem = flat.endsWith(".md") ? flat.slice(0, -3) : flat
  return `wiki/_rejected/${stem}--replaced-${epochMs}.md`
}

/**
 * F042 AC3 · supersede 归档路径：flatten 规则同 buildReplacedArchivePath，目录换
 * wiki/_superseded/（语义区分：_rejected = 人工否决/替换旧页，_superseded = 同源新版取代）。
 * 'wiki/concepts/F031-旧版.md' → 'wiki/_superseded/concepts--F031-旧版--superseded-<epoch>.md'
 */
export function buildSupersededArchivePath(oldRelative: string, epochMs: number): string {
  const normalized = oldRelative.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  const withoutWikiPrefix = normalized.startsWith("wiki/")
    ? normalized.substring("wiki/".length)
    : normalized
  const flat = withoutWikiPrefix.replace(/\//g, "--")
  const stem = flat.endsWith(".md") ? flat.slice(0, -3) : flat
  return `wiki/_superseded/${stem}--superseded-${epochMs}.md`
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex")
}
