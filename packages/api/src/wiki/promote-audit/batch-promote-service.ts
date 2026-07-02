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
import type { PromoteResponse, PromoteStatus, PromoteWikiService } from "./promote-wiki-service"
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

// 德彪 r1 P1：lease 须覆盖 LLM 判官最坏耗时。后台化补丁德彪 r1 P2：judge_parse_failed 自动
// 重试一次 → 最坏 2×(primary 60s + fallback 60s) = 240s，留余量取 300s（与 promote route 同步）。
// batch 每项独立 acquire/release（finally），长租仅锁单 dest。
const DEFAULT_LEASE_TTL_SECONDS = 300

/**
 * posture C 熔断阈值（设计审 critique P1）：连续 N 次 LLM 判官不可用（基础设施挂，非内容问题）
 * → 中止剩余项，避免 41 篇逐篇空 spawn + 空 lease 写；UI 一次性提示「判官不可用整批稍后重试」。
 */
const JUDGE_UNAVAILABLE_CIRCUIT_BREAK = 3

export class BatchPromoteService {
  constructor(private readonly cfg: BatchPromoteServiceConfig) {}

  // posture C：promote 含 LLM 语义判官 → async，串行 await（保 lease 顺序）。
  async batchPromote(req: BatchPromoteRequest): Promise<BatchPromoteSummary> {
    const ttl = this.cfg.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS
    const success: BatchPromoteSuccess[] = []
    const failed: BatchPromoteFailure[] = []
    let consecutiveUnavailable = 0
    let circuitBroken = false

    for (const item of req.items) {
      // 熔断后剩余项不再真调 LLM/lease，直接标 judge_unavailable（本项未尝试）
      if (circuitBroken) {
        failed.push({
          srcDraftPath: item.srcDraftPath,
          destWikiPath: item.destWikiPath,
          status: "audit_rejected",
          error: `LLM 判官连续 ${JUDGE_UNAVAILABLE_CIRCUIT_BREAK} 次不可用，批量已熔断中止，本项未尝试`,
          auditReject: {
            layer: "judge_unavailable",
            matchedPatterns: ["batch-circuit-break"],
            hint: "LLM 判官暂不可用（编译引擎挂/超时），批量已熔断。这不是内容问题，请稍后整批重试 promote。",
          },
        })
        continue
      }

      const result = await this.promoteOne(item, req, ttl)
      if (result.kind === "ok") {
        success.push(result.entry)
        consecutiveUnavailable = 0
      } else {
        failed.push(result.entry)
        if (
          result.entry.status === "audit_rejected" &&
          result.entry.auditReject?.layer === "judge_unavailable"
        ) {
          consecutiveUnavailable += 1
          if (consecutiveUnavailable >= JUDGE_UNAVAILABLE_CIRCUIT_BREAK) circuitBroken = true
        } else {
          consecutiveUnavailable = 0
        }
      }
    }

    return {
      total: req.items.length,
      success,
      failed,
    }
  }

  private async promoteOne(
    item: BatchPromoteItem,
    req: BatchPromoteRequest,
    ttl: number,
  ): Promise<
    { kind: "ok"; entry: BatchPromoteSuccess } | { kind: "fail"; entry: BatchPromoteFailure }
  > {
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
      result = await this.cfg.promote.promote({
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
