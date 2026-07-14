import {
  EDITORIAL_POLICY_VERSION,
  validateEditorialDecisionSet,
} from "./editorial-decider"
import { applyEditorialPolicy, isInferenceAssessment, resolveDisplayTag } from "./editorial-policy"
import { isPoliticalItem, isUnsafeItem } from "./relevance-filter"
import { hasPairwiseDisjointOverviewItemIds } from "./overview-contract"
import { buildEditorialPromptItems } from "./summarizer"
import type {
  DigestCategory,
  DigestPublicationV2,
  DigestSummary,
  EditorialAssessment,
  EditorialAudit,
  NormalizedItem,
  PublicationEntry,
} from "./types"

export interface BuildDigestPublicationInput {
  businessDate: string
  summary: DigestSummary
  items: NormalizedItem[]
  githubItemIds: string[]
  podcastItemIds: string[]
}

const COMMUNITY_BRIEF_TECH_RE =
  /(?:\b(?:inference|benchmark|evals?|training|fine[- ]?tun(?:e|ing)|quantization|serving|throughput|latency|paper|research|neural|gpu|cuda|vllm|sglang|token|context window|agentic|mcp|rag|lora)\b|推理|量化|训练|微调|评测|基准|论文|研究|神经网络|吞吐|延迟|上下文|多模态|强化学习|智能体|向量|检索|蒸馏|部署|开源)/i
const COMMUNITY_BRIEF_ENTITY_RE =
  /(?:\b(?:ai|llm|gpt(?:-[\d.]+)?|chatgpt|claude|gemini|qwen|deepseek|kimi|mistral|llama|model|agent)\b|人工智能|大模型|模型|智能体)/i
const COMMUNITY_BRIEF_EVENT_RE =
  /(?:\b(?:release[ds]?|launch(?:es|ed)?|ship(?:s|ped)?|publish(?:es|ed)?|available|support(?:s|ed)?|improv(?:e|es|ed|ement)|increase[ds]?|reduce[ds]?|fix(?:es|ed)?|extend(?:s|ed)?|integrat(?:e|es|ed|ion)|migrat(?:e|es|ed|ion)|benchmark(?:s|ed)?|eval(?:s|uated?)?)\b|发布|上线|推出|更新|开放|可用|支持|提升|提高|降低|修复|扩展|集成|迁移|进展|突破)/i
const COMMUNITY_SOURCE_FACT_ACTION_RE =
  /(?:\b(?:solv(?:e[ds]?|ing)|generat(?:e[ds]?|ing)|build(?:s|ing)?|built|creat(?:e[ds]?|ing)|train(?:s|ed|ing)?|test(?:s|ed|ing)?|compar(?:e[ds]?|ing)|control(?:s|led|ling)?|discover(?:s|ed|ing)?|uncover(?:s|ed|ing)?|read(?:s|ing)?|render(?:s|ed|ing)?|implement(?:s|ed|ing)?|measure(?:s|d|ing)?)\b|解决|生成|构建|完成|控制|训练|测试|对比|比较|验证|发现|识别|读取|复原|建模|渲染|实现|测量)/i
const COMMUNITY_SOURCE_DIAGNOSTIC_ACTION_RE =
  /(?:\b(?:diagnos(?:e[ds]?|ing)|debug(?:s|ged|ging)?|investigat(?:e[ds]?|ing)|locat(?:e[ds]?|ing))\b|排查|定位|诊断|调试)/i
const COMMUNITY_SOURCE_TECH_DETAIL_RE =
  /(?:\b(?:architectures?|schedul(?:er|ing)|batching|race conditions?|graphs?|caches?|kernels?|throughput|latency|tokens?\/s|memory|precision|quantization|benchmarks?|datasets?|a\/b tests?)\b|调度|批处理|竞态|吞吐|延迟|缓存|架构|内核|显存|精度|量化|性能|机制|优化|复现|实验|数据集|准确率)/i
const COMMUNITY_SOURCE_TECH_CLAIM_RE =
  /(?:\b(?:vs\.?|versus|trade-?offs?|differences?|comparisons?|discussion|analysis|postmortem|retrospective|outperform(?:s|ed)?|faster|slower|higher|lower|\d+(?:\.\d+)?%|\d+(?:\.\d+)?\s*(?:ms|gb|tokens?\/s))\b|差异|对比|讨论|分析|复盘|权衡|高于|低于|快于|慢于|\d+(?:\.\d+)?%)/i

/**
 * compact brief 只展示标题，不展示 snippet。社区条目即使审核事实合格，标题若只是
 * “@某人：很好/同意”一类反应句，也无法独立传达 AI 研究、工程或发布信息；这类内容
 * 只能进入带 summaryZh 的精选卡，否则宁缺毋滥。
 */
function hasStandaloneCommunityBriefTitle(item: NormalizedItem): boolean {
  if (item.category !== "community") return true
  const headline = item.title.replace(/^\s*(?:@[A-Za-z0-9_]{1,32}\s*[:：\-]\s*)+/, "").trim()
  const cjkCount = headline.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const latinWords = headline.match(/[A-Za-z0-9][A-Za-z0-9.+#/-]*/g)?.length ?? 0
  const hasTech = COMMUNITY_BRIEF_TECH_RE.test(headline)
  const hasEntity = COMMUNITY_BRIEF_ENTITY_RE.test(headline)
  const hasEvent = COMMUNITY_BRIEF_EVENT_RE.test(headline)
  const descriptive = cjkCount >= 12 || (headline.length >= 24 && latinWords >= 6)
  return (
    descriptive ||
    (hasEvent && (hasTech || hasEntity)) ||
    (hasTech && (cjkCount >= 6 || latinWords >= 4))
  )
}

/**
 * pick/card 虽会展示 summaryZh，但摘要同样来自模型，不能拿它给空洞原文“补事实”。
 * 原始标题 + snippet 至少要同时具备 AI/技术信号和可复述细节；短标题可由实质正文补足。
 */
function hasSubstantiveCommunitySource(item: NormalizedItem): boolean {
  if (item.category !== "community") return true
  const sourceText = `${item.title}\n${item.rawSnippet}`.trim()
  const cjkCount = sourceText.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const latinWords = sourceText.match(/[A-Za-z0-9][A-Za-z0-9.+#/-]*/g)?.length ?? 0
  const hasTech = COMMUNITY_BRIEF_TECH_RE.test(sourceText)
  const hasEntity = COMMUNITY_BRIEF_ENTITY_RE.test(sourceText)
  const hasEvent = COMMUNITY_BRIEF_EVENT_RE.test(sourceText)
  const hasBaseFactualAction = COMMUNITY_SOURCE_FACT_ACTION_RE.test(sourceText)
  const hasDiagnosticAction = COMMUNITY_SOURCE_DIAGNOSTIC_ACTION_RE.test(sourceText)
  const hasTechnicalDetail = COMMUNITY_SOURCE_TECH_DETAIL_RE.test(sourceText)
  const hasTechnicalClaim = COMMUNITY_SOURCE_TECH_CLAIM_RE.test(sourceText)
  // “会 debug 一切”仍只是能力赞叹；诊断类动作必须同时指出故障对象/技术细节。
  const hasFactualAction = hasBaseFactualAction || (hasDiagnosticAction && hasTechnicalDetail)
  const descriptive = cjkCount >= 12 || latinWords >= 6
  const conciseTechnicalChinese = hasTech && hasTechnicalClaim && cjkCount >= 6
  return (
    (hasEvent && (hasTech || hasEntity)) ||
    (descriptive && (hasTech || hasEntity) && (hasFactualAction || hasTechnicalClaim)) ||
    conciseTechnicalChinese
  )
}

export function buildDigestPublication(input: BuildDigestPublicationInput): {
  publication: DigestPublicationV2
  audit: EditorialAudit
} {
  const itemsById = new Map(input.items.map((item) => [item.id, item]))
  const assessments = new Map<string, EditorialAssessment>()
  const decisionSetEnvelope = input.summary.editorialDecisionSet
  const usesDecisionSet = decisionSetEnvelope !== undefined
  const decisionSet = usesDecisionSet
    ? validateEditorialDecisionSet(decisionSetEnvelope, buildEditorialPromptItems(input.items))
    : null
  for (const item of input.items) {
    assessments.set(item.id, {
      itemId: item.id,
      sourceCategory: item.category,
      reviewState: "unreviewed",
      topicTags: [],
      organizationTags: [],
      ecosystemTags: [],
      regionTags: [],
      contentKind: "other",
      confidence: 0,
    })
  }

  if (decisionSet) {
    const counts = new Map<string, number>()
    for (const decision of decisionSet.decisions) {
      counts.set(decision.itemId, (counts.get(decision.itemId) ?? 0) + 1)
    }
    for (const decision of decisionSet.decisions) {
      const item = itemsById.get(decision.itemId)
      if (
        !item ||
        item.category !== decision.sourceCategory ||
        counts.get(decision.itemId) !== 1
      ) {
        continue
      }
      const hardReject = isPoliticalItem(item)
        ? ("politics" as const)
        : isUnsafeItem(item)
          ? ("unsafe" as const)
          : null
      assessments.set(item.id, {
        itemId: item.id,
        sourceCategory: item.category,
        reviewState: hardReject ? "rejected" : decision.reviewState,
        ...(hardReject
          ? { rejectReason: hardReject }
          : decision.rejectReason
            ? { rejectReason: decision.rejectReason }
            : {}),
        topicTags: [...decision.topicTags],
        organizationTags: [...decision.organizationTags],
        ecosystemTags: [...decision.ecosystemTags],
        regionTags: [...decision.regionTags],
        contentKind: hardReject ? "other" : decision.contentKind,
        confidence: decision.confidence,
        ...(decision.eventKey ? { eventKey: decision.eventKey } : {}),
      })
    }
  } else if (!usesDecisionSet) {
    for (const assessment of input.summary.editorialAssessments ?? []) {
      const item = itemsById.get(assessment.itemId)
      if (!item || item.category !== assessment.sourceCategory) continue
      assessments.set(item.id, applyEditorialPolicy(item, { ...assessment }))
    }

    for (const id of input.summary.communityDropIds ?? []) {
      const item = itemsById.get(id)
      if (!item || item.category !== "community") continue
      assessments.set(id, {
        ...assessments.get(id)!,
        reviewState: "rejected",
        rejectReason: "low_signal",
        contentKind: "other",
        confidence: 0.8,
      })
    }

    // 旧归档兼容：B027 单响应路径仍按原社区事实门失败关闭。B032 decision set 存在时，
    // 它与 clean-room 双审才是唯一语义真相，不能再被 action/detail 关键词改判。
    for (const item of input.items) {
      if (item.category !== "community" || hasSubstantiveCommunitySource(item)) continue
      const assessment = assessments.get(item.id)
      if (assessment?.reviewState !== "eligible") continue
      assessments.set(item.id, {
        ...assessment,
        reviewState: "rejected",
        rejectReason: "low_signal",
        contentKind: "other",
      })
    }
  }

  const sections: DigestPublicationV2["sections"] = []
  const eligibleAssessment = (item: NormalizedItem): EditorialAssessment | null => {
    const assessment = assessments.get(item.id)
    return assessment?.reviewState === "eligible" ? assessment : null
  }

  for (const section of input.summary.sections) {
    const entries: PublicationEntry[] = []
    for (const pick of section.picks) {
      const item = itemsById.get(pick.itemId)
      if (!item) throw new Error(`unknown item: ${pick.itemId}`)
      if (item.category !== section.category) {
        throw new Error(
          `category mismatch: ${pick.itemId} is ${item.category}, section is ${section.category}`,
        )
      }
      const assessment = eligibleAssessment(item)
      if (!assessment) continue
      const alsoItemIds = (pick.alsoItemIds ?? []).filter((id) => {
        const also = itemsById.get(id)
        return (
          also !== undefined &&
          also.category === section.category &&
          eligibleAssessment(also) !== null
        )
      })
      entries.push({
        itemId: item.id,
        role: entries.length === 0 ? "hero" : "card",
        displayTag: resolveDisplayTag(assessment, pick.tag),
        summaryZh: pick.summaryZh,
        ...(alsoItemIds.length ? { alsoItemIds } : {}),
      })
    }
    for (const id of section.briefItemIds ?? []) {
      const item = itemsById.get(id)
      if (!item) throw new Error(`unknown item: ${id}`)
      if (item.category !== section.category) {
        throw new Error(
          `category mismatch: ${id} is ${item.category}, section is ${section.category}`,
        )
      }
      if (!eligibleAssessment(item)) continue
      if (!usesDecisionSet && !hasStandaloneCommunityBriefTitle(item)) continue
      entries.push({ itemId: id, role: section.category === "podcast" ? "list" : "brief" })
    }
    if (entries.length > 0) sections.push({ category: section.category, entries })
  }

  const appendExplicitList = (category: DigestCategory, ids: string[]) => {
    if (ids.length === 0) return
    const entries: PublicationEntry[] = []
    for (const id of ids) {
      const item = itemsById.get(id)
      if (!item) throw new Error(`unknown item: ${id}`)
      if (item.category !== category) {
        throw new Error(`category mismatch: ${id} is ${item.category}, section is ${category}`)
      }
      if (category === "github") {
        if (item.githubMeta?.eligibility.state !== "yes") continue
        assessments.set(item.id, {
          itemId: item.id,
          sourceCategory: "github",
          reviewState: "eligible",
          topicTags: ["other"],
          organizationTags: [],
          ecosystemTags: ["open_source"],
          regionTags: [],
          contentKind: "engineering",
          confidence: item.githubMeta.eligibility.confidence,
        })
      } else if (!eligibleAssessment(item)) {
        continue
      }
      entries.push({ itemId: id, role: "list" })
    }
    sections.push({ category, entries })
  }
  appendExplicitList("github", input.githubItemIds)
  appendExplicitList("podcast", input.podcastItemIds)

  const publishedRefs = new Set(
    sections.flatMap((section) =>
      section.entries.flatMap((entry) => [entry.itemId, ...(entry.alsoItemIds ?? [])]),
    ),
  )
  const overviewRefs = (input.summary.overviewRefs ?? []).filter(
    (overview) =>
      overview.itemIds.length > 0 && overview.itemIds.every((id) => publishedRefs.has(id)),
  )
  const publication: DigestPublicationV2 = {
    schemaVersion: 2,
    businessDate: input.businessDate,
    overview: overviewRefs.map((overview) => overview.text),
    ...(overviewRefs.length ? { overviewRefs } : {}),
    sections,
  }
  const audit: EditorialAudit = {
    policyVersion: usesDecisionSet
      ? (decisionSet?.policyVersion ?? EDITORIAL_POLICY_VERSION)
      : "B027-v1",
    assessments: input.items.map((item) => assessments.get(item.id)!),
  }
  assertValidDigestPublication(publication, input.items, audit.assessments)
  return { publication, audit }
}

export function getPublishedItemIds(publication: DigestPublicationV2): string[] {
  return publication.sections.flatMap((section) => section.entries.map((entry) => entry.itemId))
}

export type MissingAiCoverage = "inference" | "non_inference"

export interface DigestOverviewDensityValidation {
  valid: boolean
  actual: number
  requiredMin: number
  allowedMax: 8
  approvedCount: number
}

/**
 * B032 的 Composer 合同必须一直保持到邮件终态，不能在字节预算裁剪后静默降成稀疏速览。
 * 旧摘要没有 decision set，继续按原兼容语义放行，不用新合同倒查历史归档。
 */
export function validateDigestOverviewDensity(
  publication: DigestPublicationV2,
  summary: DigestSummary,
): DigestOverviewDensityValidation {
  const decisionSet = summary.editorialDecisionSet
  const approvedCount =
    decisionSet?.decisions.filter((decision) => decision.reviewState === "eligible").length ?? 0
  const requiredMin = decisionSet ? (approvedCount >= 5 ? 5 : approvedCount > 0 ? 1 : 0) : 0
  const actual = publication.overview.length
  const overviewRefs = publication.overviewRefs ?? []
  const refsValid =
    overviewRefs.length === actual &&
    overviewRefs.every(
      (overview, index) =>
        overview.itemIds.length > 0 && overview.text === publication.overview[index],
    ) &&
    hasPairwiseDisjointOverviewItemIds(overviewRefs)
  return {
    valid: !decisionSet || (actual >= requiredMin && actual <= 8 && refsValid),
    actual,
    requiredMin,
    allowedMax: 8,
    approvedCount,
  }
}

/**
 * 从结构复核后的 audit 推导本期必须保留的 AI 双侧，再检查终态 publication。
 * supporting source 不是独立内容卡，不能用 alsoItemIds 冒充另一侧代表。
 */
export function missingRequiredAiCoverage(
  publication: DigestPublicationV2,
  assessments: EditorialAssessment[],
): MissingAiCoverage[] {
  const eligibleAi = assessments.filter(
    (assessment) => assessment.sourceCategory === "ai" && assessment.reviewState === "eligible",
  )
  const requiresInference = eligibleAi.some(isInferenceAssessment)
  const requiresNonInference = eligibleAi.some((assessment) => !isInferenceAssessment(assessment))
  const publishedAiIds = new Set(
    publication.sections
      .filter((section) => section.category === "ai")
      .flatMap((section) => section.entries.map((entry) => entry.itemId)),
  )
  const publishedAi = eligibleAi.filter((assessment) => publishedAiIds.has(assessment.itemId))
  const missing: MissingAiCoverage[] = []
  if (requiresInference && !publishedAi.some(isInferenceAssessment)) missing.push("inference")
  if (requiresNonInference && !publishedAi.some((assessment) => !isInferenceAssessment(assessment)))
    missing.push("non_inference")
  return missing
}

/** 邮件预算裁剪后固化最终发布集合；只删尾部未实际显示项，不重新发现任何 raw 条目。 */
export function filterDigestPublication(
  publication: DigestPublicationV2,
  displayedItemIds: ReadonlySet<string>,
): DigestPublicationV2 {
  const sections = publication.sections
    .map((section) => ({
      ...section,
      entries: section.entries
        .filter((entry) => displayedItemIds.has(entry.itemId))
        .map((entry) => ({
          ...entry,
          ...(entry.alsoItemIds
            ? { alsoItemIds: entry.alsoItemIds.filter((id) => displayedItemIds.has(id)) }
            : {}),
        })),
    }))
    .filter((section) => section.entries.length > 0)
  const remainingIds = new Set(
    sections.flatMap((section) =>
      section.entries.flatMap((entry) => [entry.itemId, ...(entry.alsoItemIds ?? [])]),
    ),
  )
  const overviewRefs = (publication.overviewRefs ?? []).filter((overview) =>
    overview.itemIds.every((id) => remainingIds.has(id)),
  )
  return {
    ...publication,
    overview: overviewRefs.map((overview) => overview.text),
    ...(overviewRefs.length ? { overviewRefs } : { overviewRefs: undefined }),
    sections,
  }
}

export function assertValidDigestPublication(
  publication: DigestPublicationV2,
  items: NormalizedItem[],
  assessments: EditorialAssessment[],
): void {
  const itemsById = new Map(items.map((item) => [item.id, item]))
  const assessmentsById = new Map(assessments.map((assessment) => [assessment.itemId, assessment]))
  const seenSections = new Set<DigestCategory>()
  const seenItems = new Set<string>()
  for (const section of publication.sections) {
    if (seenSections.has(section.category))
      throw new Error(`duplicate section: ${section.category}`)
    seenSections.add(section.category)
    for (const entry of section.entries) {
      if (seenItems.has(entry.itemId)) throw new Error(`duplicate item: ${entry.itemId}`)
      seenItems.add(entry.itemId)
      const item = itemsById.get(entry.itemId)
      if (!item) throw new Error(`unknown item: ${entry.itemId}`)
      if (item.category !== section.category) {
        throw new Error(
          `category mismatch: ${entry.itemId} is ${item.category}, section is ${section.category}`,
        )
      }
      const assessment = assessmentsById.get(entry.itemId)
      if (!assessment || assessment.reviewState !== "eligible") {
        throw new Error(
          `${assessment?.reviewState ?? "missing"} item cannot be published: ${entry.itemId}`,
        )
      }
      for (const alsoId of entry.alsoItemIds ?? []) {
        if (seenItems.has(alsoId)) throw new Error(`duplicate item: ${alsoId}`)
        const also = itemsById.get(alsoId)
        if (!also) throw new Error(`unknown also item: ${alsoId}`)
        if (also.category !== section.category) {
          throw new Error(`category mismatch for also item: ${alsoId}`)
        }
        const alsoAssessment = assessmentsById.get(alsoId)
        if (!alsoAssessment || alsoAssessment.reviewState !== "eligible") {
          throw new Error(
            `${alsoAssessment?.reviewState ?? "missing"} also item cannot be published: ${alsoId}`,
          )
        }
        seenItems.add(alsoId)
      }
    }
  }
  const overviewRefs = publication.overviewRefs ?? []
  if (
    overviewRefs.length !== publication.overview.length ||
    overviewRefs.some((overview, index) => overview.text !== publication.overview[index])
  ) {
    throw new Error("overview must be backed by overviewRefs")
  }
  if (!hasPairwiseDisjointOverviewItemIds(overviewRefs)) {
    throw new Error("overview item ID reused across overview entries")
  }
  for (const overview of overviewRefs) {
    if (overview.itemIds.length === 0 || overview.itemIds.some((id) => !seenItems.has(id))) {
      throw new Error("overview references unpublished item")
    }
  }
}
