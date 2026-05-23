/**
 * F027 Phase 4 AC-P4-4 · BatchPromoteService — 批量 promote 编排（部分失败语义）
 *
 * 真相源:
 *   - docs/plans/F027-phase4-implementation-plan.md AC-P4-4 (line 215-218)
 *   - PromoteWikiService (单份 promote 核心，含 V14/ACL/lease/atomic-write/wiki_events)
 *
 * 设计:
 *   - 串行 (not parallel): 简单可预测 + V14 audit 已快 + lease 边界清晰
 *   - 每份 (srcDraftPath, destWikiPath) 独立 acquireLease → promote → releaseLease (try/finally)
 *   - 一份失败不阻塞其他 (continue-on-error)，汇总 success/failed 列表
 *   - 共用 reason + callerAlias + sourceMessageIds (PromoteModal 批量 UI 只填一次)
 *   - 返 BatchPromoteSummary（report modal 直接渲染 N success + M failed + audit_reason）
 *
 * 不做:
 *   - 并行 promote (M 通常 ≤ 10 + lease 顺序明确)
 *   - 失败时 retry (失败 draft 留原位等用户手动 retry，per plan line 218)
 *   - 跨 dest 事务 (per-item 独立)
 */

import type { WikiLeasesRepository } from "../../db/repositories/wiki-leases-repository"
import type { PromoteWikiService, PromoteStatus, PromoteResponse } from "./promote-wiki-service"
import type { V14RejectReason } from "./v14-promote-audit-service"

export interface BatchPromoteItem {
  srcDraftPath: string
  destWikiPath: string
}

export interface BatchPromoteRequest {
  items: readonly BatchPromoteItem[]
  callerAlias: string
  reason: string
  taintedSourceFields?: readonly string[]
  sourceMessageIds?: string[]
}

export interface BatchPromoteSuccess {
  srcDraftPath: string
  destWikiPath: string
  finalPath: string
  eventId: number
}

/**
 * 每条失败的诊断结构 (UI 报告 modal 直接渲染)。
 *
 *   - status: 同 PromoteStatus 集合 + "lease_held"（acquireLease 拿不到时）
 *   - auditReject: 仅 status='audit_rejected' 时填，UI 显示 layer + matchedPatterns + hint
 */
export interface BatchPromoteFailure {
  srcDraftPath: string
  destWikiPath: string
  status: PromoteStatus | "lease_held"
  error: string
  auditReject?: V14RejectReason
}

export interface BatchPromoteSummary {
  total: number
  success: BatchPromoteSuccess[]
  failed: BatchPromoteFailure[]
}

export interface BatchPromoteServiceConfig {
  promote: PromoteWikiService
  leases: WikiLeasesRepository
  /** Compiler Leader Lease term (caller 注入)。 */
  currentLeaderTerm: () => string
  /** Lease TTL (秒，测试可覆盖；默认 30s 跟单份 promote 一致)。 */
  leaseTtlSeconds?: number
}

const DEFAULT_LEASE_TTL_SECONDS = 30

export class BatchPromoteService {
  constructor(private readonly cfg: BatchPromoteServiceConfig) {}

  batchPromote(req: BatchPromoteRequest): BatchPromoteSummary {
    const ttl = this.cfg.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS
    const success: BatchPromoteSuccess[] = []
    const failed: BatchPromoteFailure[] = []

    for (const item of req.items) {
      const result = this.promoteOne(item, req, ttl)
      if (result.kind === "ok") {
        success.push(result.entry)
      } else {
        failed.push(result.entry)
      }
    }

    return {
      total: req.items.length,
      success,
      failed,
    }
  }

  private promoteOne(
    item: BatchPromoteItem,
    req: BatchPromoteRequest,
    ttl: number,
  ): { kind: "ok"; entry: BatchPromoteSuccess } | { kind: "fail"; entry: BatchPromoteFailure } {
    const acquired = this.cfg.leases.acquireLease({
      path: item.destWikiPath,
      ownerAlias: req.callerAlias,
      ttlSeconds: ttl,
      leaderTerm: this.cfg.currentLeaderTerm(),
    })
    if (!acquired) {
      return {
        kind: "fail",
        entry: {
          srcDraftPath: item.srcDraftPath,
          destWikiPath: item.destWikiPath,
          status: "lease_held",
          error: `dest path lease held by another owner: ${item.destWikiPath}`,
        },
      }
    }

    let result: PromoteResponse
    try {
      result = this.cfg.promote.promote({
        srcDraftPath: item.srcDraftPath,
        destWikiPath: item.destWikiPath,
        callerAlias: req.callerAlias,
        reason: req.reason,
        fencingToken: acquired.fencingToken,
        taintedSourceFields: req.taintedSourceFields,
        sourceMessageIds: req.sourceMessageIds,
      })
    } finally {
      this.cfg.leases.releaseLease({
        path: item.destWikiPath,
        fencingToken: acquired.fencingToken,
      })
    }

    if (result.status === "ok") {
      return {
        kind: "ok",
        entry: {
          srcDraftPath: item.srcDraftPath,
          destWikiPath: item.destWikiPath,
          finalPath: result.finalPath!,
          eventId: result.eventId!,
        },
      }
    }

    return {
      kind: "fail",
      entry: {
        srcDraftPath: item.srcDraftPath,
        destWikiPath: item.destWikiPath,
        status: result.status,
        error: result.error ?? `promote failed with status=${result.status}`,
        auditReject: result.auditReject,
      },
    }
  }
}
