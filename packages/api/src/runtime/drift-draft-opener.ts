/**
 * 收尾修1 · drift draft 落盘器（DriftDetector.openUpdateDraft 的生产实现）。
 *
 * 设计审 critique P1：不走带 compile deps 的 sharedIngestPreview（会触发真 LLM 重编译 +
 * 用 compiledMarkdown 覆盖 buildUpdateDraft 的 stub body，且批量 ~N trigger 可炸 600s timeout）。
 * drift draft 是系统生成的 TODO stub（"新 lesson LL-031 → review agent top_risks"），不是需编译
 * 的知识实体 → 走 UpdateWikiService 轻路径（PREPARE→atomic write→COMMIT + ACL/lease/wiki_events，
 * **无 LLM**）。
 *
 * - sanitize 防线：body 含 DB 字段拼接（wiki_events/a2a_calls 的 path/alias/ts）属不可信文本，
 *   sanitizeRawDrop blocked → throw（DriftDetector 落 failed，不打断其他 trigger）。
 * - reason 写 `drift:<kind>:<ref>`（driftDraftReason）→ 跨 run dedup 读 reason 精确反解 key。
 * - content 直接用 buildUpdateDraft 的 body（已含 h1，不再 prepend title 避免双 h1，critique P3）。
 */

import type { WikiLeasesRepository } from "../db/repositories/wiki-leases-repository"
import {
  DRIFT_DETECTOR_ALIAS,
  DRIFT_DRAFT_DIR,
  type DriftUpdateDraft,
  driftDraftBasename,
  driftDraftReason,
} from "../services/scheduler/drift-detector"
import type { ACLContext } from "../wiki/acl-types"
import { sanitizeRawDrop } from "../wiki/sanitize/sanitize-raw-drop"
import type { UpdateWikiService } from "../wiki/update-wiki-service"

const DRIFT_ALIAS = DRIFT_DETECTOR_ALIAS
const DRIFT_LEASE_TTL_SECONDS = 30

export interface DriftDraftOpenerDeps {
  updateWiki: UpdateWikiService
  leases: WikiLeasesRepository
  /** Compiler Leader Lease 当前 term。 */
  leaderTerm: () => string
}

/** 构造 DriftDetector.openUpdateDraft（轻路径，无 LLM）。 */
export function createDriftDraftOpener(
  deps: DriftDraftOpenerDeps,
): (draft: DriftUpdateDraft) => Promise<void> {
  return async (draft) => {
    const relPath = `${DRIFT_DRAFT_DIR}/${driftDraftBasename(draft.trigger)}.md`

    // 1. sanitize 红线（不可信 DB 字段拼接）—— blocked 不落盘；否则落**已剥离危险片段的
    //    sanitizedText**（德彪 r1 P2：sanitizer 契约要求用 sanitizedText，不能写回原文 body）。
    const san = sanitizeRawDrop(draft.body)
    if (san.blocked) {
      throw new Error(
        `drift draft sanitize-blocked (${relPath}): ${san.redLineTriggers
          .map((t) => t.reason)
          .join(", ")}`,
      )
    }
    const content = san.sanitizedText

    // 2. 取 lease（draft 路径；drift 单进程 leader-gated，冲突近乎不可能，仍走 lease 保一致）
    const lease = deps.leases.acquireLease({
      path: relPath,
      ownerAlias: DRIFT_ALIAS,
      ttlSeconds: DRIFT_LEASE_TTL_SECONDS,
      leaderTerm: deps.leaderTerm(),
    })
    if (!lease) throw new Error(`drift draft lease held: ${relPath}`)

    // 3. updateWiki 轻写（无 LLM）+ release
    try {
      const ctx: ACLContext = { alias: DRIFT_ALIAS, isServiceIdentity: false }
      const res = deps.updateWiki.updateWiki(
        {
          path: relPath,
          action: "write",
          baseHash: null, // 新建（同 ref 重开靠 dedup 拦；漏网时 CAS conflict 兜底）
          content,
          fencingToken: lease.fencingToken,
          reason: driftDraftReason(draft.trigger),
        },
        ctx,
      )
      if (res.status !== "ok") {
        throw new Error(`drift draft write failed (${relPath}): ${res.status} ${res.error ?? ""}`)
      }
    } finally {
      deps.leases.releaseLease({ path: relPath, fencingToken: lease.fencingToken })
    }
  }
}
