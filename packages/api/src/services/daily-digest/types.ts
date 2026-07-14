/**
 * F037 DailyBrief 日报系统 — 终态类型合同。
 * 设计合同 v2 见 docs/features/F037-daily-news-digest.md（德彪 Design Gate r2 GO）。
 */

import type { SafeHttpClient as SharedSafeHttpClient } from "../../net/safe-http-client"

// 2026-07-03 小孙拍板「让我们纯粹一点」：删篮球/电竞/股市三板块，聚焦 AI+热点+X+GitHub。
// 2026-07-06 小孙改版：「x」板块扩成「community 社区动态」（X + Reddit + Digg + V2EX + 小红书——
// 社区里的人在聊什么）；旧归档里的 "x" 由读取侧 normalizeDigestCategory 归一。
// 2026-07-10 #33 播客速递（小孙拍「现在搞」）：小宇宙新集转写提炼；有获批新集才出现。
// B027 起单集也进入语义审核，publication 批准后仍复用原列表样式。
export type DigestCategory = "ai" | "hot" | "community" | "github" | "podcast"

export interface NormalizedItem {
  /** sha1(sourceId + "\n" + canonicalUrl) 前 16 hex */
  id: string
  /** canonicalUrl 归一（去 utm 参数、fragment、尾斜杠，host 小写）——跨源去重键 */
  dedupeKey: string
  category: DigestCategory
  sourceId: string
  title: string
  canonicalUrl: string
  /** ISO8601；源日期无效（如虎扑 Invalid Date）则 null */
  publishedAt: string | null
  /** 纯文本 ≤2000 字符 */
  rawSnippet: string
  /**
   * 平台内可比的互动量信号（质量层 1，主表 §2）：HN points/Reddit score/HF upvotes/
   * 热榜热度/V2EX 回复数/Digg 聚合帖数。只做**同源内**预排序与选材参考，
   * 不跨平台直比（量纲不同）；缺省 = 该源无此信号（RSS 博客类）。
   */
  engagement?: number
  /**
   * 结构先验分组标签（小孙 07-05 分栏改版）：源侧就知道的归属，如 X 账号的
   * 「公司/从业者」（x-handle-groups 静态映射）。语义类分组（ai 推理/公司、hot 分类）
   * 不在此——那是 LLM 打在 pick.tag 上的。
   */
  topicTag?: string
  /** B028 GitHub 结构化事实；renderer 只读展示，不再反解析它来决定排名/准入。 */
  githubMeta?: {
    repo: string
    period: "daily" | "weekly" | "monthly" | "newcomer"
    windowStars: number
    totalStars: number
    language: string
    description: string
    /** 判定时实际可用的证据面；不保存 README 正文，只保存取证状态与 topics。 */
    evidence: {
      topics: string[]
      metadataStatus: "embedded" | "loaded" | "failed" | "not_requested"
      readmeStatus: "loaded" | "failed" | "not_requested"
      evidenceComplete: boolean
    }
    eligibility: {
      state: "yes" | "no" | "unknown"
      confidence: number
      reasons: string[]
    }
    rankStatus?: { kind: "new" } | { kind: "streak"; days: number } | { kind: "returning" }
  }
}

export interface SourceFetchResult {
  sourceId: string
  status: "ok" | "failed" | "timeout"
  items: NormalizedItem[]
  errors: string[]
  attempts: number
  fetchedAt: string
  durationMs: number
}

export interface SourceFetchContext {
  http: SafeHttpClient
  /** 直连客户端（不走代理）：源 def.direct=true 时优先用（对代理出口 IP 反爬的源） */
  httpDirect?: SafeHttpClient
  signal: AbortSignal
  now: () => Date
}

/**
 * fetch 契约（07-06 纠偏后，德彪 r3 P2 注释同步）：
 * - **坏源要抛错**（解析不出/全 URL 尽头/凭证失效）→ orchestrator 记 failed 进健康/告警链；
 * - **返回 [] = 健康空**（源活着只是本窗口没货，如安静频道被时效窗滤空）→ 记 ok 不告警。
 * 新增 source 别把坏源写成静默 ok-0。
 */
export interface DigestSource {
  sourceId: string
  category: DigestCategory
  /** 长跑源（如 X 逐账号限速）覆盖 orchestrator 默认单源超时（45s） */
  timeoutBudgetMs?: number
  fetch(ctx: SourceFetchContext): Promise<NormalizedItem[]>
}

// 出站 HTTP 安全合同（AC10）真相源已收敛到共享模块（F041 W7，F040「谁先落地谁抽」合同清账）。
// options/error kind 直接 re-export；SafeHttpClient 在本域窄化为 fetchText 单法面——
// daily-digest 只消费 fetchText（测试 fixture 据此不用陪跑 request()），共享实现是其超集。
export type { SafeHttpErrorKind, SafeHttpFetchOptions } from "../../net/safe-http-client"
export type SafeHttpClient = Pick<SharedSafeHttpClient, "fetchText">

// 幂等 ledger（D10）原语已提升共享（F041 W7）：lib/attempt-ledger.ts；
// 域内旧名别名 re-export 保住既有 import 面（key=businessDate）。
export type {
  AttemptLedgerState as DigestLedgerState,
  AttemptLedger as DigestLedger,
} from "../../lib/attempt-ledger"

/** 源健康持久化（AC8）：连续失败判定重启不丢 */
export interface SourceHealthStore {
  record(date: string, results: SourceFetchResult[]): void
  consecutiveFailures(sourceId: string, endDate: string): number
}

/** summarizer 输出：LLM 只引用 item id，绝不产 URL/HTML（注入护栏） */
export interface DigestSummary {
  /** 今日速览 5-8 条中文 */
  overview: string[]
  /** B027：每条速览必须引用输入事件；publication 只保留最终发布集合内的引用。 */
  overviewRefs?: DigestOverviewRef[]
  /** B027：语义审核的真实输出；缺失/非法 = unreviewed，发布侧失败关闭。 */
  editorialAssessments?: EditorialAssessment[]
  /** B032：服务端冻结的证据化编辑决定；新生产路径优先，外层归档仍保持 schema v2。 */
  editorialDecisionSet?: EditorialDecisionSet
  sections: Array<{
    category: DigestCategory
    picks: Array<{
      itemId: string
      summaryZh: string
      /** 质量层 2 跨源合并：同一事件的其他来源 id（≤4，多源印证即头条信号） */
      alsoItemIds?: string[]
      /**
       * 分栏标签（小孙 07-05）：LLM 按板块白名单打标（ai=推理/公司/国产/开源/研究…，
       * hot=科技/民生/体育…），parse 守卫白名单外丢弃；x 板块忽略 LLM 标签
       * （用 item.topicTag 结构先验）。渲染层据此分组出子栏。
       */
      tag?: string
    }>
    /**
     * B027 正向发布许可：可进入现有「其余速览」形态的条目 id。
     * 新版 renderer 只消费这里明确列出的 id；缺字段 = 本节没有获批速览，不再从 raw pool 补位。
     */
    briefItemIds?: string[]
  }>
  /**
   * 质量层 3 两段式深读产物：简报型源（smol.ai 类标题无信息量）正文二次提炼——
   * titleZh 重写展示标题 + summaryZh 深提炼；渲染层按 itemId 覆盖展示，链接仍走 canonicalUrl
   */
  deepReads?: Array<{ itemId: string; titleZh: string; summaryZh: string }>
  /**
   * 中文化补全（小孙 07-06「github 介绍是英文的」「速览标题太扯」）：github 板块不进主 LLM，
   * 这两张 map 由 translateExtras 单独一次调用产出（fail-open：缺 map/缺 id 回落英文原文）。
   * key 都是 item id；随 summary.json 落盘，邮件与网页版共用。
   */
  githubDescZh?: Record<string, string>
  restTitleZh?: Record<string, string>
  /**
   * 截断修复缺节账（德彪 r-final P1-3 + r2 P2）：repair 成功 parse 后「送审但缺失」的
   * 类目清单。**保守语义**：repair 下无法区分截断丢失与模型主动省节，两者都记（宁可多
   * 回补一天，不可漏回补）。job 在邮件 notes 透出；shown 只记录最终 publication。
   */
  repairDroppedCategories?: DigestCategory[]
  /**
   * 旧版社区速览反选兼容字段。B027 起 publication 只认正向 eligible assessment；
   * 此字段只能追加拒绝，缺失或被熔断都不能使未审核条目获准发布。
   */
  communityDropIds?: string[]
  /** 旧版 renderer 的社区审查视野兼容字段；v2 publication 不用它授予发布权限。 */
  communityFedIds?: string[]
  /** 旧归档/注入摘要兼容标记；生产 summarizer 全败时返回 null，不再生成清单版。 */
  degraded: boolean
}

export interface RenderedDigest {
  subject: string
  html: string
  markdown: string
  /** 本次渲染实际展示的「其余速览」行 id（中文化补全：job 层据此送翻译后二次渲染） */
  restItemIds: string[]
  /** 本次最终渲染实际出现的全部条目 id（精选/列表/速览/同报），shown ledger 的唯一输入。 */
  displayedItemIds: string[]
}

export type EditorialReviewState = "eligible" | "rejected" | "unreviewed"
export type EditorialRejectReason =
  | "help"
  | "complaint"
  | "gossip"
  | "self_promo"
  | "unsafe"
  | "politics"
  | "low_signal"
  | "classifier_failure"
  | "other"
export type EditorialTopicTag =
  | "inference"
  | "research"
  | "training"
  | "agent"
  | "model_release"
  | "safety"
  | "other"
export type EditorialContentKind =
  | "research"
  | "engineering"
  | "release"
  | "discussion"
  | "industry"
  | "finance"
  | "help"
  | "complaint"
  | "gossip"
  | "other"

/** B027 审核事实；发布与否由 publication 中是否出现决定，不再复用 reviewState 表意。 */
export interface EditorialAssessment {
  itemId: string
  sourceCategory: DigestCategory
  reviewState: EditorialReviewState
  rejectReason?: EditorialRejectReason
  topicTags: EditorialTopicTag[]
  organizationTags: string[]
  ecosystemTags: Array<"open_source" | "closed_source">
  regionTags: Array<"cn" | "global">
  contentKind: EditorialContentKind
  confidence: number
  eventKey?: string
}

export type EditorialBasis =
  | "research_result"
  | "engineering_work"
  | "product_release"
  | "technical_discussion"
  | "ai_industry_event"
  | "finance_event"
  | "personal_help"
  | "complaint"
  | "gossip"
  | "self_promo_only"
  | "reaction_only"
  | "off_topic"
  | "unsafe"
  | "politics"
  | "insufficient_context"
  | "mixed_signals"

export type EditorialEvidenceSupport =
  | "ai_relevance"
  | "substantive_fact"
  | "inference_technical"
  | "finance_context"
  | "disqualifier"

export interface EditorialEvidence {
  field: "title" | "snippet"
  quote: string
  supports: EditorialEvidenceSupport
}

export interface EditorialReviewerTarget {
  provider: "claude" | "codex"
  model: string
  effort?: string
}

export type EditorialReviewerSlot =
  | "review_a"
  | "review_b"
  | "codex_pass_1"
  | "codex_pass_2"
  | "codex_pass_3"
export type EditorialReviewMode = "multi_target" | "degraded_same_target"

/** 模型只产 basis/tags/evidence；reviewerTarget 必须由服务端 executor 注入。 */
export interface EditorialReviewVote {
  itemId: string
  basis: EditorialBasis
  topicTags: EditorialTopicTag[]
  organizationTags: string[]
  ecosystemTags: Array<"open_source" | "closed_source">
  regionTags: Array<"cn" | "global">
  evidence: EditorialEvidence[]
  confidence?: number
  reviewerTarget: EditorialReviewerTarget
  reviewerSlot: EditorialReviewerSlot
}

/**
 * B032 三态复用既有发布合同：eligible=publish、rejected=reject、unreviewed=abstain。
 * 不另存重复 verdict，避免审核真相出现互相矛盾的双状态。
 */
export interface EditorialDecision extends EditorialAssessment {
  basis?: EditorialBasis
  reviewMode: EditorialReviewMode
  votes: EditorialReviewVote[]
}

export interface EditorialDecisionSet {
  schemaVersion: 1
  policyVersion: string
  inputHash: string
  reviewMode: EditorialReviewMode
  decisions: EditorialDecision[]
}

export interface DigestOverviewRef {
  text: string
  itemIds: string[]
}

export interface EditorialAudit {
  policyVersion: string
  assessments: EditorialAssessment[]
}

export type PublicationRole = "hero" | "card" | "brief" | "list"

export interface PublicationEntry {
  itemId: string
  role: PublicationRole
  displayTag?: string
  summaryZh?: string
  alsoItemIds?: string[]
}

/** 邮件、web curated 与 shown ledger 共同消费的唯一发布清单。 */
export interface DigestPublicationV2 {
  schemaVersion: 2
  businessDate: string
  overview: string[]
  overviewRefs?: DigestOverviewRef[]
  sections: Array<{ category: DigestCategory; entries: PublicationEntry[] }>
}
