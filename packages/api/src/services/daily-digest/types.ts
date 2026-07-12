/**
 * F037 DailyBrief 日报系统 — 终态类型合同。
 * 设计合同 v2 见 docs/features/F037-daily-news-digest.md（德彪 Design Gate r2 GO）。
 */

// 2026-07-03 小孙拍板「让我们纯粹一点」：删篮球/电竞/股市三板块，聚焦 AI+热点+X+GitHub。
// 2026-07-06 小孙改版：「x」板块扩成「community 社区动态」（X + Reddit + Digg + V2EX + 小红书——
// 社区里的人在聊什么）；旧归档里的 "x" 由读取侧 normalizeDigestCategory 归一。
// 2026-07-10 #33 播客速递（小孙拍「现在搞」）：小宇宙新集转写提炼；有新集才出现的板块，
// 与 github 同为「items 直渲」流——不进 summarizer LLM 挑选。
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

export type SafeHttpErrorKind =
  | "scheme"
  | "userinfo"
  | "port"
  | "host_not_allowed"
  | "ip_blocked"
  | "redirect_limit"
  | "redirect_invalid"
  | "too_large"
  | "timeout"
  | "http_status"
  | "network"

export interface SafeHttpFetchOptions {
  headers?: Record<string, string>
  /** 解压后响应体上限，默认 2MB */
  maxBytes?: number
  /** 默认 20s */
  timeoutMs?: number
  /** 默认 GET；POST 目前唯一消费方=小红书 sidecar MCP 调用（#31）。全套出站校验与 GET 同链 */
  method?: "GET" | "POST"
  /** 仅 method=POST 时随请求发出 */
  body?: string
}

/** 出站 HTTP 安全合同（AC10）：非 2xx/超限/校验失败均抛 SafeHttpError */
export interface SafeHttpClient {
  fetchText(url: string, opts?: SafeHttpFetchOptions): Promise<string>
}

/** 幂等 ledger（D10）：attempted 计数 + sent 唯一终态；失败只记在 attempt 明细，非终态 */
export interface DigestLedgerState {
  attempts: Array<{ at: string; note: string }>
  sent: { at: string; messageId: string; to: string } | null
}

export interface DigestLedger {
  read(businessDate: string): DigestLedgerState
  recordAttempt(businessDate: string, note: string): void
  recordSent(businessDate: string, meta: { messageId: string; to: string }): void
}

/** 源健康持久化（AC8）：连续失败判定重启不丢 */
export interface SourceHealthStore {
  record(date: string, results: SourceFetchResult[]): void
  consecutiveFailures(sourceId: string, endDate: string): number
}

/** summarizer 输出：LLM 只引用 item id，绝不产 URL/HTML（注入护栏） */
export interface DigestSummary {
  /** 今日速览 5-8 条中文 */
  overview: string[]
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
   * 截断修复缺节账（德彪 r-final P1-3 + r2 P2）：repair 成功 parse 后「喂过样但缺失」的
   * 类目清单。**保守语义**：repair 下无法区分截断丢失与模型主动省节，两者都记（宁可多
   * 回补一天，不可漏回补）。job 据此不把该类目喂样烧进 shown，并在邮件 notes 透出。
   */
  repairDroppedCategories?: DigestCategory[]
  /**
   * 社区速览行语义反选（07-12 小孙「社区动态要研究/讨论/进展」）：LLM 判定性质不合格
   * （求助/闲聊/名人八卦）的 community 条目 id——速览行是渲染层直出未 pick 条目，选材
   * 规则管不到它，这是唯一的语义把关口。结构层 COMMUNITY_NOISE_RE 词表在前，这里兜
   * 词表抓不住的。fail-open：缺字段 = 不滤（现状）；渲染层再按 category 限定双保险。
   */
  communityDropIds?: string[]
  /**
   * 社区语义审查集合（德彪 hitrate-r1 P1）：本期真正进过 LLM 视野的 community 条目 id
   * （喂样有 36 上限，视野外条目 LLM 无从反选）。渲染层速览候选与之闭合——「未审=不上」，
   * 否则第 37+ 条八卦帖会绕过反选补位进邮件。缺字段（老 summary/降级链）= fail-open 不限。
   */
  communityFedIds?: string[]
  /** true = LLM 降级链全挂，走清单版（AC11） */
  degraded: boolean
}

export interface RenderedDigest {
  subject: string
  html: string
  markdown: string
  /** 本次渲染实际展示的「其余速览」行 id（中文化补全：job 层据此送翻译后二次渲染） */
  restItemIds: string[]
}
