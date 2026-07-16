import fs from "node:fs"
import path from "node:path"
import { type EmailSender, appendOutboundLedger } from "../../lib/email-sender"
import { DIGEST_TZ, formatBusinessDate } from "./business-dates"
import { validateEditorialDecisionSet } from "./editorial-decider"
import {
  applyGithubRankStatuses,
  loadGithubRankHistory,
  writeGithubRankSnapshot,
} from "./github-rank-state"
import { runAllSources } from "./orchestrator"
import {
  buildDigestPublication,
  filterDigestPublication,
  missingRequiredAiCoverage,
  validateDigestOverviewDensity,
} from "./publication"
import { isPoliticalItem, isUnsafeItem } from "./relevance-filter"
import { renderDigest, splitGithubSnippet } from "./renderer"
import { loadShownKeys, writeShownLedger } from "./shown-ledger"
import {
  type TranslateExtrasInput,
  type TranslateExtrasResult,
  buildEditorialPromptItems,
  isInferenceReviewCandidate,
} from "./summarizer"
import type {
  DigestLedger,
  DigestPublicationV2,
  DigestSource,
  DigestSummary,
  NormalizedItem,
  SafeHttpClient,
  SourceHealthStore,
} from "./types"

/**
 * T13 reconcile(businessDate) 幂等单入口（D10/D11，德彪 Design Gate r2 GO）：
 * 三个触发点（07:30 主 cron / startup / 每小时安全网）共用本函数。
 * attempt 语义 = 发送尝试（构建失败不烧 attempt）；attempted≥2 无 sent → 转人工。
 */

export type ReconcileStatus =
  | "skipped_not_due"
  | "skipped_already_sent"
  | "skipped_needs_manual"
  | "failed_no_items"
  | "failed_summarize"
  | "send_failed"
  | "ok"

export interface ReconcileOutcome {
  status: ReconcileStatus
  businessDate: string
  degraded?: boolean
  detail?: string
}

/** 失败态子集：cron 适配层（scheduler-bootstrap runDigestReconcile）据此抛错 → trace failed
 *  → R-201 告警链；skipped_* 是幂等噪音不告警。新增 ReconcileStatus 必须在下方穷尽检查里归类——
 *  07-11 三拍 r1 P2-1（德彪）：failed_summarize 曾漏在适配层硬编码判断外 → 摘要全败被监控标绿。 */
export const DIGEST_FAILURE_STATUSES = [
  "failed_no_items",
  "failed_summarize",
  "send_failed",
] as const satisfies readonly ReconcileStatus[]

export function isDigestFailureStatus(status: ReconcileStatus): boolean {
  return (DIGEST_FAILURE_STATUSES as readonly ReconcileStatus[]).includes(status)
}

// 编译期穷尽：每个 ReconcileStatus 必须归入失败态或非失败态白名单，新增状态漏归类 = tsc 红
type NonFailureStatus = "ok" | "skipped_not_due" | "skipped_already_sent" | "skipped_needs_manual"
type UnclassifiedStatus = Exclude<
  ReconcileStatus,
  (typeof DIGEST_FAILURE_STATUSES)[number] | NonFailureStatus
>
const _statusExhaustive: [UnclassifiedStatus] extends [never]
  ? true
  : { 未归类的新状态: UnclassifiedStatus } = true
void _statusExhaustive

/**
 * F037 设置页 · 每轮 reconcile 开头现读的动态覆盖（boot 从 runtime-config `dailyDigest`
 * 段构建）：改设置下一轮即生效，不重启。字段缺省 → 用 deps 静态值（.env 组装的原链）。
 */
export type DigestRunOverrides = Partial<
  Pick<
    DailyDigestJobDeps,
    | "sources"
    | "githubSources"
    | "githubMonthlySources"
    | "githubDailySources"
    | "summarize"
    | "translateExtras"
    | "sender"
    | "recipient"
    | "sendTime"
    | "webBaseUrl"
  >
> & {
  /** 邮件密度：每板块「其余速览」行数（renderer 默认 12） */
  restOverviewRows?: number
}

export interface DailyDigestJobDeps {
  ledger: DigestLedger
  health: SourceHealthStore
  /** 常规源（AI/热点/X） */
  sources: DigestSource[]
  /** 周一附加（GitHub 周榜 + 新贵榜） */
  githubSources?: DigestSource[]
  /** 每天常驻（#27 GitHub 月榜——07-06 前是每月 1 号，小孙「月榜咋没有了」后改常驻） */
  githubMonthlySources?: DigestSource[]
  /** 每天附加（增长榜(日)，小孙 07-05 分栏改版 #2） */
  githubDailySources?: DigestSource[]
  http: SafeHttpClient
  /** 直连客户端（def.direct 源用，代理场景） */
  httpDirect?: SafeHttpClient
  summarize: (items: NormalizedItem[], businessDate: string) => Promise<DigestSummary | null>
  /** 中文化补全（07-06）：github desc + 速览标题批量翻译；缺省/失败 → 英文原文直出 */
  translateExtras?: (input: TranslateExtrasInput) => Promise<TranslateExtrasResult>
  sender: EmailSender
  recipient: string
  /** 归档根：.runtime/daily-digest */
  baseDir: string
  /** 正式去重起算日；此前 shown 账本保留但不参与跨日筛选。 */
  shownLedgerNotBefore?: string
  /** "HH:mm"，默认 07:30 */
  sendTime?: string
  timeZone?: string
  perSourceTimeoutMs?: number
  /** 邮件 HTML 字节预算（默认 98KiB，低于 Gmail 102KB 裁剪线）；超了先降密度，耗尽仍超则不发送 */
  emailByteBudget?: number
  pushAlert?: (message: string) => void
  log?: (msg: string) => void
  /** 网页版基址（MULTI_AGENT_DIGEST_WEB_BASE）：配置则邮件带「网页版 →」链接 */
  webBaseUrl?: string
  /** 设置页动态覆盖（缺省 = 纯静态 deps，既有测试/调用方零改动） */
  runtimeSettings?: () => DigestRunOverrides
}

function timeOfDayInTz(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now)
}

/** E1 新鲜窗：publishedAt 距 now 超 7 天的条目不进选材视野（低频博客发文后一周内仍可见） */
const FRESH_WINDOW_MS = 7 * 24 * 3600_000

/** 07-12 小孙增强：yt 条目延迟 24h 进报——YouTube 自动字幕生成有延迟（分钟~小时级），
 * 太新的视频拉不到字幕会被摘除门降速览消费掉（喂样烧 shown = 永失精选机会）；押后一天
 * 待字幕就绪再进选材池，视频以完整精选形态竞争。无日期条目放行（摘除门兜底检讨文）。
 * 与 7 天新鲜窗组合后 yt 可见窗 = 发布后第 2~7 天 */
const YT_SETTLE_MS = 24 * 3600_000

/** 板块中文名（修复丢节 note 用；与 renderer SECTION_META 语义对齐的最小映射） */
const SECTION_LABEL: Record<string, string> = { ai: "AI", hot: "热点", community: "社区" }

export function createDailyDigestJob(deps: DailyDigestJobDeps) {
  const timeZone = deps.timeZone ?? DIGEST_TZ
  const log = deps.log ?? (() => {})
  const pushAlert = deps.pushAlert ?? (() => {})

  /**
   * 德彪 P1r1-P1：三个触发点（07:30 主 cron / 每小时安全网 / startup）是**不同 job 名**，
   * scheduler 的 reentrancy guard 是 per-name → 跨触发点可并发进入同一 businessDate。
   * 进程内互斥串行化（跨进程由 leader lease 挡）：后到者排队，醒来后 ledger 已 sent → 幂等跳过。
   * force（设置页「立即补发」）同样排本队——绝不与自动轮并发构建/发送。
   */
  let chain: Promise<unknown> = Promise.resolve()
  function reconcile(now: Date, opts?: { force?: boolean }): Promise<ReconcileOutcome> {
    const run = chain.then(
      () => doReconcile(now, opts),
      () => doReconcile(now, opts),
    )
    chain = run.catch(() => {})
    return run
  }

  async function doReconcile(now: Date, opts?: { force?: boolean }): Promise<ReconcileOutcome> {
    // 设置页动态覆盖：每轮现读（收件人/模型/源清单/发送时间/密度），改完下一轮生效
    const run = { ...deps, ...(deps.runtimeSettings?.() ?? {}) }
    const sendTime = run.sendTime ?? "07:30"
    /** 立即补发（设置页按钮）：跳过 due 门/已发门/转人工门——人工点击就是明确意图；
     * 构建与发送链路一字不差（同 ledger attempt/外发账本，重发多一行账本与 at-least-once 一致） */
    const force = opts?.force === true
    const businessDate = formatBusinessDate(now, timeZone)
    if (!force && timeOfDayInTz(now, timeZone) < sendTime)
      return { status: "skipped_not_due", businessDate }

    const state = deps.ledger.read(businessDate)
    if (!force && state.sent) return { status: "skipped_already_sent", businessDate }
    if (!force && state.attempts.length >= 2) {
      pushAlert(
        `[daily-digest] ${businessDate} 已尝试 ${state.attempts.length} 次仍无 sent 记录，停止自动补发，请人工检查（SMTP/网络/凭证）`,
      )
      return { status: "skipped_needs_manual", businessDate }
    }

    // ---- 构建阶段（失败不烧 attempt，下个安全网触发点重试）----
    // GitHub 四榜全常驻（07-07 小孙「应该是增长、周榜、月榜都要的」；月榜 07-06 已拆
    // 每月 1 号门）：GitHub trending 周/月榜本就是滚动窗口而非周界快照，天天看都成立；
    // 跨榜同 repo 由 orchestrator dedupeItems 合并（同 canonicalUrl 同 dedupeKey），不重复成行
    const githubSources = [
      ...(run.githubDailySources ?? []),
      ...(run.githubSources ?? []),
      ...(run.githubMonthlySources ?? []),
    ]

    const { results, items } = await runAllSources([...run.sources, ...githubSources], {
      http: deps.http,
      httpDirect: deps.httpDirect,
      now: () => now,
      perSourceTimeoutMs: deps.perSourceTimeoutMs,
      health: deps.health,
      healthDate: businessDate,
    })

    // 连续失败告警（AC8）
    for (const r of results) {
      if (r.status !== "ok" && deps.health.consecutiveFailures(r.sourceId, businessDate) >= 3) {
        pushAlert(`[daily-digest] 源 ${r.sourceId} 已连续 ≥3 天失败：${r.errors[0] ?? r.status}`)
      }
    }

    const githubCandidates = items.filter((i) => i.category === "github")
    const githubEligibilityAudit = githubCandidates.map((item) => ({
      itemId: item.id,
      repo: item.githubMeta?.repo ?? item.title,
      state: item.githubMeta?.eligibility.state ?? ("unknown" as const),
      confidence: item.githubMeta?.eligibility.confidence ?? 0,
      reasons: item.githubMeta?.eligibility.reasons ?? ["缺少 GitHub AI 准入判定"],
    }))
    const publishableGithubItems = githubCandidates.filter(
      (item) => item.githubMeta?.eligibility.state === "yes",
    )
    const githubItems = applyGithubRankStatuses(
      publishableGithubItems,
      businessDate,
      loadGithubRankHistory(deps.baseDir, businessDate),
    )
    if (githubItems.length < githubCandidates.length) {
      log(
        `[daily-digest] ${businessDate} GitHub AI 准入：${githubCandidates.length} 候选 → ${githubItems.length} 条 yes；no/unknown 仅归档不发布`,
      )
    }
    // #33 播客速递（07-10）：源侧仍提供转写后的单集 item；B027 起与普通内容一起进入
    // 语义审核，只有 publication 明确批准的单集才沿既有播客列表样式渲染。
    const podcastItemsAll = items.filter((i) => i.category === "podcast")
    const contentItemsRaw = items.filter((i) => i.category !== "github" && i.category !== "podcast")
    // E1/E2 选材预滤链（07-07 小孙「昨天今天很多重复」「政治内容去除」）。只滤选材视野，
    // items.jsonl 证据底料仍落全量（F029 语料库=当日各源全貌，语义不变）：
    // ① 7 天新鲜窗：档案型全量 feed（openai-news 千条历史档案）每天整库回流是跨日重复的
    //    大头；无日期条目保守保留（热榜类天然是「今天的」）。github 榜豁免（榜是状态非新闻流）。
    // ② 政治词表硬滤（结构层；summarizer 提示词规则 7 是语义层双保险）。
    // ③ 跨日已见账本：近 30 天实际发布的条目不再回流（宁缺勿滥）。有日期
    //    条目 7 天新鲜窗先兜；无日期条目（热榜/X 类）唯一靠账本压回流，回看太短会周期性
    //    回流（德彪 r-final P2-2：7 天回看下第 8 天就重新有资格）。
    const freshCutoff = now.getTime() - FRESH_WINDOW_MS
    const shownKeys = loadShownKeys(deps.baseDir, businessDate, {
      notBefore: run.shownLedgerNotBefore,
    })
    const contentItems = contentItemsRaw.filter((i) => {
      if (i.publishedAt) {
        const t = Date.parse(i.publishedAt)
        if (!Number.isNaN(t) && t < freshCutoff) return false
        // yt 24h 延迟窗（YT_SETTLE_MS 注释）：本期完全不进（不喂样不烧 shown），下期字幕就绪再来
        if (i.sourceId.startsWith("yt-") && !Number.isNaN(t) && t > now.getTime() - YT_SETTLE_MS)
          return false
      }
      return !isPoliticalItem(i) && !isUnsafeItem(i) && !shownKeys.has(i.dedupeKey)
    })
    if (contentItemsRaw.length > contentItems.length) {
      log(
        `[daily-digest] ${businessDate} 选材预滤（新鲜窗/yt延迟窗/政治/未成年人防护/已见）：${contentItemsRaw.length} → ${contentItems.length} 条`,
      )
    }
    const podcastItems = podcastItemsAll.filter((i) => !shownKeys.has(i.dedupeKey))
    if (contentItems.length === 0 && podcastItems.length === 0) {
      pushAlert(
        `[daily-digest] ${businessDate} 无可用内容（抓取 ${contentItemsRaw.length} 条，预滤后 0 条，${results.length} 源），本轮不发报，等下个触发点重试`,
      )
      return { status: "failed_no_items", businessDate }
    }

    // B027：播客按「单集」过同一正向编辑门禁，不再因来自 AI 播客源就整流直出。
    const editorialItems = [...contentItems, ...podcastItems]
    const summarized: DigestSummary | null = await run.summarize(editorialItems, businessDate)
    // B032：审核/成稿任一结构化阶段全败 → 本轮不发报 + 告警；sent marker 未落，
    // 下一整点安全网重跑整轮。target-aware 生产路径每个 reviewer/compose target 最多一次，
    // 旧注入 runner 仍保留历史兼容行为。
    if (!summarized) {
      pushAlert(
        `[daily-digest] ${businessDate} AI 摘要审核/成稿模型链全败，本轮不发报（宁缺勿发清单版）——下一整点自动重试`,
      )
      return { status: "failed_summarize", businessDate }
    }
    let summary: DigestSummary = summarized
    if (summary.editorialDecisionSet !== undefined) {
      const trustedDecisionSet = validateEditorialDecisionSet(
        summary.editorialDecisionSet,
        buildEditorialPromptItems(editorialItems),
      )
      if (!trustedDecisionSet) {
        pushAlert(
          `[daily-digest] ${businessDate} editorial_decision_set_invalid：审核凭证 schema/hash/evidence/共识校验失败，本轮不发送且不回退旧语义规则`,
        )
        return { status: "failed_summarize", businessDate }
      }
      summary = { ...summary, editorialDecisionSet: trustedDecisionSet }
    }
    // 旧反选通道仍保留注入熔断：恶意 snippet 若诱导 communityDropIds 大面积拒绝，作废
    // 这张兼容性负面清单并告警。B027 publication 仍要求正向 eligible assessment，熔断
    // 不会把未审核条目放回正式发布路径。
    {
      const fed = summary.communityFedIds ?? []
      const fedSet = new Set(fed)
      const effectiveDrops = (summary.communityDropIds ?? []).filter((id) => fedSet.has(id))
      if (fed.length > 0 && effectiveDrops.length * 5 > fed.length * 4) {
        pushAlert(
          `[daily-digest] ${businessDate} 社区反选熔断：${effectiveDrops.length}/${fed.length} 超 80% 阈值，本期反选作废（防不可信内容诱导整版蒸发）`,
        )
        const { communityDropIds: _voided, ...rest } = summary
        summary = rest
      }
    }
    const notes: string[] = []
    const decisionSet = summary.editorialDecisionSet
    if (decisionSet) {
      const editorialItemsById = new Map(editorialItems.map((item) => [item.id, item]))
      const unresolvedInferenceIds = decisionSet.decisions
        .filter((decision) => {
          const item = editorialItemsById.get(decision.itemId)
          return (
            decision.reviewState === "unreviewed" &&
            item !== undefined &&
            isInferenceReviewCandidate(item)
          )
        })
        .map((decision) => decision.itemId)
      if (unresolvedInferenceIds.length > 0) {
        if (decisionSet.reviewMode !== "degraded_same_target") {
          pushAlert(
            `[daily-digest] ${businessDate} inference_review_unresolved：${unresolvedInferenceIds.length} 个高召回推理候选仍未决，本轮不发送，不能伪称今日无推理进展`,
          )
          return { status: "failed_summarize", businessDate }
        }
        const note =
          "⚠ 推理候选审核未决（Claude 当前不可用，Codex 降级复核仍无共识）；相关条目已摘除，本期不代表「今日无推理进展」"
        notes.push(note)
        pushAlert(
          `[daily-digest] ${businessDate} inference_review_unresolved：${unresolvedInferenceIds.length} 个候选在 degraded_same_target 下仍未决；已摘条目但继续生成其余非空日报`,
        )
        log(
          `[daily-digest] ${businessDate} degraded_same_target unresolved inference=${unresolvedInferenceIds.length}`,
        )
      }
    }
    // 德彪 r-final P1-3 + r2 P2：截断修复缺节 → 邮件 notes 透出；未进入终态 publication
    // 的候选天然不烧 shown，可在次日回补。repair 下分不清截断丢失还是模型省节，统一按缺失处理。
    const repairDropped = new Set<string>(summary.repairDroppedCategories ?? [])
    if (repairDropped.size > 0) {
      const labels = [...repairDropped].map((c) => SECTION_LABEL[c] ?? c)
      notes.push(
        `⚠ AI 摘要输出截断已修复，${labels.join("、")}板块本期未成节（保守按缺失处理，候选明日回补）`,
      )
      log(
        `[daily-digest] ${businessDate} 截断修复丢节：${[...repairDropped].join(",")}——未发布候选不写 shown`,
      )
    }
    const publicationItems = [...contentItems, ...githubItems, ...podcastItems]
    const builtPublication = buildDigestPublication({
      businessDate,
      summary,
      items: publicationItems,
      githubItemIds: githubItems.map((item) => item.id),
      // podcast 的批准 id 已由 summary.sections[].briefItemIds 正向给出；这里禁止整流放行。
      podcastItemIds: [],
    })
    let publication = builtPublication.publication
    const editorialAudit = builtPublication.audit
    if (!publication.sections.some((section) => section.entries.length > 0)) {
      pushAlert(
        `[daily-digest] ${businessDate} 编辑门禁后无可发布内容，本轮不发送空日报——下一整点自动重试`,
      )
      return { status: "failed_summarize", businessDate }
    }
    const initialCoverageGaps = missingRequiredAiCoverage(publication, editorialAudit.assessments)
    if (initialCoverageGaps.length > 0) {
      const labels = initialCoverageGaps.map((gap) => (gap === "inference" ? "推理" : "非推理 AI"))
      pushAlert(
        `[daily-digest] ${businessDate} 编辑后缺少合格${labels.join("、")}代表，本轮不发送失真日报——下一整点自动重试`,
      )
      return { status: "failed_summarize", businessDate }
    }
    const renderInput = {
      businessDate,
      summary,
      publication,
      items: contentItems,
      results,
      githubItems,
      podcastItems,
      notes,
      webBaseUrl: run.webBaseUrl,
      restOverviewRows: run.restOverviewRows,
    }
    let rendered = renderDigest(renderInput)

    // 中文化补全（07-06 小孙「github 介绍是英文的」「速览标题太扯」）：github desc +
    // 实际展示的速览行标题一次翻译调用 → 并进 summary（随 summary.json 落盘，网页版共用）
    // → 二次渲染。已是中文的条目预滤不送；任何失败保留首轮渲染（英文原文直出）。
    if (run.translateExtras) {
      try {
        const cjk = /[一-鿿]/
        const github = githubItems
          .map((g) => ({
            id: g.id,
            name: g.title,
            desc: splitGithubSnippet(g.rawSnippet)?.desc ?? g.rawSnippet,
          }))
          .filter((g) => g.desc.length > 0 && !cjk.test(g.desc))
        const byId = new Map(contentItems.map((i) => [i.id, i]))
        const titles = rendered.restItemIds
          .map((id) => byId.get(id))
          .filter((i): i is NormalizedItem => i !== undefined && !cjk.test(i.title))
          .map((i) => ({ id: i.id, title: i.title }))
        if (github.length > 0 || titles.length > 0) {
          const t = await run.translateExtras({ github, titles })
          const hasGh = Object.keys(t.githubDescZh).length > 0
          const hasTitles = Object.keys(t.restTitleZh).length > 0
          if (hasGh || hasTitles) {
            summary = {
              ...summary,
              ...(hasGh ? { githubDescZh: t.githubDescZh } : {}),
              ...(hasTitles ? { restTitleZh: t.restTitleZh } : {}),
            }
            rendered = renderDigest({ ...renderInput, summary })
          }
        }
      } catch (err) {
        log(`[daily-digest] 中文化补全失败（保留英文原文）：${String(err).slice(0, 160)}`)
      }
    }

    // Gmail 102KB 裁剪线治理（07-07 实测翻车：v4 邮件 98K「字符」实为 104KB **字节**——
    // 中文化后每汉字 UTF-8 占 3 字节，旧守卫用 .length 量错尺子，Gmail 已经把页脚剪了）。
    // 口径改字节 + 超预算自动降密度阶梯：逐档收紧「其余速览」行数重渲染，降到 0 仍超才认
    // （读者看到 "[Message clipped]" 比少几行速览更伤，07-05 晚「邮件自足」的边界条件）
    // 预算 98KB：07-07 真数据曲线（rest 12→104.2KB / 10→101.8 / 8→99.2 / 5→95.6）——
    // 96KB 会把平日速览砍到 3 行，98KB 平日保 8-10 行、周一最挤保 5 行，仍留 4KB 头寸
    const emailByteBudget = deps.emailByteBudget ?? 98 * 1024
    if (Buffer.byteLength(rendered.html, "utf8") > emailByteBudget) {
      const fullBytes = Buffer.byteLength(rendered.html, "utf8")
      for (const rows of [10, 8, 5, 3, 0]) {
        rendered = renderDigest({ ...renderInput, summary, restOverviewRows: rows })
        if (Buffer.byteLength(rendered.html, "utf8") <= emailByteBudget) break
      }
      const finalBytes = Buffer.byteLength(rendered.html, "utf8")
      log(
        `[daily-digest] ${businessDate} HTML ${Math.round(fullBytes / 1024)}KB 超邮件预算 ${Math.round(emailByteBudget / 1024)}KB，速览降密度后 ${Math.round(finalBytes / 1024)}KB${finalBytes > emailByteBudget ? "（已降到 0 行仍超，将由终态硬门禁拦截）" : ""}`,
      )
    }
    // 邮件预算可能裁掉 brief 尾部：先以 renderer 的实际显示集合收敛 publication，随后
    // archive/web/shown 全消费这份终态，避免「归档说发布了、邮件却没显示」的双账。
    publication = filterDigestPublication(publication, new Set(rendered.displayedItemIds))
    // overview 也带结构化事件引用；预算裁掉其支撑条目后再用终态 publication 渲染一次，
    // 保证邮件正文、归档和 web 的速览没有悬空事件。终态条目只会更少，不会重新超预算。
    rendered = renderDigest({ ...renderInput, summary, publication })
    const finalEmailBytes = Buffer.byteLength(rendered.html, "utf8")
    if (finalEmailBytes > emailByteBudget) {
      pushAlert(
        `[daily-digest] ${businessDate} 邮件终态 HTML ${finalEmailBytes} bytes 超过 ${emailByteBudget} bytes 硬预算，本轮不发送——下一整点自动重试`,
      )
      return { status: "failed_summarize", businessDate }
    }
    if (!publication.sections.some((section) => section.entries.length > 0)) {
      pushAlert(
        `[daily-digest] ${businessDate} 邮件密度裁剪后无可发布内容，本轮不发送空日报——下一整点自动重试`,
      )
      return { status: "failed_summarize", businessDate }
    }
    const overviewDensity = validateDigestOverviewDensity(publication, summary)
    if (!overviewDensity.valid) {
      pushAlert(
        `[daily-digest] ${businessDate} 邮件终态速览密度不合格：实际 ${overviewDensity.actual} 条，要求 ${overviewDensity.requiredMin}-${overviewDensity.allowedMax} 条（获批 ${overviewDensity.approvedCount} 条）；本轮不发送——下一整点自动重试`,
      )
      return { status: "failed_summarize", businessDate }
    }
    const finalCoverageGaps = missingRequiredAiCoverage(publication, editorialAudit.assessments)
    if (finalCoverageGaps.length > 0) {
      const labels = finalCoverageGaps.map((gap) => (gap === "inference" ? "推理" : "非推理 AI"))
      pushAlert(
        `[daily-digest] ${businessDate} 邮件终态裁剪后缺少合格${labels.join("、")}代表，本轮不发送失真日报——下一整点自动重试`,
      )
      return { status: "failed_summarize", businessDate }
    }

    // AC9 先归档后发送（发送失败也留档）
    const dayDir = path.join(deps.baseDir, businessDate)
    fs.mkdirSync(dayDir, { recursive: true })
    fs.writeFileSync(path.join(dayDir, "digest.html"), rendered.html)
    fs.writeFileSync(path.join(dayDir, "digest.md"), rendered.markdown)
    // F029 证据底料（小孙 07-05 拍）：当日全量归一条目按行落 items.jsonl —— 调研核查 feature
    // 直接把日报归档当历史语料库（某日各源说了什么），复用零改动、回溯无需重抓。
    // 注意是预滤**前**的全量（contentItemsRaw）：语料库要「当日各源全貌」，选材口味不该改写证据
    const rankedGithubById = new Map(githubItems.map((item) => [item.id, item]))
    const corpus = [
      ...contentItemsRaw,
      ...podcastItemsAll,
      ...githubCandidates.map((item) => rankedGithubById.get(item.id) ?? item),
    ]
    fs.writeFileSync(
      path.join(dayDir, "items.jsonl"),
      corpus.length ? `${corpus.map((i) => JSON.stringify(i)).join("\n")}\n` : "",
    )
    // 网页版日报（07-05 分栏改版 #2）：picks/tags/深读/源健康结构化落盘，
    // /api/daily-digest/:date 直接读它出分栏 tabs；items 不重复存（在 items.jsonl）
    fs.writeFileSync(
      path.join(dayDir, "summary.json"),
      JSON.stringify(
        {
          schemaVersion: 2,
          businessDate,
          generatedAt: new Date().toISOString(),
          degraded: summary.degraded,
          summary,
          publication,
          editorialAudit,
          githubEligibilityAudit,
          sourceHealth: results.map((r) => ({
            sourceId: r.sourceId,
            status: r.status,
            itemCount: r.items.length,
            durationMs: r.durationMs,
            error: r.errors[0] ?? null,
          })),
          counts: {
            content: publication.sections
              .filter((section) => !["github", "podcast"].includes(section.category))
              .reduce((count, section) => count + section.entries.length, 0),
            github:
              publication.sections.find((section) => section.category === "github")?.entries
                .length ?? 0,
            podcast:
              publication.sections.find((section) => section.category === "podcast")?.entries
                .length ?? 0,
            // 「收录」延续原体检行口径：预滤后、进入编辑流程的候选总数；分栏计数则是
            // publication 最终发布数。web 优先读 scanned，邮件由 adapter 保留同一口径。
            scanned: contentItems.length + githubItems.length + podcastItems.length,
          },
          // 本期实际渲染的播客集 id（德彪 r1 P2-1）：items.jsonl 存全量底料（F029 语料
          // 语义），网页版必须按本清单 join——否则邮件被 shown 滤掉的旧集网页仍会重现
          podcastItemIds:
            publication.sections
              .find((section) => section.category === "podcast")
              ?.entries.map((entry) => entry.itemId) ?? [],
          githubItemIds:
            publication.sections
              .find((section) => section.category === "github")
              ?.entries.map((entry) => entry.itemId) ?? [],
        },
        null,
        2,
      ),
    )

    // ---- 发送阶段（D10：attempt = 发送尝试）----
    const attemptNote = force
      ? state.sent
        ? "manual_resend(已发过,设置页强制补发)"
        : "manual(设置页立即补发)"
      : state.attempts.length === 0
        ? "first"
        : "retry_after_unknown(可能重复)"
    deps.ledger.recordAttempt(businessDate, attemptNote)
    let messageId: string
    try {
      const sent = await run.sender.send({
        to: run.recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.markdown,
      })
      messageId = sent.messageId
    } catch (err) {
      pushAlert(
        `[daily-digest] ${businessDate} 发送失败（attempt#${state.attempts.length + 1}）：${String(err).slice(0, 300)}`,
      )
      return { status: "send_failed", businessDate, detail: String(err).slice(0, 300) }
    }
    // 德彪 P1r1-P2：外发账本先于 sent-marker 落盘 —— crash 窗口下账本绝不漏记真实外发
    // （代价：重试场景可能多一行账本记录，与 at-least-once 语义一致，记的是真实发生的事）
    const finalGithubIds = new Set(
      publication.sections
        .find((section) => section.category === "github")
        ?.entries.map((entry) => entry.itemId) ?? [],
    )
    const finalGithubItems = githubItems.filter((item) => finalGithubIds.has(item.id))
    appendOutboundLedger(deps.baseDir, {
      at: new Date().toISOString(),
      to: run.recipient,
      subject: rendered.subject,
      senderKind: run.sender.kind,
      messageId,
      sections: countSections(publication),
    })
    try {
      writeGithubRankSnapshot(deps.baseDir, businessDate, finalGithubItems)
    } catch (err) {
      pushAlert(
        `[daily-digest] ${businessDate} GitHub 上榜状态快照写入失败（邮件已发送，不阻断 sent 落账）：${String(err).slice(0, 240)}`,
      )
    }
    // B027 已见账本：只记最终 publication 中实际显示的条目（含同报 id）；fed-but-unshown
    // 不再烧 30 天。只在真发送成功后落盘；github 榜不记（蝉联是榜单语义）。
    // 顺序（德彪 DE-r2 P2）：shown 先于 sent-marker——若在两者间崩溃，下一轮按未发处理重发
    // （at-least-once 既有语义）并重写 shown；反过来（sent 先落）崩溃则当天永缺 shown，
    // 次日跨日去重静默失效。
    const shownThisIssue = new Set<string>()
    const publishedById = new Map(publicationItems.map((item) => [item.id, item]))
    const finalEntries = publication.sections.flatMap((section) => section.entries)
    for (const entry of finalEntries) {
      for (const id of [entry.itemId, ...(entry.alsoItemIds ?? [])]) {
        const item = publishedById.get(id)
        if (item && item.category !== "github") shownThisIssue.add(item.dedupeKey)
      }
    }
    writeShownLedger(deps.baseDir, businessDate, shownThisIssue)
    deps.ledger.recordSent(businessDate, { messageId, to: run.recipient })
    log(`[daily-digest] ${businessDate} sent (${messageId}) degraded=${summary.degraded}`)
    return { status: "ok", businessDate, degraded: summary.degraded }
  }

  return { reconcile }
}

function countSections(publication: DigestPublicationV2): Record<string, number> {
  const out: Record<string, number> = {}
  for (const section of publication.sections) {
    if (section.entries.length > 0) out[section.category] = section.entries.length
  }
  return out
}
