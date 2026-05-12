/**
 * F027 P4.5 · multi-drop cross-correlation · 主入口
 * 真相源：docs/plans/V16.5-final.md chap 7 行 808-836
 * AC: AC-P1-5 ——
 *   1. 同 series_id sim ≥ 0.8 → 自动归 series（白名单）
 *   2. 不同 series sim ≥ 0.7 → chained_suspect=true 警告
 *   3. fixture: tests/fixtures/multi-drop/series-vs-chained.md
 *
 * 算法（in-memory，纯函数）：
 *   1. 过滤 historicalDrops 到 7 天滑动窗口（按 ingestedAt）
 *   2. 排除 currentDrop.id（self）
 *   3. 算每个候选的：similarity（cosine） + sourceMatch（同 contributedBy/IP/UA）
 *   4. 取 top-k（默认 5），跑 keyword chain + reference link 检测
 *   5. 决策（按优先级）：
 *      a. 候选里有同 seriesId 且 sim ≥ seriesSimThreshold → series_member（白名单）
 *      b. reference_link 命中 → chained_suspect (reference_link)
 *      c. keyword_chain 命中 → chained_suspect (keyword_chain)
 *      d. 不同 seriesId 且 sim ≥ chainSimThreshold → chained_suspect (high_sim_diff_series)
 *      e. auditCallback 返回 isChain → chained_suspect (llm_audit)
 *      f. 否则 → isolated
 *
 * 调用契约：
 *   const result = await crossCorrelateDrops(currentDrop, historicalDrops, opts?)
 *   if (result.chainedSuspect) {
 *     // → 编译产物全进 wiki/concepts/draft/_quarantined/
 *     // → 触发告警到指定 room
 *     // → 等小孙手动 review 才能 promote
 *   } else if (result.verdict.kind === "series_member") {
 *     // → 当作正常长 paper 续传，归 result.verdict.seriesId
 *   } else {
 *     // → isolated，走正常 ingest 流程
 *   }
 */

import { cosineSimilarity } from "../../services/embedding-service"
import { detectKeywordChain } from "./keyword-chain"
import { findReferenceLink } from "./reference-link"
import type {
  ChainedTrigger,
  CorrelationCandidate,
  CorrelationVerdict,
  CrossCorrelateOptions,
  CrossCorrelateResult,
  DropRecord,
} from "./types"

const DEFAULT_WINDOW_DAYS = 7
const DEFAULT_SERIES_SIM_THRESHOLD = 0.8
const DEFAULT_CHAIN_SIM_THRESHOLD = 0.7
const DEFAULT_TOP_K = 5

const MS_PER_DAY = 86_400_000

export async function crossCorrelateDrops(
  current: DropRecord,
  historical: readonly DropRecord[],
  options?: CrossCorrelateOptions,
): Promise<CrossCorrelateResult> {
  const opts = {
    windowDays: options?.windowDays ?? DEFAULT_WINDOW_DAYS,
    seriesSimThreshold: options?.seriesSimThreshold ?? DEFAULT_SERIES_SIM_THRESHOLD,
    chainSimThreshold: options?.chainSimThreshold ?? DEFAULT_CHAIN_SIM_THRESHOLD,
    topK: options?.topK ?? DEFAULT_TOP_K,
    auditCallback: options?.auditCallback,
  }

  const windowEnd = current.ingestedAt
  const windowStart = windowEnd - opts.windowDays * MS_PER_DAY

  // Step 1+2：窗口过滤 + 排除 self
  const inWindow = historical.filter(
    (d) => d.id !== current.id && d.ingestedAt >= windowStart && d.ingestedAt <= windowEnd,
  )

  // Step 3：算 similarity + sourceMatch
  const scored = inWindow.map((drop) => scoreCandidate(current, drop))

  // 范-r1 P1-2：keyword chain + reference link 必须**全窗口**扫，不能受 top-k 截断。
  // 攻击场景：5 个 high-sim benign candidate 占满 top-5，第 6 个低 sim 但含
  // wait pattern → 修前漏抓。reference_link 同理（攻击者显式 ref 一个低相似的 drop）。
  // 成本：regex 是 cheap，全窗口扫 200 candidates 也 < 1ms。
  for (const cand of scored) {
    const chain = detectKeywordChain(current.rawContent, cand.drop.rawContent)
    cand.keywordChainHits = chain.hits
    const refHit = findReferenceLink(current.rawContent, cand.drop.id)
    if (refHit) cand.referenceLinks.push(refHit)
  }

  // Step 4：排序 + top-k（仅供 result.candidates 透明展示，不影响 trigger 收集）
  // 排序：先 sim 降序；同 sim 时 sourceMatch 任一命中优先；keyword/reference 命中再优先
  scored.sort((a, b) => {
    if (a.similarity !== b.similarity) return b.similarity - a.similarity
    const sigA = sourceMatchScore(a) + (a.keywordChainHits.length + a.referenceLinks.length) * 2
    const sigB = sourceMatchScore(b) + (b.keywordChainHits.length + b.referenceLinks.length) * 2
    return sigB - sigA
  })

  // Step 5：决策（用全窗口的 scored，不是 top-k —— 修 P1-2）
  const decision = await decideVerdict(current, scored, opts)

  return {
    current,
    windowStart,
    windowEnd,
    candidates: scored.slice(0, opts.topK),
    verdict: decision.verdict,
    chainedSuspect: decision.verdict.kind === "chained_suspect",
    auditError: decision.auditError,
  }
}

function scoreCandidate(current: DropRecord, drop: DropRecord): CorrelationCandidate {
  const sim =
    current.embedding && drop.embedding && current.embedding.length === drop.embedding.length
      ? cosineSimilarity(current.embedding, drop.embedding)
      : 0
  return {
    drop,
    similarity: sim,
    sourceMatch: {
      contributedBy: current.contributedBy === drop.contributedBy,
      ip: !!current.ip && !!drop.ip && current.ip === drop.ip,
      userAgent: !!current.userAgent && !!drop.userAgent && current.userAgent === drop.userAgent,
    },
    keywordChainHits: [],
    referenceLinks: [],
  }
}

function sourceMatchScore(c: CorrelationCandidate): number {
  return (
    (c.sourceMatch.contributedBy ? 1 : 0) +
    (c.sourceMatch.ip ? 1 : 0) +
    (c.sourceMatch.userAgent ? 1 : 0)
  )
}

interface VerdictDecision {
  verdict: CorrelationVerdict
  /** 范-r1 P2-2：audit hook 抛错时记此字段（不当成 detection trigger） */
  auditError?: string
}

async function decideVerdict(
  current: DropRecord,
  candidates: CorrelationCandidate[],
  opts: Required<Omit<CrossCorrelateOptions, "auditCallback">> & {
    auditCallback?: CrossCorrelateOptions["auditCallback"]
  },
): Promise<VerdictDecision> {
  // 范-r1 P1-1 修：先收集所有 trigger 信号；series_member 白名单**只豁免**
  // high_sim_diff_series（即"内容相似 ≠ 攻击"），不再豁免 keyword_chain /
  // reference_link（这两类在 series 内仍是真实跨 drop 攻击信号）。
  // 攻击场景：诱导小孙 mark series → 之后投 wait+execute → 修前全免检。
  const triggers: ChainedTrigger[] = []
  for (const c of candidates) {
    // reference_link：current 显式 ref candidate（即使 series 内也报）
    for (const link of c.referenceLinks) {
      triggers.push({
        reason: "reference_link",
        detail: `current 引用 candidate ${c.drop.id}: ${truncate(link)}`,
        candidateId: c.drop.id,
      })
    }
    // keyword_chain：wait/execute 跨 drop 配对（即使 series 内也报）
    for (const hit of c.keywordChainHits) {
      triggers.push({
        reason: "keyword_chain",
        detail: hit,
        candidateId: c.drop.id,
      })
    }
    // high_sim_diff_series：只有"非合法同 series"+ 高 sim 才报
    //   合法同 series = 双方都有 seriesId 且相等（小孙明确 mark 的同一组）
    //   双方 undefined / 一方 undefined → 视为无白名单担保，高 sim 即可疑
    const sameNamedSeries = !!current.seriesId && current.seriesId === c.drop.seriesId
    if (c.similarity >= opts.chainSimThreshold && !sameNamedSeries) {
      triggers.push({
        reason: "high_sim_diff_series",
        detail: `sim=${c.similarity.toFixed(3)} ≥ ${opts.chainSimThreshold} (current.series=${
          current.seriesId ?? "∅"
        }, candidate.series=${c.drop.seriesId ?? "∅"})`,
        candidateId: c.drop.id,
      })
    }
  }

  // LLM audit hook（只在前面 deterministic 信号都没命中时跑，节省成本）
  // 范-r1 P2-2 修：抛错不再 push detection trigger，改记 auditError 字段。
  // verdict 不被 audit error 影响（fail-soft 默认；caller 高安全模式可读
  // result.auditError 自己升级 fail-closed）。
  let auditError: string | undefined
  if (triggers.length === 0 && opts.auditCallback && candidates.length > 0) {
    try {
      const audit = await opts.auditCallback(
        current,
        candidates.map((c) => c.drop),
      )
      if (audit.isChain) {
        triggers.push({
          reason: "llm_audit",
          detail: audit.reason ?? "LLM judged this group as instruction chain",
        })
      }
    } catch (err) {
      auditError = err instanceof Error ? err.message : String(err)
    }
  }

  if (triggers.length > 0) {
    return {
      verdict: { kind: "chained_suspect", triggers: dedupeTriggers(triggers) },
      auditError,
    }
  }

  // series_member 白名单：必须满足 (a) 没命中任何 trigger，(b) current 有 seriesId，
  // (c) 至少一个 candidate 同 series 且 sim ≥ seriesSimThreshold
  if (current.seriesId) {
    const siblings = candidates.filter(
      (c) => c.drop.seriesId === current.seriesId && c.similarity >= opts.seriesSimThreshold,
    )
    if (siblings.length > 0) {
      return {
        verdict: { kind: "series_member", seriesId: current.seriesId, siblings },
        auditError,
      }
    }
  }

  // isolated
  const sortedBySim = [...candidates].sort((a, b) => b.similarity - a.similarity)
  const reason =
    candidates.length === 0
      ? `no historical drops in ${opts.windowDays}d window`
      : `${candidates.length} candidate(s), max sim=${sortedBySim[0].similarity.toFixed(3)} < ${opts.chainSimThreshold}`
  return { verdict: { kind: "isolated", reason }, auditError }
}

function dedupeTriggers(triggers: ChainedTrigger[]): ChainedTrigger[] {
  const seen = new Set<string>()
  const out: ChainedTrigger[] = []
  for (const t of triggers) {
    const key = `${t.reason}::${t.candidateId ?? ""}::${t.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

export type {
  CrossCorrelateOptions,
  CrossCorrelateResult,
  DropRecord,
  CorrelationCandidate,
  CorrelationVerdict,
  ChainedTrigger,
} from "./types"
