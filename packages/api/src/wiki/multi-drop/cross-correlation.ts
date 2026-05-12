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

  // Step 4：top-k by similarity（保留 sourceMatch 命中即使 sim 低，因为同源也是信号）
  // 排序：先 sim 降序；同 sim 时 sourceMatch（任一命中）优先
  scored.sort((a, b) => {
    if (a.similarity !== b.similarity) return b.similarity - a.similarity
    return sourceMatchScore(b) - sourceMatchScore(a)
  })
  const topK = scored.slice(0, opts.topK)

  // Step 4.5：在 top-k 上跑 keyword chain + reference link
  for (const cand of topK) {
    const chain = detectKeywordChain(current.rawContent, cand.drop.rawContent)
    cand.keywordChainHits = chain.hits
    const refHit = findReferenceLink(current.rawContent, cand.drop.id)
    if (refHit) cand.referenceLinks.push(refHit)
  }

  // Step 5：决策
  const verdict = await decideVerdict(current, topK, opts)

  return {
    current,
    windowStart,
    windowEnd,
    candidates: topK,
    verdict,
    chainedSuspect: verdict.kind === "chained_suspect",
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

async function decideVerdict(
  current: DropRecord,
  candidates: CorrelationCandidate[],
  opts: Required<Omit<CrossCorrelateOptions, "auditCallback">> & {
    auditCallback?: CrossCorrelateOptions["auditCallback"]
  },
): Promise<CorrelationVerdict> {
  // 5a：series_member（白名单）—— current 有 seriesId 且至少一个 candidate 同 series 且 sim 达标
  if (current.seriesId) {
    const siblings = candidates.filter(
      (c) =>
        c.drop.seriesId === current.seriesId && c.similarity >= opts.seriesSimThreshold,
    )
    if (siblings.length > 0) {
      // V16.5 chap 7 行 834-836：series 白名单不报 chained_suspect，
      // 即使同时命中 keyword/reference 链路（小孙明确 mark "这批是同一组"）。
      return { kind: "series_member", seriesId: current.seriesId, siblings }
    }
  }

  // 5b-d：chained_suspect 三类信号收集
  const triggers: ChainedTrigger[] = []

  for (const c of candidates) {
    // 5b：reference_link 命中（current 显式 ref candidate）
    for (const link of c.referenceLinks) {
      triggers.push({
        reason: "reference_link",
        detail: `current 引用 candidate ${c.drop.id}: ${truncate(link)}`,
        candidateId: c.drop.id,
      })
    }
    // 5c：keyword_chain 命中（wait/execute 跨 drop 配对）
    for (const hit of c.keywordChainHits) {
      triggers.push({
        reason: "keyword_chain",
        detail: hit,
        candidateId: c.drop.id,
      })
    }
    // 5d：高 sim 且 **未被白名单合法同 series 关系** 覆盖 → chained_suspect。
    //   - "合法同 series" = 双方都有 seriesId 且相等（小孙 mark 的同一组 drops）
    //   - 双方都 undefined / 一方 undefined → 视为"无白名单担保"，高 sim 即可疑
    // V16.5 chap 7 行 832-836：只有显式 series 白名单才豁免，未标 series 的高度相似
    // 跨投稿者内容本身就是协调攻击信号。
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

  // 5e：LLM audit hook（只在前面没拦下时跑，避免重复成本）
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
      // LLM hook 失败静默：不阻塞 ingest，但留 trigger 让 caller 知道审计未跑
      // （也可视作 fail-open；caller 在 high-sec 模式可包 try/catch 升级 fail-closed）
      triggers.push({
        reason: "llm_audit",
        detail: `audit hook threw: ${err instanceof Error ? err.message : String(err)}; treat as inconclusive`,
      })
    }
  }

  if (triggers.length > 0) {
    return { kind: "chained_suspect", triggers: dedupeTriggers(triggers) }
  }

  // 5f：isolated
  const reason =
    candidates.length === 0
      ? `no historical drops in ${opts.windowDays}d window`
      : `${candidates.length} candidate(s), max sim=${candidates[0].similarity.toFixed(3)} < ${opts.chainSimThreshold}`
  return { kind: "isolated", reason }
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
