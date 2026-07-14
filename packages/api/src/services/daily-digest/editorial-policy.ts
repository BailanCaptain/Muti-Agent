import {
  isCommunityNoiseItem,
  isHighConfidenceCommunitySourceNoiseItem,
  isPoliticalItem,
  isUnsafeItem,
} from "./relevance-filter"
import { sanitizeTag } from "./section-tags"
import type {
  EditorialAssessment,
  EditorialContentKind,
  EditorialRejectReason,
  NormalizedItem,
} from "./types"

const FINANCE_RE =
  /(?:循环融资|融资模式|融资轮|融资|注资|换股|入股|持股|募资|估值|股价|股票|股份|投资交易|\bcircular financing\b|\bfinancing\b|\bfunding round\b|\binvest(?:s|ed|ment|ments|ing)?\b|\bequity\b|\bstake\b|\bvaluation\b|\bstock price\b|\bshares?\b)/i
const HELP_RE =
  /(?:求助|请教|求建议|想听听建议|怎么办|该怎么|怎么选|迷茫|入行|转行|求职|专科|大[一二三四]|研[一二三]|\bneed advice\b|\bcareer advice\b|\bfeeling lost\b|\bbeginner question\b)/i
const COMPLAINT_RE =
  /(?:奔三|飘忽不定|感觉自己|吐槽|抱怨|焦虑|破防|烦恼|后悔|情绪低落|崩溃|\brant\b|\bventing\b)/i
const GOSSIP_RE =
  /(?:(?:Tim Cook|Sam Altman).*(?:致信|私信|会面|交谈|letter|writes? to)|(?:致信|私信|会面|交谈|letter|writes? to).*(?:Tim Cook|Sam Altman)|名人往来|轶闻|八卦)/i

function structuralKind(item: NormalizedItem): {
  contentKind: EditorialContentKind
  rejectReason?: EditorialRejectReason
} | null {
  const text = `${item.title}\n${item.rawSnippet.slice(0, 600)}`
  if (isPoliticalItem(item)) return { contentKind: "other", rejectReason: "politics" }
  if (isUnsafeItem(item)) return { contentKind: "other", rejectReason: "unsafe" }
  // 求助/抱怨/名人轶闻是「社区动态」的结构性噪声边界。不能把同一词根扩散到
  // AI/产业报道（例如“转行做 AI 的工程师翻倍——行业调查”）造成全局误杀。
  if (item.category === "community") {
    if (GOSSIP_RE.test(text)) return { contentKind: "gossip", rejectReason: "gossip" }
    if (HELP_RE.test(text)) return { contentKind: "help", rejectReason: "help" }
    if (COMPLAINT_RE.test(text)) return { contentKind: "complaint", rejectReason: "complaint" }
    // 最终 publication 不能只信模型的 discussion/agent 标签；复用抓取前的标题性质门，
    // 把不含显式“求助/抱怨”词、但仍是个人选项征询/职场情绪/生活杂事的标题挡住。
    if (isCommunityNoiseItem(item)) return { contentKind: "other", rejectReason: "low_signal" }
    // 中性技术标题也不能掩盖正文中的个人征询、抱怨或生活叙事；这里只用高置信组合，
    // 避免把技术长文中顺带提到的生活词误判为整篇主题。
    if (isHighConfidenceCommunitySourceNoiseItem(item)) {
      return { contentKind: "other", rejectReason: "low_signal" }
    }
  }
  if (FINANCE_RE.test(text)) return { contentKind: "finance" }
  return null
}

/**
 * LLM 审核事实的结构性复核。结构层只覆盖高置信硬边界，不从展示 tag 反推语义。
 * community/podcast 采用正向准入：必须是 AI 实质内容且类型属于研究/工程/发布/讨论。
 */
export function applyEditorialPolicy(
  item: NormalizedItem,
  assessment: EditorialAssessment,
): EditorialAssessment {
  const hard = structuralKind(item)
  let next: EditorialAssessment = hard
    ? {
        ...assessment,
        contentKind: hard.contentKind,
        ...(hard.contentKind === "finance"
          ? { topicTags: assessment.topicTags.filter((tag) => tag !== "inference") }
          : {}),
        ...(hard.rejectReason ? { reviewState: "rejected", rejectReason: hard.rejectReason } : {}),
      }
    : assessment

  if (next.reviewState !== "eligible") return next
  if (item.category === "community" || item.category === "podcast") {
    const allowedKind = ["research", "engineering", "release", "discussion"].includes(
      next.contentKind,
    )
    const aiSubstance = next.topicTags.some((tag) => tag !== "other")
    if (!allowedKind || !aiSubstance) {
      next = { ...next, reviewState: "rejected", rejectReason: "low_signal" }
    }
  }
  return next
}

const INFERENCE_CONTENT_KINDS: ReadonlySet<EditorialContentKind> = new Set([
  "research",
  "engineering",
  "release",
  "discussion",
])

/** 推理审核事实的唯一判定：既要有 inference 主题，也必须是技术/研究/发布/实质讨论。 */
export function isInferenceAssessment(assessment: EditorialAssessment): boolean {
  return (
    assessment.reviewState === "eligible" &&
    assessment.sourceCategory === "ai" &&
    assessment.topicTags.includes("inference") &&
    INFERENCE_CONTENT_KINDS.has(assessment.contentKind)
  )
}

/**
 * 将多轴审核标签压成现有邮件所需的单一展示标签。
 * 这是展示路由，不做发布准入；reviewState 不是 eligible 时调用方仍必须拒绝发布。
 */
export function resolveDisplayTag(
  assessment: EditorialAssessment,
  requestedTag?: string,
): string | undefined {
  if (assessment.sourceCategory !== "ai") return requestedTag

  if (isInferenceAssessment(assessment)) return "推理"

  if (requestedTag === "推理") return "其他"
  const requested = sanitizeTag("ai", requestedTag)
  if (requested && requested !== "推理") return requested

  const organization = assessment.organizationTags[0]
  if (organization) return sanitizeTag("ai", organization) ?? "其他"
  if (assessment.regionTags.includes("cn")) return "国产"
  if (assessment.ecosystemTags.includes("open_source")) return "开源"
  if (assessment.topicTags.includes("research")) return "研究"
  return "其他"
}
