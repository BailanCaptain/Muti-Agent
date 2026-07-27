import {
  DIGEST_COMMUNITY_PLATFORM_TABS,
  DIGEST_COMMUNITY_TAB_FALLBACK,
  DIGEST_COMMUNITY_TAB_ORDER,
  DIGEST_GH_KINDS,
  DIGEST_GITHUB_SECTION_LABEL,
  DIGEST_X_TAB_MORE,
  DIGEST_X_TAB_ORG,
  DIGEST_X_TAB_PERSON,
} from "@multi-agent/shared"
import { weekendRangeForMonday } from "./business-dates"
import { formatGithubRankStatus } from "./github-rank-state"
import { AI_TAG_ORDER, HOT_TAG_ORDER } from "./section-tags"
import { sourceLabel } from "./source-labels"
import { deriveDeepReadSourceIds } from "./sources/registry"
import { X_GROUP_ORG, X_GROUP_PERSON } from "./sources/x-handle-groups"
import { diversifyBySource } from "./summarizer"
import type {
  DigestCategory,
  DigestSummary,
  NormalizedItem,
  RenderedDigest,
  SourceFetchResult,
} from "./types"

/**
 * T11 渲染器 v5（AC2 版式 + AC12 邮件兼容 · 暖白编辑部 + 顶部导览）：
 * - 数据直出 HTML：链接只从 itemsById[pick.itemId].canonicalUrl 取（注入护栏落地，escapeHtml 全覆盖 / safeHref 只放 http(s)）
 * - table 布局 ≤600px、全内联样式、无 <script>/无远程图片/无 flex-grid/无 oklch/无 @media；固定像素多列（272+16+272）杜绝 %宽+padding 溢出错位
 * - 顶部导览卡：今日速览概述 + 4 板块格（锚点 <a href="#sec-xx">，Apple 邮件可跳，Gmail 剥 id 降级为目录/速览仍成立）
 * - 每板块 bento：首条暖白焦点卡 + 其余两两成对列，落单则整宽卡
 * - 正文只露中文源名（sourceLabel），内部 sourceId 只出现在页脚健康行（排障用）
 */

interface SectionMeta {
  category: DigestCategory
  label: string
  en: string
  anchor: string
  nav: string
  hero: string
}

type SectionPick = {
  itemId: string
  summaryZh: string
  alsoItemIds?: string[]
  tag?: string
  /** github 条目中文描述（德彪批次D r1 P2：结构化传递，不把 LLM 文本回灌 delimiter parser） */
  descZh?: string
}
type Variant = "hero" | "wide" | "col"

const SECTION_META: SectionMeta[] = [
  {
    category: "ai",
    label: "AI · 人工智能",
    en: "ARTIFICIAL INTELLIGENCE",
    anchor: "sec-ai",
    nav: "AI 前沿",
    hero: "焦点",
  },
  {
    // 07-06 小孙改版：X 一手动态 → 社区动态（X + Reddit + Lobsters + V2EX + 小红书）
    category: "community",
    label: "社区动态",
    en: "COMMUNITY PULSE",
    anchor: "sec-community",
    nav: "社区动态",
    hero: "焦点",
  },
  {
    category: "hot",
    label: "今日热点",
    en: "TRENDING TODAY",
    anchor: "sec-hot",
    nav: "今日热点",
    hero: "头条",
  },
  {
    // #33 播客速递（07-10）：有新集才出现的板块——无 podcastItems 时 picks 空，
    // sections 末端 filter 自动整节消失（含导览芯片）
    category: "podcast",
    label: "播客速递",
    en: "PODCAST DIGEST",
    anchor: "sec-podcast",
    nav: "播客速递",
    hero: "本期",
  },
  {
    category: "github",
    label: DIGEST_GITHUB_SECTION_LABEL,
    en: "TRENDING REPOS · TODAY",
    anchor: "sec-gh",
    nav: DIGEST_GITHUB_SECTION_LABEL,
    hero: "榜首",
  },
]

// ---- 分栏改版（小孙 07-05 #2/#3/#4/#5 + 07-06 社区改版）：板块内子栏 ----
// 社区板块子栏：X 账号走 org/person 结构分区（x-handle-groups 静态映射，清单外落「更多动态」），
// 其余社区源按平台分组（Reddit/Lobsters/V2EX/小红书——真相源 shared digest-tags）

/** 板块 → 子栏分组键（顺序即渲染顺序）；返回 null = 该板块不分组（github 走榜单卡） */
function sectionGroupOrder(category: DigestCategory): readonly string[] | null {
  if (category === "ai") return AI_TAG_ORDER
  if (category === "hot") return HOT_TAG_ORDER
  if (category === "community") return DIGEST_COMMUNITY_TAB_ORDER
  return null
}

function groupKeyOf(category: DigestCategory, item: NormalizedItem, pick: SectionPick): string {
  if (category === "community") {
    if (item.sourceId === "x-firsthand") {
      if (item.topicTag === X_GROUP_ORG) return DIGEST_X_TAB_ORG
      if (item.topicTag === X_GROUP_PERSON) return DIGEST_X_TAB_PERSON
      return DIGEST_X_TAB_MORE
    }
    return DIGEST_COMMUNITY_PLATFORM_TABS[item.sourceId] ?? DIGEST_COMMUNITY_TAB_FALLBACK
  }
  return pick.tag ?? "其他"
}

// GitHub 榜单卡（#2：日/周/月/新秀分栏；邮件端静态分组，可点切换在网页版）。
// 榜种顺序/标签真相源在 shared digest-tags（web tabs 同款）；邮件限量是邮件端专属
const GH_KIND_ORDER: string[] = DIGEST_GH_KINDS.map((k) => k.sourceId)
// 07-07 批次 E：四榜常驻（周榜/新秀拆周一门）后每天 4 组同场，周/月 8→6 控总量
// （Gmail 102KB 字节裁剪线，实测每榜行 ~350B；跨榜同 repo 上游 dedupeKey 已合并）
const GH_EMAIL_CAPS: Record<string, number> = {
  "github-trending-daily": 6,
  "github-trending-weekly": 6,
  "github-ai-newcomers": 4,
  "github-trending-monthly": 6,
}
function ghKindLabel(kind: string): string {
  return DIGEST_GH_KINDS.find((k) => k.sourceId === kind)?.label ?? sourceLabel(kind)
}

function githubRankStatusLabel(item: NormalizedItem): string | null {
  if (!new Set(["github-trending-daily", "github-ai-newcomers"]).has(item.sourceId)) return null
  return formatGithubRankStatus(item.githubMeta?.rankStatus ?? null)
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** 13 个宽 ASCII 字符即可撑破 272px 双栏；只打 Outlook 样式标记，不改可复制文本。 */
function needsOutlookBreakAll(s: string): boolean {
  return /[\x21-\x7e]{13,}/.test(s)
}

/** Classic Outlook 会把超长 URL 拆成很多行；双栏同行会因此把短卡下方撑出大块空白。 */
function needsOutlookWideRow(s: string): boolean {
  return /https?:\/\/[^\s<]{24,}/i.test(s)
}

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : "#"
}

function weekdayZh(businessDate: string): string {
  const d = new Date(`${businessDate}T12:00:00+08:00`)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: "Asia/Shanghai" }).format(d)
}

function digestEdition(businessDate: string): {
  weekendRoundup: boolean
  coverageLabel: string
  subjectSuffix: string
  overviewLabel: string
  mastheadSubtitle: string
} {
  const range = weekendRangeForMonday(businessDate)
  if (!range) {
    return {
      weekendRoundup: false,
      coverageLabel: "",
      subjectSuffix: "",
      overviewLabel: "今日速览 · AT A GLANCE",
      mastheadSubtitle: "",
    }
  }
  const compact = (date: string) => date.slice(5).replace("-", ".")
  const coverageLabel = `${compact(range.start)}—${compact(range.end)}`
  return {
    weekendRoundup: true,
    coverageLabel,
    subjectSuffix: ` · 周末速览（${coverageLabel}）`,
    overviewLabel: `周末速览 · WEEKEND AT A GLANCE · ${coverageLabel}`,
    mastheadSubtitle: `周末速览 · SAT–SUN ROUNDUP　·　覆盖 ${coverageLabel}`,
  }
}

export interface RenderInput {
  businessDate: string
  summary: import("./types").DigestSummary
  /** B027 v2：存在时是唯一发布真相源；raw items 只作 lookup，不再有补位权限。 */
  publication?: import("./types").DigestPublicationV2
  items: NormalizedItem[]
  results: SourceFetchResult[]
  /** GitHub 原始 lookup；v2 只有 publication 明确列出的 AI 合格仓库可沿既有榜单样式渲染。 */
  githubItems?: NormalizedItem[]
  /** 播客原始 lookup；v2 单集经语义审核后才沿既有列表样式渲染。 */
  podcastItems?: NormalizedItem[]
  notes?: string[]
  /** 网页版基址：配置则刊头/页脚带「网页版全量分栏 →」链接（邮件是精选快照，可点切换在网页） */
  webBaseUrl?: string
  /** 邮件密度（设置页）：每板块「其余速览」行数，默认 12；0 = 关掉速览区 */
  restOverviewRows?: number
  /** 终态 publication 已移除、但本轮因邮件密度而隐藏过 brief 的栏目；只用于诚实空态。 */
  densitySuppressedCategories?: DigestCategory[]
  /** v2 过滤 raw lookup 后仍保留原「本期扫描」统计口径。 */
  scannedItemCount?: number
}

// 暖白编辑部 token：从产品 OKLCH 真相源换算成邮件可用 hex（邮件客户端不认 OKLCH）。
// 色彩职责收敛为纸面 / 正文 / 次要文字 / 陶土强调，避免旧版每一层都抢同一个金色。
const C = {
  page: "#eee7df",
  paper: "#fffaf5",
  card: "#fffdf9",
  heroLight: "#f6eee7",
  border: "#ded4ca",
  title: "#161513",
  ink: "#24211f",
  sub: "#514c48",
  muted: "#746c66",
  gold: "#8a3a00",
  goldLight: "#e7c2aa",
  accent: "#c65d2e",
  alert: "#fff1e6",
  white: "#ffffff",
  cream: "#f8eee7",
}

// Windows Classic Outlook 没有 Songti/PingFang，且 Word HTML 的字体回退不稳定。
// SimSun 放在 Apple 字体之后：手机保持现状，Windows 中文标题落到稳定的宋体。
const SERIF = "Georgia,'Songti SC','PingFang SC','SimSun','Microsoft YaHei',serif"
const SANS = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif"

// 卡片统一在外层 table 声明 sans 字体，内部行继承；避免每条新闻重复 88B 字体栈。
// MSO 条件样式会把继承显式落到 Word 的 td/a/span，现代客户端计算结果不变。
const kickerCol = `font-size:12px;font-weight:700;line-height:18px;letter-spacing:1px;color:${C.gold};`
const bodySmall = `font-size:14px;line-height:25px;color:${C.sub};`
const bodyLarge = `font-size:14px;line-height:25px;color:${C.sub};`
const ghMeta = `font-size:12px;font-weight:700;letter-spacing:0.5px;color:${C.gold};`
const ghMetaHero = `font-size:13px;font-weight:700;letter-spacing:0.5px;color:${C.gold};`
const titleHero = `font-family:${SERIF};mso-fareast-font-family:SimSun;font-size:20px;font-weight:700;line-height:30px;color:${C.title};text-decoration:none;overflow-wrap:anywhere;word-break:break-word;`
const titleWide = `font-size:17px;font-weight:700;line-height:26px;color:${C.title};text-decoration:none;overflow-wrap:anywhere;word-break:break-word;`
const titleCol = `font-size:16px;font-weight:700;line-height:24px;color:${C.title};text-decoration:none;overflow-wrap:anywhere;word-break:break-word;`

// Classic Outlook 仍使用 Word HTML 引擎。条件注释只对 Outlook 生效，现代客户端继续
// 使用现有内联视觉；96 DPI、table 间隙、固定行高和中文衬线字体在这里集中兜底。
const MSO_HEAD = `<!--[if mso]>
<xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<style type="text/css">
table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}
td,div,a,span{mso-line-height-rule:exactly}
.digest-sans,.digest-sans td,.digest-sans a,.digest-sans span{font-family:'Microsoft YaHei',Arial,sans-serif!important}
.digest-serif,.digest-sans .digest-serif{font-family:Georgia,SimSun,'Microsoft YaHei',serif!important;mso-fareast-font-family:SimSun!important}
.outlook-break-long{word-break:break-all!important}
/* OUTLOOK_VISUAL_START */
.outlook-paper{border:1px solid #ded4ca!important}
.masthead-table{background-color:#24211f!important;border:1px solid #24211f!important;border-top:6px solid #c65d2e!important}
.outlook-nav-shell{background-color:#f6eee7!important;border:1px solid #ded4ca!important}
.outlook-nav-chip{background-color:#fffaf5!important;border:1px solid #ded4ca!important}
.outlook-nav-gutter{background-color:#f6eee7!important}
.outlook-story-card,.outlook-list-card{background-color:#fffdf9!important;border:1px solid #ded4ca!important}
.outlook-rest-card{background-color:#f8eee7!important;border:1px solid #ded4ca!important}
.outlook-hero-card{background-color:#f6eee7!important;border:1px solid #ded4ca!important;border-top:3px solid #c65d2e!important}
.outlook-subheading{background-color:#f8eee7!important;border:0!important;border-bottom:1px solid #ded4ca!important}
.outlook-card-summary{font-size:14px!important;line-height:25px!important}
/* OUTLOOK_VISUAL_END */
</style>
<![endif]-->`

/** HTML 摘要截断；完整摘要始终保留在 Markdown 归档，标题链接不变。 */
function clampText(s: string, max: number): string {
  if (max <= 0) return ""
  const codePoints = Array.from(s)
  return codePoints.length > max ? `${codePoints.slice(0, max - 1).join("")}…` : s
}

/** 排版均衡（#1）：估高分 —— 标题行数权重大（衬线大字），摘要按截断后长度算 */
function estHeight(item: NormalizedItem, pick: SectionPick): number {
  return item.title.length * 2 + Math.min(pick.summaryZh.length, 80)
}

/** 子栏标题行：保留明确分界，但不再与板块标题重复使用强调色竖条。 */
function subHeading(label: string, count: number, anchor: string): string {
  return `<tr><td style="padding:6px 0 12px 0;"><a name="${anchor}"></a><table class="outlook-subheading" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.cream}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.cream};border-bottom:1px solid ${C.border};border-radius:12px;"><tr><td style="padding:10px 14px;font-family:${SANS};font-size:13px;font-weight:700;line-height:20px;letter-spacing:0.5px;color:${C.ink};">${escapeHtml(label)} · ${count} 条</td></tr></table></td></tr>`
}

/**
 * 其余速览（07-05 晚小孙「日报点开就看，别逼人跳网页」）：精选卡之外的板块全量信息
 * 压进紧凑行区——一行一条（源名·标题链接·热度），零交互直接印在纸上。这才是 tab
 * 想给的「最大化信息」在邮件里的原生形态。排序走 diversifyBySource（源内互动量/时间，
 * 不跨平台直比热度量纲），限 12 行防撞 Gmail 102KB 裁剪线。
 */
function restRowsCard(
  rest: NormalizedItem[],
  total: number,
  titleZh?: Record<string, string>,
): string {
  if (rest.length === 0) return ""
  const rows = rest
    .map((i) => {
      const href = safeHref(i.canonicalUrl)
      const eng =
        i.engagement !== undefined
          ? `<span style="color:${C.sub};">　▲${i.engagement.toLocaleString("en-US")}</span>`
          : ""
      // 中文化补全（07-06）：翻译 map 命中就用中文标题（缺 map/缺 id 回落原文）
      const shown = titleZh?.[i.id] ?? i.title
      return `<tr><td style="font-family:${SANS};font-size:14px;line-height:25px;color:${C.sub};padding:0;"><span style="color:${C.gold};font-weight:700;">${escapeHtml(sourceLabel(i.sourceId))}</span>　<a href="${href}" style="color:${C.title};text-decoration:none;">${escapeHtml(clampText(shown, 64))}</a>${eng}</td></tr>`
    })
    .join("")
  const headTail = total > rest.length ? `TOP ${rest.length} / 共 ${total} 条` : `${rest.length} 条`
  const content = `<table class="rest-content-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr><td style="font-family:${SANS};font-size:12px;font-weight:700;line-height:18px;letter-spacing:1px;color:${C.gold};padding:0 0 8px 0;">◇ 其余速览 · ${headTail}</td></tr>${rows}</table>`
  return `<tr><td style="padding:0 0 16px 0;"><table class="outlook-rest-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.cream}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.cream};border:1px solid ${C.border};border-radius:16px;"><tr><td style="padding:16px 20px 18px 20px;">${content}</td></tr></table></td></tr>`
}

/** 每节尾「回目录」：邮件里的导航回程（锚点是邮件唯一可用的"跳转"原语） */
function backToTopRow(): string {
  return `<tr><td align="right" style="padding:0 2px 6px 0;"><a href="#DigestTop" style="font-family:${SANS};font-size:12px;letter-spacing:1px;color:${C.gold};text-decoration:none;">↑ 回目录</a></td></tr>`
}

function emptySectionCard(message: string): string {
  return `<tr><td style="padding:0 0 16px 0;"><table class="digest-sans empty-section-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.heroLight}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.heroLight};border:1px solid ${C.border};border-radius:16px;"><tr><td style="font-family:${SANS};font-size:14px;line-height:24px;color:${C.sub};padding:18px 20px;">${escapeHtml(message)}</td></tr></table></td></tr>`
}

/** github 条目 snippet（"+N stars today/this week · ★M · Lang · desc" / "新仓 7 天 ★M · desc"）→ 数据行 + 描述 */
export function splitGithubSnippet(text: string): { meta: string; desc: string } | null {
  const parts = text.split(" · ")
  if (parts.length < 2) return null
  const weekly = parts[0].match(/^\+([\d,]+) stars (this week|this month|today)$/)
  if (weekly && /^★[\d,]+$/.test(parts[1] ?? "")) {
    const periodZh = weekly[2] === "this month" ? "本月" : weekly[2] === "today" ? "今日" : "本周"
    const meta = [`▲ ${weekly[1]} ${periodZh}`, parts[1]]
    let rest = parts.slice(2)
    if (rest.length > 1 && /^[A-Za-z][A-Za-z0-9+#. -]{0,19}$/.test(rest[0])) {
      meta.push(rest[0])
      rest = rest.slice(1)
    }
    return { meta: meta.join("　"), desc: rest.join(" · ") }
  }
  const newcomer = parts[0].match(/^新仓 7 天 (★[\d,]+)$/)
  if (newcomer) return { meta: `🆕 新仓 7 天　${newcomer[1]}`, desc: parts.slice(1).join(" · ") }
  return null
}

/** 关键卡片内部统一用 table/td 承担间距，避免 Classic Outlook 忽略 div/span padding。 */
function cardContentTable(rows: string, explicitFontFamily?: string): string {
  const className = explicitFontFamily ? "card-content-table digest-sans" : "card-content-table"
  const fontStyle = explicitFontFamily ? `font-family:${explicitFontFamily};` : ""
  return `<table class="${className}" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;${fontStyle}">${rows}</table>`
}

interface CardRow {
  content: string
  style?: string
  top?: number
  bottom?: number
  className?: string
}

interface HtmlDensity {
  overviewChars: number
  summaryChars: Record<Variant, number>
  githubDescChars: number
  includeSubNav: boolean
}

const FULL_DENSITY: HtmlDensity = {
  overviewChars: Number.MAX_SAFE_INTEGER,
  summaryChars: { hero: Number.MAX_SAFE_INTEGER, wide: Number.MAX_SAFE_INTEGER, col: 80 },
  githubDescChars: 90,
  includeSubNav: true,
}
const COMPACT_DENSITY: HtmlDensity = {
  overviewChars: 220,
  summaryChars: { hero: 180, wide: 140, col: 70 },
  githubDescChars: 75,
  includeSubNav: true,
}
const TIGHT_DENSITY: HtmlDensity = {
  overviewChars: 100,
  summaryChars: { hero: 80, wide: 70, col: 50 },
  githubDescChars: 50,
  includeSubNav: false,
}
const TITLE_ONLY_DENSITY: HtmlDensity = {
  overviewChars: 60,
  summaryChars: { hero: 0, wide: 0, col: 0 },
  githubDescChars: 0,
  includeSubNav: false,
}
const HTML_DENSITY_STEPS = [FULL_DENSITY, COMPACT_DENSITY, TIGHT_DENSITY, TITLE_ONLY_DENSITY]
const EMAIL_HTML_BYTE_BUDGET = 98 * 1024

function cssPx(value: number): string {
  return value === 0 ? "0" : `${value}px`
}

/** 外层卡片直接承载内容行；每行完整 padding 让 Word 保距，同时省掉每卡一张嵌套表。 */
function insetCardRows(rows: CardRow[], inset: number): string {
  return rows
    .map((row, index) => {
      const top = (row.top ?? 0) + (index === 0 ? inset : 0)
      const bottom = (row.bottom ?? 0) + (index === rows.length - 1 ? inset : 0)
      const classAttr = row.className ? ` class="${row.className}"` : ""
      return `<tr><td${classAttr} style="${row.style ?? ""}padding:${cssPx(top)} ${inset}px ${cssPx(bottom)} ${inset}px;">${row.content}</td></tr>`
    })
    .join("")
}

/** 单卡内容（kicker + 标题链接 + 正文），hero/wide/col 三态复用。 */
function renderCardInner(
  item: NormalizedItem,
  pick: SectionPick,
  no: number,
  meta: SectionMeta,
  variant: Variant,
  density: HtmlDensity,
  alsoLabels: string[] = [],
): string {
  const href = safeHref(item.canonicalUrl)
  const label = sourceLabel(item.sourceId)
  const noStr = String(no).padStart(2, "0")
  const bodyRows: CardRow[] = []
  const gh = meta.category === "github" ? splitGithubSnippet(pick.summaryZh) : null
  if (gh) {
    // 中文化补全：descZh 结构化覆盖英文 desc（meta 数据行原样保留）
    const desc = clampText(pick.descZh ?? gh.desc, density.githubDescChars)
    bodyRows.push({
      className: "github-meta-row",
      style: variant === "hero" ? ghMetaHero : ghMeta,
      top: variant === "hero" ? 9 : 8,
      content: escapeHtml(gh.meta),
    })
    if (desc) {
      bodyRows.push({
        className: "outlook-card-summary",
        style: variant === "hero" ? bodyLarge : bodySmall,
        top: variant === "hero" ? 10 : 8,
        content: escapeHtml(desc),
      })
    }
  } else if (pick.summaryZh) {
    // 排版均衡（#1）：双列窄卡摘要 clamp —— 长短悬殊的配对是「有些块长有些短」的主凶
    const summaryText = clampText(pick.summaryZh, density.summaryChars[variant])
    if (summaryText) {
      bodyRows.push({
        className: "outlook-card-summary",
        style: variant === "hero" ? bodyLarge : bodySmall,
        top: variant === "hero" ? 10 : 8,
        content: escapeHtml(summaryText),
      })
    }
  }
  // 质量层 2「N 源同报」徽章：多源印证即头条信号，来源名给读者交叉核验入口
  const alsoRows: CardRow[] = alsoLabels.length
    ? [
        {
          style: `font-size:12px;line-height:18px;letter-spacing:0.5px;color:${C.gold};`,
          top: 10,
          content: `◈ ${alsoLabels.length + 1} 源同报 · ${escapeHtml(alsoLabels.slice(0, 3).join(" · "))}`,
        },
      ]
    : []

  if (meta.category === "community" && variant === "hero") {
    return insetCardRows(
      [
        {
          style: `font-size:12px;font-weight:700;line-height:18px;letter-spacing:1px;color:${C.gold};`,
          bottom: 10,
          content: `${escapeHtml(label)} · 焦点`,
        },
        {
          className: needsOutlookBreakAll(item.title) ? "outlook-break-long" : undefined,
          content: `<a class="digest-serif" href="${href}" style="${titleHero}">${escapeHtml(item.title)}</a>`,
        },
        ...bodyRows,
        ...alsoRows,
      ],
      22,
    )
  }

  if (variant === "hero") {
    const heroHeader = `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td valign="middle" style="padding:0;"><table class="hero-badge-table" role="presentation" cellpadding="0" cellspacing="0" bgcolor="${C.gold}" style="border-collapse:separate;border-spacing:0;background-color:${C.gold};border-radius:12px;"><tr><td bgcolor="${C.gold}" style="color:${C.white};font-size:11px;font-weight:700;line-height:17px;letter-spacing:1px;padding:4px 10px;">${escapeHtml(meta.hero)}</td></tr></table></td><td width="10" bgcolor="${C.heroLight}" aria-hidden="true" style="width:10px;background-color:${C.heroLight};font-size:0;line-height:0;"></td><td valign="middle" style="font-size:12px;font-weight:700;line-height:18px;letter-spacing:1px;color:${C.gold};padding:0;">${escapeHtml(label)} · ${noStr}</td></tr></table>`
    return insetCardRows(
      [
        { content: heroHeader, bottom: 10 },
        {
          className: needsOutlookBreakAll(item.title) ? "outlook-break-long" : undefined,
          content: `<a class="digest-serif" href="${href}" style="${titleHero}">${escapeHtml(item.title)}</a>`,
        },
        ...bodyRows,
        ...alsoRows,
      ],
      22,
    )
  }

  const titleStyle = variant === "wide" ? titleWide : titleCol
  const titleClass = needsOutlookBreakAll(item.title) ? "outlook-break-long" : undefined
  return insetCardRows(
    [
      { style: kickerCol, bottom: 8, content: `${escapeHtml(label)} · ${noStr}` },
      {
        className: titleClass,
        content: `<a href="${href}" style="${titleStyle}">${escapeHtml(item.title)}</a>`,
      },
      ...bodyRows,
      ...alsoRows,
    ],
    variant === "wide" ? 20 : 18,
  )
}

/** GitHub 榜单卡（#2）：每种榜一张列表卡 —— 榜单的正确形态是行式列表，不是新闻卡片对 */
function ghListCard(
  entries: Array<{ pick: SectionPick; item: NormalizedItem }>,
  density: HtmlDensity,
): string {
  const rows = entries
    .map((e, i) => {
      const href = safeHref(e.item.canonicalUrl)
      const gh = splitGithubSnippet(e.pick.summaryZh)
      const meta = [gh ? gh.meta : "", githubRankStatusLabel(e.item)].filter(Boolean).join(" · ")
      const desc = clampText(
        e.pick.descZh ?? (gh ? gh.desc : e.pick.summaryZh),
        density.githubDescChars,
      )
      const hasNext = i < entries.length - 1
      // B036：Word 会把独立 height + &nbsp; spacer 画成着色矩形；把同等留白附着到
      // 前一条最后一个真实内容 cell，下一条仍以 border-top + padding-top 分隔。
      const titleBottom = hasNext && !meta && !desc ? "padding-bottom:12px;" : ""
      const metaBottom = hasNext && meta && !desc ? "padding-bottom:12px;" : ""
      const descBottom = hasNext && desc ? "padding-bottom:12px;" : ""
      const titleCellClass = needsOutlookBreakAll(e.item.title)
        ? "digest-sans outlook-break-long"
        : "digest-sans"
      return (
        `<tr><td class="${titleCellClass}" style="${i > 0 ? `border-top:1px solid ${C.border};padding:12px 0 0 0;` : "padding:0;"}${titleBottom}"><span class="digest-sans" style="font-size:12px;font-weight:700;letter-spacing:1px;color:${C.muted};">${String(i + 1).padStart(2, "0")}</span>&nbsp;&nbsp;<a class="digest-sans" href="${href}" style="font-size:16px;font-weight:700;line-height:24px;color:${C.title};text-decoration:none;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(e.item.title)}</a></td></tr>` +
        (meta
          ? `<tr><td class="github-meta-row digest-sans" style="${ghMeta}padding:8px 0 0 0;${metaBottom}">${escapeHtml(meta)}</td></tr>`
          : "") +
        (desc
          ? `<tr><td class="outlook-card-summary digest-sans" style="${bodySmall}padding:8px 0 0 0;${descBottom}">${escapeHtml(desc)}</td></tr>`
          : "")
      )
    })
    .join("")
  const content = cardContentTable(rows, SANS)
  return `<tr><td style="padding:0 0 16px 0;"><table class="digest-sans outlook-list-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.card}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.card};border:1px solid ${C.border};border-radius:16px;font-family:${SANS};"><tr><td style="padding:20px;">${content}</td></tr></table></td></tr>`
}

function heroRow(inner: string): string {
  return `<tr><td style="padding:0 0 16px 0;"><table class="digest-sans outlook-hero-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.heroLight}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.heroLight};border:1px solid ${C.border};border-top:3px solid ${C.accent};border-radius:16px;font-family:${SANS};">${inner}</table></td></tr>`
}

function wideRow(inner: string): string {
  return `<tr><td style="padding:0 0 16px 0;"><table class="digest-sans outlook-story-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.card}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.card};border:1px solid ${C.border};border-radius:16px;font-family:${SANS};">${inner}</table></td></tr>`
}

function colCard(inner: string): string {
  return `<table class="digest-sans outlook-story-card" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.card}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.card};border:1px solid ${C.border};border-radius:16px;font-family:${SANS};">${inner}</table>`
}

function twoColRow(left: string, right: string): string {
  // B036：双栏中央只是一列结构间距。透明 &nbsp; cell 会被 Word 画成贯穿整行的灰块；
  // 保留固定列宽，但去掉文本节点并明确归属暖白纸面，现代客户端的 16px 几何不变。
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;border-collapse:collapse;table-layout:fixed;"><tr><td width="272" valign="top" style="width:272px;padding:0;">${colCard(left)}</td><td width="16" bgcolor="${C.paper}" aria-hidden="true" style="width:16px;background-color:${C.paper};font-size:0;line-height:0;"></td><td width="272" valign="top" style="width:272px;padding:0;">${colCard(right)}</td></tr></table></td></tr>`
}

/** 板块标题：恢复克制的上一版排法，以陶土英文眉题和细分隔线建立层级。 */
function sectionHeading(meta: SectionMeta, first: boolean): string {
  const pad = first ? "10px 0 16px 0" : "28px 0 16px 0"
  return `<tr><td style="padding:${pad};"><a name="${meta.anchor}"></a><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr><td style="font-family:${SANS};font-size:12px;font-weight:700;line-height:18px;letter-spacing:2px;color:${C.gold};padding:0;">${escapeHtml(meta.en)}</td></tr><tr><td class="digest-serif" style="font-family:${SERIF};mso-fareast-font-family:SimSun;font-size:26px;font-weight:700;line-height:34px;color:${C.title};padding:4px 0 0 0;">${escapeHtml(meta.label)}</td></tr><tr><td bgcolor="${C.paper}" style="border-bottom:1px solid ${C.border};background-color:${C.paper};font-size:0;line-height:0;padding:12px 0 0 0;">&nbsp;</td></tr></table></td></tr>`
}

interface SubNavEntry {
  nav: string
  links: Array<{ label: string; anchor: string; count: number }>
}

/** 顶部导览卡：今日速览概述 + 板块格（锚点跳转 + 条数）+ 子栏目录行（07-05 晚：邮件里的"tab 栏"） */
function navCard(
  overview: string[],
  chips: Array<{ meta: SectionMeta; count: number }>,
  density: HtmlDensity,
  subNav: SubNavEntry[] = [],
  overviewLabel = "今日速览 · AT A GLANCE",
): string {
  const n = chips.length
  const chipW = n > 0 ? Math.floor((524 - (n - 1) * 8) / n) : 524
  let cells = ""
  chips.forEach((c, i) => {
    cells += `<td width="${chipW}" valign="top" style="width:${chipW}px;padding:0;"><table class="outlook-nav-chip" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.paper}" style="width:100%;border-collapse:separate;border-spacing:0;background-color:${C.paper};border:1px solid ${C.border};border-radius:12px;"><tr><td align="center" style="padding:12px 4px;"><a href="#${c.meta.anchor}" style="text-decoration:none;color:${C.ink};"><span style="font-family:${SANS};font-size:13px;font-weight:700;color:${C.ink};line-height:20px;">${escapeHtml(c.meta.nav)}</span><br><span style="font-family:${SANS};font-size:12px;line-height:21px;letter-spacing:0.5px;color:${C.gold};">${c.count} 条</span></a></td></tr></table></td>`
    if (i < n - 1)
      cells += `<td class="outlook-nav-gutter" width="8" bgcolor="${C.heroLight}" aria-hidden="true" style="width:8px;background-color:${C.heroLight};font-size:0;line-height:0;"></td>`
  })
  const overviewRows = overview
    .map(
      (o) =>
        `<tr><td style="font-family:${SANS};font-size:14px;line-height:25px;color:${C.sub};padding:3px 0;"><span style="color:${C.accent};font-weight:700;">·</span>&nbsp;&nbsp;${escapeHtml(clampText(o, density.overviewChars))}</td></tr>`,
    )
    .join("")
  const overviewBlock = overview.length
    ? `<tr><td style="padding:22px 22px 17px 22px;"><table class="overview-content-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td style="font-family:${SANS};font-size:12px;font-weight:700;line-height:18px;letter-spacing:2px;color:${C.gold};padding:0 0 10px 0;">${escapeHtml(overviewLabel)}</td></tr>${overviewRows}</table></td></tr><tr><td style="padding:0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;"><tr><td bgcolor="${C.heroLight}" style="border-top:1px solid ${C.border};background-color:${C.heroLight};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`
    : ""
  // 子栏目录：一节一行「板块名　子栏1 n · 子栏2 n」，锚点直达（不支持锚点的客户端退化为静态目录，内容零丢失）
  const subLines = density.includeSubNav ? subNav.filter((s) => s.links.length > 0) : []
  const subBlock = subLines.length
    ? `<tr><td style="padding:12px 22px 18px 22px;"><table class="outlook-subnav-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;">${subLines.map((s) => `<tr><td class="outlook-subnav-label" width="64" valign="top" style="width:64px;vertical-align:top;padding:3px 0;font-family:${SANS};font-size:12px;font-weight:700;line-height:22px;color:${C.ink};">${escapeHtml(s.nav)}</td><td style="padding:3px 0;font-family:${SANS};font-size:12px;line-height:22px;color:${C.sub};">${s.links.map((l) => `<a href="#${l.anchor}" style="color:${C.gold};text-decoration:none;">${escapeHtml(l.label)}&nbsp;${l.count}</a>`).join("&nbsp;·&nbsp; ")}</td></tr>`).join("")}</table></td></tr>`
    : ""
  return `<tr><td style="padding:0 0 22px 0;"><table class="outlook-nav-shell" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.heroLight}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.heroLight};border:1px solid ${C.border};border-radius:16px;">${overviewBlock}<tr><td style="padding:16px 18px ${subBlock ? "4px" : "18px"} 18px;"><table class="outlook-nav-grid" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr>${cells}</tr></table></td></tr>${subBlock}</table></td></tr>`
}

/** github 板块标题按当日在场榜单自适应：单榜用榜名；多榜同场（月榜常驻后即每天）= 榜单合集 */
function adaptGithubMeta(base: SectionMeta, githubItems: NormalizedItem[]): SectionMeta {
  const kinds = new Set(githubItems.map((g) => g.sourceId))
  if (kinds.size <= 1) {
    if (kinds.has("github-trending-weekly")) return { ...base, en: "TRENDING REPOS · WEEKLY" }
    if (kinds.has("github-trending-monthly")) return { ...base, en: "TRENDING REPOS · MONTHLY" }
    return base
  }
  return { ...base, en: "TRENDING REPOS" }
}

/**
 * B 项（小孙 07-04）：信源/处理异常顶置提醒卡 —— 失败/超时环节在刊头下方醒目透出（页脚小字不够醒目），
 * X 源附 cookie 排障提示（一手动态断供最常见原因就是小号 cookie 过期）。全 escapeHtml；无链接。
 */
function alertCard(failed: SourceFetchResult[]): string {
  if (failed.length === 0) return ""
  const rows = failed
    .map((f) => {
      const reason =
        (f.errors[0] ?? "").slice(0, 90) || (f.status === "timeout" ? "超时" : "抓取失败")
      const hint =
        f.sourceId === "x-firsthand"
          ? `<tr><td style="font-family:${SANS};font-size:12px;line-height:20px;color:${C.gold};padding:2px 0 0 14px;">↳ 大概率小号 cookie 失效：重新提取 auth_token → 更新 RSSHub 容器变量并重启容器</td></tr>`
          : ""
      return `<tr><td style="font-family:${SANS};font-size:13px;line-height:23px;color:${C.ink};padding:5px 0 0 0;"><span style="font-weight:700;">▲ ${escapeHtml(sourceLabel(f.sourceId))}</span><span style="color:${C.sub};">　${escapeHtml(reason)}</span></td></tr>${hint}`
    })
    .join("")
  const content = `<table class="alert-content-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr><td style="font-family:${SANS};font-size:12px;font-weight:700;line-height:18px;letter-spacing:1px;color:${C.gold};padding:0;">⚠ 信源/处理异常 · PIPELINE ALERT</td></tr><tr><td style="font-family:${SANS};font-size:14px;line-height:25px;color:${C.sub};padding:6px 0 0 0;">本期 ${failed.length} 个信源或处理环节异常，对应板块内容可能缺失或不全：</td></tr>${rows}</table>`
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.alert}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.alert};border:1px solid ${C.goldLight};border-left:4px solid ${C.accent};border-radius:16px;"><tr><td style="padding:16px 20px 18px 20px;">${content}</td></tr></table></td></tr>`
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 剥控制字符正是本意
const MD_CONTROL_RE = /[\u0000-\u001f\u007f]+/g

/**
 * markdown/text 面通用折叠（德彪批次DE r2 P2）：**外部源**的 title/desc/url 可能带
 * 换行/控制字符（LLM 产文有 sanitizeText 闸，源原文没有）——一个 `\n` 就能打断
 * `- [title](url)` 列表行结构。控制字符→空格 + 空白折叠。
 */
function mdFold(s: string): string {
  return s.replace(MD_CONTROL_RE, " ").replace(/\s+/g, " ").trim()
}

/**
 * markdown 链接（德彪批次D r1 P2 + r2 控制字符补口）：text 折叠控制字符+转义方括号；
 * URL 剥控制字符+编码空格与圆括号（`[text](url)` 结构三害：换行/空格/括号）。
 */
export function mdLink(text: string, url: string): string {
  // 德彪 r-final P1-1：反斜杠必须先转义——title 带 `\](evil)` 时旧实现产出 `\\]`（字面
  // 反斜杠+未转义 `]`），链接文本被提前闭合、后面括号段被解析成链接目标（md 面链接注入）。
  const safeText = mdFold(text)
    .replace(/\\/g, "\\\\")
    .replace(/([[\]])/g, "\\$1")
  // URL 与 HTML 面 safeHref 同口径：只放行 http(s)（此前 md 面无 scheme 门）
  const safeUrl = /^https?:\/\//i.test(url)
    ? url
        .replace(MD_CONTROL_RE, "")
        .replace(/ /g, "%20")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
    : "#"
  return `[${safeText}](${safeUrl})`
}

function pushItemMd(
  md: string[],
  item: NormalizedItem,
  pick: SectionPick,
  alsoLabels: string[] = [],
): void {
  const alsoTail = alsoLabels.length ? `（${alsoLabels.length + 1} 源同报）` : ""
  // summaryZh 在 gh 榜路径承载原始 feed 的 meta/desc（非 LLM 产文）→ 同样过 mdFold
  md.push(
    `- ${mdLink(item.title, item.canonicalUrl)}`,
    `  ${pick.summaryZh ? `${mdFold(pick.summaryZh)} — ` : ""}${sourceLabel(item.sourceId)}${alsoTail}`,
  )
}

/** 质量层 3 简报型源（smol-ai 类）：标题无信息量——没被精选时连速览都不进（07-06） */
const BRIEFING_SOURCE_IDS: ReadonlySet<string> = new Set(deriveDeepReadSourceIds())

function renderDigestAtDensity(input: RenderInput, density: HtmlDensity): RenderedDigest {
  // B027 v2 适配层：只把 publication 明确批准的条目投影到既有 renderer 数据面，
  // 下方 HTML/CSS/文案与布局函数完全不动。递归一次后 publication 清空，避免双真相源。
  if (input.publication) {
    const approvedByCategory = new Map<DigestCategory, Set<string>>()
    for (const section of input.publication.sections) {
      approvedByCategory.set(
        section.category,
        new Set(section.entries.flatMap((entry) => [entry.itemId, ...(entry.alsoItemIds ?? [])])),
      )
    }
    const publishedSections: DigestSummary["sections"] = input.publication.sections
      .filter((section) => section.category !== "github" && section.category !== "podcast")
      .map((section) => {
        const picks = section.entries
          .filter((entry) => entry.role === "hero" || entry.role === "card")
          .map((entry) => ({
            itemId: entry.itemId,
            summaryZh: entry.summaryZh ?? "",
            ...(entry.displayTag ? { tag: entry.displayTag } : {}),
            ...(entry.alsoItemIds?.length ? { alsoItemIds: entry.alsoItemIds } : {}),
          }))
          .filter((pick) => pick.summaryZh.length > 0)
        const briefItemIds = section.entries
          .filter((entry) => entry.role === "brief")
          .map((entry) => entry.itemId)
        return {
          category: section.category,
          picks,
          ...(briefItemIds.length ? { briefItemIds } : {}),
        }
      })
    const communityApproved = [...(approvedByCategory.get("community") ?? new Set<string>())]
    const scannedItemCount =
      input.scannedItemCount ??
      input.items.length + (input.githubItems?.length ?? 0) + (input.podcastItems?.length ?? 0)
    return renderDigestAtDensity(
      {
        ...input,
        publication: undefined,
        summary: {
          ...input.summary,
          overview: input.publication.overview,
          sections: publishedSections,
          communityDropIds: undefined,
          communityFedIds: communityApproved.length ? communityApproved : undefined,
        },
        items: input.items.filter((item) => approvedByCategory.get(item.category)?.has(item.id)),
        githubItems: (input.githubItems ?? []).filter((item) =>
          approvedByCategory.get("github")?.has(item.id),
        ),
        podcastItems: (input.podcastItems ?? []).filter((item) =>
          approvedByCategory.get("podcast")?.has(item.id),
        ),
        scannedItemCount,
      },
      density,
    )
  }
  const itemsById = new Map(input.items.map((i) => [i.id, i]))
  for (const g of input.githubItems ?? []) itemsById.set(g.id, g)
  for (const p of input.podcastItems ?? []) itemsById.set(p.id, p)
  // 中文化补全（07-06）：本次渲染实际展示的速览行 id——job 层据此送翻译再二次渲染
  const restItemIds: string[] = []
  const densitySuppressedCategories = new Set<DigestCategory>()

  const edition = digestEdition(input.businessDate)
  const degradedTag = input.summary.degraded ? "（清单版）" : ""
  const subject = `📰 DailyBrief ${input.businessDate}${edition.subjectSuffix}${degradedTag}`
  const weekday = weekdayZh(input.businessDate)

  const sectionsByCat = new Map(input.summary.sections.map((s) => [s.category, s.picks]))
  if (input.githubItems && input.githubItems.length > 0) {
    // 分栏改版 #2：按榜种分组限量（日 6 / 周 8 / 新秀 4 / 月 8），kind 顺序即渲染顺序
    const byKind = new Map<string, NormalizedItem[]>()
    for (const g of input.githubItems) {
      const list = byKind.get(g.sourceId) ?? []
      list.push(g)
      byKind.set(g.sourceId, list)
    }
    const ghPicks: SectionPick[] = []
    const ghZh = input.summary.githubDescZh
    const pushKind = (kind: string, cap: number) => {
      for (const g of (byKind.get(kind) ?? []).slice(0, cap)) {
        const zh = ghZh?.[g.id]
        // descZh 结构化携带（德彪批次D r1 P2）：summaryZh 恒为原始 snippet（解析永远成立），
        // 中文描述在渲染处覆盖 desc 段，不回拼字符串
        ghPicks.push({
          itemId: g.id,
          summaryZh: g.rawSnippet.slice(0, 200),
          ...(zh ? { descZh: zh } : {}),
        })
      }
    }
    for (const kind of GH_KIND_ORDER) pushKind(kind, GH_EMAIL_CAPS[kind] ?? 8)
    for (const kind of byKind.keys()) {
      if (!GH_KIND_ORDER.includes(kind)) pushKind(kind, 8) // 表外榜种兜底不丢
    }
    sectionsByCat.set("github", ghPicks)
  }
  // #33 播客速递：合成 picks 直渲（summaryZh=转写提炼要点；集数天然少不限量）
  if (input.podcastItems && input.podcastItems.length > 0) {
    sectionsByCat.set(
      "podcast",
      input.podcastItems.map((p) => ({ itemId: p.id, summaryZh: p.rawSnippet })),
    )
  }

  // 预解析各板块（丢弃 itemId 找不到的 pick），导览计数与分区渲染共用同一结果。
  // 质量层 2/3：全局 usedIds 抑制重复（已作主条/同报出现过的 item 不再成卡）；
  // 深读产物在此覆盖展示标题/摘要（浅拷贝只改展示层，链接仍严格走 canonicalUrl）。
  const deepById = new Map((input.summary.deepReads ?? []).map((d) => [d.itemId, d]))
  // 社区速览反选（07-12 小孙）：LLM 判性质不合格的 community 条目不进速览行。构建时
  // 按 category 限定作用面（双保险：parse 层只有 id 白名单，LLM 误吐 ai/hot 板块 id
  // 在这里被丢弃，不可能影响其它板块）。只影响速览行谓词，picks 渲染不经过它——
  // 同一条被 pick 又被 drop 时精选照常展示（选了=有价值，反选只管未选残余）。
  const communityDrop = new Set(
    (input.summary.communityDropIds ?? []).filter(
      (id) => itemsById.get(id)?.category === "community",
    ),
  )
  // 审查集合闭合（德彪 hitrate-r1 P1）：community 喂样有 36 上限，视野外条目 LLM 无从
  // 反选——速览候选必须限于「LLM 看过」的集合，否则未审八卦帖补位绕过反选。
  // fedIds 缺失（老 summary/降级清单版）= fail-open 不限（此时反选字段同样缺失，语义自洽）。
  const communityFed = input.summary.communityFedIds ? new Set(input.summary.communityFedIds) : null
  // 社区速览拦截谓词：保留门与 restAll 共用**同一函数**（jtw-r3 同式纪律的强化形态）；
  // 非 community 条目恒 false（drop 构建已滤板块、fed 只约束 community）。
  const communityRestBlocked = (i: NormalizedItem): boolean =>
    i.category === "community" &&
    (communityDrop.has(i.id) || (communityFed !== null && !communityFed.has(i.id)))
  const usedIds = new Set<string>()
  const sections = SECTION_META.map((baseMeta) => {
    const meta =
      baseMeta.category === "github"
        ? adaptGithubMeta(baseMeta, input.githubItems ?? [])
        : edition.weekendRoundup && baseMeta.category === "hot"
          ? {
              ...baseMeta,
              label: "周末热点",
              nav: "周末热点",
              en: "WEEKEND HIGHLIGHTS",
            }
          : baseMeta
    const picks = sectionsByCat.get(meta.category) ?? []
    const resolved = picks
      .map((pick) => ({ pick, item: itemsById.get(pick.itemId) }))
      .filter((x): x is { pick: SectionPick; item: NormalizedItem } => x.item !== undefined)
      .filter(({ pick }) => {
        if (usedIds.has(pick.itemId)) return false
        usedIds.add(pick.itemId)
        for (const a of pick.alsoItemIds ?? []) usedIds.add(a)
        return true
      })
      .map(({ pick, item }) => {
        const deep = deepById.get(pick.itemId)
        const alsoLabels = [
          ...new Set(
            (pick.alsoItemIds ?? [])
              .map((id) => itemsById.get(id))
              .filter((i): i is NormalizedItem => i !== undefined)
              .map((i) => sourceLabel(i.sourceId)),
          ),
        ].filter((l) => l !== sourceLabel(item.sourceId))
        return {
          pick: deep ? { ...pick, summaryZh: deep.summaryZh } : pick,
          item: deep ? { ...item, title: deep.titleZh } : item,
          alsoLabels,
        }
      })
    // 分栏结构前置计算（07-05 晚）：导览目录要挂子栏锚点 → 分组在渲染循环之前算好共用
    const [, ...restPicks] = resolved
    const order = sectionGroupOrder(meta.category) ?? []
    const groupedMap = new Map<string, typeof resolved>()
    if (meta.category !== "github") {
      for (const e of restPicks) {
        const key = groupKeyOf(meta.category, e.item, e.pick)
        const list = groupedMap.get(key) ?? []
        list.push(e)
        groupedMap.set(key, list)
      }
    }
    const orderedKeys = [
      ...order.filter((k) => groupedMap.has(k)),
      ...[...groupedMap.keys()].filter((k) => !order.includes(k)),
    ]
    const groups = orderedKeys.map((key, gi) => ({
      key,
      entries: groupedMap.get(key) ?? [],
      anchor: `sub-${meta.category}-${gi}`,
    }))
    return { meta, resolved, groups }
  }).filter(
    (s) =>
      s.resolved.length > 0 ||
      // B045：周一是周末合刊，五栏骨架不随“碰巧哪一栏有无新内容”收缩。
      // 空态只属于展示层，不进入 publication/shown，也不能绕过 job 的非 GitHub 正文门。
      edition.weekendRoundup ||
      // 07-12 德彪 jtw-r1 P1：picks 被摘空（如无字幕 yt 摘除门）但类目仍有速览候选 →
      // 保留 rest-only section（只渲染速览区）；一刀切丢弃会让整类蒸发，而 job 已把
      // 喂样烧进 shown = 条目本期没展示还被账本压制，永久漏报。
      // 例外一：repairDropped 丢节类目保持蒸发——那是截断事故，条目要「不渲染不烧账、
      // 明日回补精选竞争」（德彪 r-final P1-3 既有语义），以速览渲染反而把回补烧没了。
      // 例外二（jtw-r2 P2-1）：速览容量 0（用户关速览/超预算自动降 0）时 rest-only 必然
      // 渲染不出任何行 → 不保留（防空板块壳）；此时条目没展示但喂样照烧 shown 是**既有
      // 语义**（关速览=用户放弃这批条目的展示，不烧会次日全量回流轰炸）——非本批引入
      (Math.max(0, Math.min(30, input.restOverviewRows ?? 12)) > 0 &&
        !(input.summary.repairDroppedCategories ?? []).includes(s.meta.category) &&
        // 候选谓词与下方速览区 restAll 完全同式（jtw-r3：漏 usedIds 时「唯一候选被
        // 其它板块 pick/alsoItemIds 占用」的类目会以空壳形态保留；communityRestBlocked
        // 同理——候选全被反选/审查集合外的 community 节不保留，撑不起板块）
        input.items.some(
          (i) =>
            i.category === s.meta.category &&
            !usedIds.has(i.id) &&
            !BRIEFING_SOURCE_IDS.has(i.sourceId) &&
            !communityRestBlocked(i),
        )),
  )

  const failed = input.results.filter((r) => r.status !== "ok")

  const mdTitle = edition.weekendRoundup
    ? `# 每日简报 ${input.businessDate} · 周末速览（${edition.coverageLabel}）${degradedTag}`
    : `# DailyBrief ${input.businessDate}${degradedTag}`
  const mdParts: string[] = [mdTitle, ""]
  if (failed.length > 0) {
    mdParts.push(
      `> ⚠ 信源/处理异常：${failed.map((f) => `${sourceLabel(f.sourceId)}(${f.status})`).join("、")}`,
      "",
    )
  }
  if (input.summary.overview.length > 0) {
    mdParts.push(
      edition.weekendRoundup ? `## 周末速览 · ${edition.coverageLabel}` : "## 今日速览",
      ...input.summary.overview.map((o) => `- ${o}`),
      "",
    )
  }

  const chips = sections.map((s) => ({ meta: s.meta, count: s.resolved.length }))
  // 子栏目录（≥2 组的板块才有"tab 栏"可跳；github 独立榜种标题不进目录）
  const subNav = sections
    .filter((s) => s.meta.category !== "github" && s.groups.length >= 2)
    .map((s) => ({
      nav: s.meta.nav,
      links: s.groups
        .filter((g) => g.entries.length > 0)
        .map((g) => ({ label: g.key, anchor: g.anchor, count: g.entries.length })),
    }))

  const sectionHtml: string[] = []
  sections.forEach((s, si) => {
    sectionHtml.push(sectionHeading(s.meta, si === 0))
    mdParts.push(`## ${s.meta.label}`, "")

    // 先算速览候选，避免把“没有精选但仍有速览”的正常板块误判成周一空态。
    // 这个谓词与上方 section 保留门保持同式。
    const restCap = Math.max(0, Math.min(30, input.restOverviewRows ?? 12))
    const restAll = input.items.filter(
      (i) =>
        i.category === s.meta.category &&
        !usedIds.has(i.id) &&
        !BRIEFING_SOURCE_IDS.has(i.sourceId) &&
        !communityRestBlocked(i),
    )
    const restShown = restCap === 0 ? [] : diversifyBySource(restAll, restCap)
    if (restAll.length > 0 && restShown.length === 0) {
      densitySuppressedCategories.add(s.meta.category)
    }

    if (s.resolved.length === 0 && restShown.length === 0) {
      const hiddenByDensity =
        restAll.length > 0 || input.densitySuppressedCategories?.includes(s.meta.category)
      const emptyMessage =
        hiddenByDensity
          ? "本周末有合资格内容，因邮件密度设置未展开"
          : {
              ai: "本周末暂无合资格的 AI 动态",
              community: "本周末暂无合资格的社区动态",
              hot: "本周末暂无合资格的热点",
              podcast: "本周末暂无新节目",
              github: "截至周一暂无合资格的开源榜单项目",
            }[s.meta.category]
      sectionHtml.push(emptySectionCard(emptyMessage), backToTopRow())
      mdParts.push(emptyMessage, "")
      return
    }

    // GitHub：榜种标题与 AI/X 共用 subHeading；每种榜随后是一张行式列表卡。
    if (s.meta.category === "github") {
      const byKind = new Map<string, typeof s.resolved>()
      for (const e of s.resolved) {
        const list = byKind.get(e.item.sourceId) ?? []
        list.push(e)
        byKind.set(e.item.sourceId, list)
      }
      let groupIndex = 0
      for (const [kind, entries] of byKind) {
        const label = ghKindLabel(kind)
        sectionHtml.push(subHeading(label, entries.length, `sub-github-${groupIndex}`))
        sectionHtml.push(ghListCard(entries, density))
        groupIndex++
        mdParts.push(`### ${label}`, "")
        for (const e of entries) {
          // md 版同享 descZh：meta 数据行 + 中文描述拼展示串（不再进任何 parser）
          const gh = splitGithubSnippet(e.pick.summaryZh)
          const rankStatus = githubRankStatusLabel(e.item)
          const mdSummary = gh
            ? [gh.meta, rankStatus, e.pick.descZh ?? gh.desc].filter(Boolean).join("　")
            : (e.pick.descZh ?? e.pick.summaryZh)
          pushItemMd(mdParts, e.item, { ...e.pick, summaryZh: mdSummary }, e.alsoLabels)
        }
        mdParts.push("")
      }
      sectionHtml.push(backToTopRow())
      return
    }

    // rest-only section（jtw-r1 P1）：picks 被摘空时无焦点卡，直接落到下方速览区
    const [hero] = s.resolved
    if (hero) {
      sectionHtml.push(
        heroRow(renderCardInner(hero.item, hero.pick, 1, s.meta, "hero", density, hero.alsoLabels)),
      )
      pushItemMd(mdParts, hero.item, hero.pick, hero.alsoLabels)
    }

    // 分栏改版：焦点卡之外按子栏分组（ai=推理/公司/…、hot=分类、x=公司/从业者）；
    // 分组已在 sections 步前置算好（导览目录共用锚点）；单组不出子标题（回落扁平观感）
    const showHeaders = s.groups.length >= 2
    let no = 2
    for (const group of s.groups) {
      const entries = group.entries
      if (entries.length === 0) continue
      if (showHeaders) {
        sectionHtml.push(subHeading(group.key, entries.length, group.anchor))
        mdParts.push(`### ${group.key}`, "")
      }
      // 排版均衡（#1）：奇数条 → 最长一条整宽收长文（不再是"谁排最后谁落单"）；
      // 其余按估高降序相邻配对，高矮相近的成对 → 双列不再一长一短
      const sorted = [...entries].sort(
        (a, b) => estHeight(b.item, b.pick) - estHeight(a.item, a.pick),
      )
      let pairs = sorted
      if (sorted.length % 2 === 1) {
        const wide = sorted[0]
        pairs = sorted.slice(1)
        sectionHtml.push(
          wideRow(
            renderCardInner(wide.item, wide.pick, no, s.meta, "wide", density, wide.alsoLabels),
          ),
        )
        pushItemMd(mdParts, wide.item, wide.pick, wide.alsoLabels)
        no++
      }
      for (let i = 0; i < pairs.length; i += 2) {
        const L = pairs[i]
        const R = pairs[i + 1]
        if (!R) {
          // 理论不可达（上面已取偶）；防御性整宽渲染
          sectionHtml.push(
            wideRow(renderCardInner(L.item, L.pick, no, s.meta, "wide", density, L.alsoLabels)),
          )
          pushItemMd(mdParts, L.item, L.pick, L.alsoLabels)
          no++
          continue
        }
        if (needsOutlookWideRow(L.item.title) || needsOutlookWideRow(R.item.title)) {
          for (const entry of [L, R]) {
            sectionHtml.push(
              wideRow(
                renderCardInner(
                  entry.item,
                  entry.pick,
                  no,
                  s.meta,
                  "wide",
                  density,
                  entry.alsoLabels,
                ),
              ),
            )
            pushItemMd(mdParts, entry.item, entry.pick, entry.alsoLabels)
            no++
          }
          continue
        }
        sectionHtml.push(
          twoColRow(
            renderCardInner(L.item, L.pick, no, s.meta, "col", density, L.alsoLabels),
            renderCardInner(R.item, R.pick, no + 1, s.meta, "col", density, R.alsoLabels),
          ),
        )
        pushItemMd(mdParts, L.item, L.pick, L.alsoLabels)
        pushItemMd(mdParts, R.item, R.pick, R.alsoLabels)
        no += 2
      }
      if (showHeaders) mdParts.push("")
    }

    // 其余速览（07-05 晚「邮件自足」）：本板块没被精选的条目压紧凑行区直接印出来，
    // 排序源内轮转（不跨平台直比热度量纲），默认 12 行守 Gmail 102KB 裁剪线（设置页可调 0-30）。
    // 07-06 小孙「not much happened today 太扯」：简报型源（标题无信息量）没被精选就不进速览
    if (restShown.length > 0) {
      for (const i of restShown) restItemIds.push(i.id)
      const titleZh = input.summary.restTitleZh
      sectionHtml.push(restRowsCard(restShown, restAll.length, titleZh))
      mdParts.push(
        `### 其余速览（共 ${restAll.length} 条）`,
        ...restShown.map(
          (i) =>
            `- ${mdLink(titleZh?.[i.id] ?? i.title, i.canonicalUrl)} — ${sourceLabel(i.sourceId)}`,
        ),
        "",
      )
    }
    sectionHtml.push(backToTopRow())
    mdParts.push("")
  })

  // 页脚源健康（AC8 透出；保留内部 sourceId 便于排障）
  const okCount = input.results.length - failed.length
  const healthLine =
    failed.length === 0
      ? `全部 ${input.results.length} 个源正常`
      : `${okCount}/${input.results.length} 源正常；异常：${failed.map((f) => `${f.sourceId}(${f.status})`).join("、")}`
  // 质量层 4 体检行（主表 §2，抄 AINews "We checked 12 subreddits, 544 Twitters"）：
  // 透明度 = 信任感；扫描量与精选量同框，讲清筛选力度
  const scannedCount =
    input.scannedItemCount ??
    input.items.length + (input.githubItems?.length ?? 0) + (input.podcastItems?.length ?? 0)
  const pickCount = chips.reduce((n, c) => n + c.count, 0)
  const checkLine = `本期扫描 ${okCount}/${input.results.length} 源 · 收录 ${scannedCount} 条 · 精选 ${pickCount} 条`

  const notes = [...(input.notes ?? [])]
  // 网页版链接（#2 可点分栏在网页；邮件客户端剥 JS/表单，做不了真 tabs）
  const webUrl = input.webBaseUrl
    ? `${input.webBaseUrl.replace(/\/$/, "")}/digest/${input.businessDate}`
    : null
  mdParts.push(
    "---",
    checkLine,
    `源健康：${healthLine}`,
    ...(webUrl ? [`网页版：${webUrl}`] : []),
    ...notes,
  )

  // B036：动态多行刊头留在普通 presentation table。Classic Outlook 只退化方角，
  // 不再让 VML textbox 接管高度/背景；可见眉题本身承载 Word 可识别的非空书签。
  const editionRow = edition.mastheadSubtitle
    ? `<tr><td style="font-family:${SANS};font-size:12px;font-weight:700;line-height:20px;letter-spacing:1px;color:${C.goldLight};padding:6px 0 0 0;">${escapeHtml(edition.mastheadSubtitle)}</td></tr>`
    : ""
  const weekendCategoryLine = sections
    .map((section) => {
      if (section.meta.category === "ai") return "AI"
      if (section.meta.category === "hot") return "周末热点"
      return section.meta.label
    })
    .join(" · ")
  const categoryLine = edition.weekendRoundup
    ? weekendCategoryLine || "周末新闻合辑"
    : `AI · 社区动态 · 今日热点 · ${DIGEST_GITHUB_SECTION_LABEL}`
  const mastheadContent = `<table class="masthead-content-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr><td style="font-family:${SANS};font-size:12px;font-weight:700;line-height:18px;letter-spacing:3px;color:${C.goldLight};padding:0 0 8px 0;"><a id="DigestTop" name="DigestTop" style="font-family:${SANS};font-size:12px;font-weight:700;line-height:18px;letter-spacing:3px;color:${C.goldLight};text-decoration:none;">MULTI-AGENT · DAILY BRIEF</a></td></tr><tr><td class="digest-serif" style="font-family:${SERIF};mso-fareast-font-family:SimSun;font-size:38px;font-weight:700;letter-spacing:1px;color:${C.white};line-height:46px;padding:0;">每日简报</td></tr><tr><td height="14" bgcolor="${C.ink}" style="height:14px;background-color:${C.ink};line-height:14px;font-size:0;">&nbsp;</td></tr><tr><td style="padding:0;"><table role="presentation" width="52" cellpadding="0" cellspacing="0" style="width:52px;border-collapse:collapse;"><tr><td height="2" bgcolor="${C.accent}" style="height:2px;background-color:${C.accent};font-size:0;line-height:2px;">&nbsp;</td></tr></table></td></tr><tr><td height="14" bgcolor="${C.ink}" style="height:14px;background-color:${C.ink};line-height:14px;font-size:0;">&nbsp;</td></tr><tr><td style="font-family:${SANS};font-size:14px;line-height:22px;letter-spacing:0.5px;color:${C.goldLight};padding:0;">${escapeHtml(input.businessDate)}${weekday ? `　${escapeHtml(weekday)}` : ""}${input.summary.degraded ? "　· 清单版" : ""}</td></tr>${editionRow}<tr><td style="font-family:${SANS};font-size:13px;line-height:21px;letter-spacing:0.5px;color:${C.cream};padding:3px 0 0 0;">${escapeHtml(categoryLine)}</td></tr><tr><td height="14" bgcolor="${C.ink}" style="height:14px;background-color:${C.ink};line-height:14px;font-size:0;">&nbsp;</td></tr><tr><td bgcolor="${C.ink}" style="border-top:1px solid ${C.goldLight};background-color:${C.ink};font-size:0;line-height:0;padding:0;">&nbsp;</td></tr><tr><td style="font-family:${SANS};font-size:12px;line-height:19px;letter-spacing:0.5px;color:${C.goldLight};padding:10px 0 0 0;">${escapeHtml(checkLine)}</td></tr>${webUrl ? `<tr><td style="font-family:${SANS};font-size:12px;line-height:19px;letter-spacing:0.5px;padding:6px 0 0 0;"><a href="${safeHref(webUrl)}" style="color:${C.goldLight};text-decoration:underline;">网页版全量分栏 →</a></td></tr>` : ""}</table>`
  const masthead = `<tr><td style="padding:0 0 18px 0;"><table class="masthead-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.ink}" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.ink};border:1px solid ${C.ink};border-top:6px solid ${C.accent};border-radius:16px;"><tr><td style="padding:26px 26px 24px 26px;">${mastheadContent}</td></tr></table></td></tr>`

  const footerRows = `<tr><td style="font-family:${SANS};font-size:12px;line-height:22px;color:${C.sub};padding:0;">源健康：${escapeHtml(healthLine)}</td></tr>${webUrl ? `<tr><td style="font-family:${SANS};font-size:12px;line-height:22px;padding:0;"><a href="${safeHref(webUrl)}" style="color:${C.gold};text-decoration:underline;">网页版全量分栏（可点切换）→</a></td></tr>` : ""}${notes.length ? `<tr><td style="font-family:${SANS};font-size:12px;line-height:22px;color:${C.sub};padding:0;">${notes.map(escapeHtml).join("<br>")}</td></tr>` : ""}<tr><td style="font-family:${SANS};font-size:12px;line-height:22px;color:${C.muted};padding:6px 0 0 0;">DailyBrief · Multi-Agent · F037 每日简报</td></tr>`
  const footer = `<tr><td bgcolor="${C.paper}" style="border-bottom:1px solid ${C.border};background-color:${C.paper};font-size:0;line-height:0;padding:24px 0 0 0;">&nbsp;</td></tr><tr><td align="left" style="padding:18px 2px 8px 2px;"><table class="footer-content-table" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;">${footerRows}</table></td></tr>`

  const html = [
    "<!doctype html>",
    `<html lang="zh-CN" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light">${MSO_HEAD}<title>${edition.weekendRoundup ? "周末速览" : "每日简报"} · DailyBrief</title></head>`,
    `<body bgcolor="${C.page}" style="margin:0;padding:0;background-color:${C.page};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${C.page}" style="width:100%;border-collapse:collapse;background-color:${C.page};"><tr><td align="center" style="padding:28px 16px;">`,
    `<table class="outlook-paper" role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="${C.paper}" style="width:600px;max-width:600px;border-collapse:separate;border-spacing:0;background-color:${C.paper};border:1px solid ${C.border};border-radius:20px;"><tr><td style="padding:20px 19px;">`,
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;border-collapse:collapse;">`,
    masthead,
    alertCard(failed),
    navCard(input.summary.overview, chips, density, subNav, edition.overviewLabel),
    ...sectionHtml,
    footer,
    "</table>",
    "</td></tr></table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("\n")

  return {
    subject,
    html,
    markdown: mdParts.join("\n"),
    restItemIds,
    displayedItemIds: [...new Set([...usedIds, ...restItemIds])],
    densitySuppressedCategories: [...densitySuppressedCategories],
  }
}

/**
 * 先保持原版完整视觉；只有移除「其余速览」后仍会触发 Gmail 裁剪，才逐级缩短 HTML 摘要。
 * 标题、链接、条目集合和 Markdown 归档始终不变，正常日报（含本次 07-16 重发）不会进入降密度。
 */
export function renderDigest(input: RenderInput): RenderedDigest {
  let rendered = renderDigestAtDensity(input, FULL_DENSITY)
  if (
    Buffer.byteLength(rendered.html, "utf8") <= EMAIL_HTML_BYTE_BUDGET ||
    rendered.restItemIds.length > 0
  ) {
    return rendered
  }
  for (const density of HTML_DENSITY_STEPS.slice(1)) {
    rendered = renderDigestAtDensity(input, density)
    if (Buffer.byteLength(rendered.html, "utf8") <= EMAIL_HTML_BYTE_BUDGET) return rendered
  }
  return rendered
}
