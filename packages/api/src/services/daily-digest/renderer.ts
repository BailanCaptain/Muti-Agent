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
 * T11 渲染器 v4（AC2 版式 + AC12 邮件兼容 · Bento 大小格混排 + 顶部导览，小孙 07-04 选型 ② 并拍板）：
 * - 数据直出 HTML：链接只从 itemsById[pick.itemId].canonicalUrl 取（注入护栏落地，escapeHtml 全覆盖 / safeHref 只放 http(s)）
 * - table 布局 ≤600px、全内联样式、无 <script>/无远程图片/无 flex-grid/无 oklch/无 @media；固定像素多列（272+16+272）杜绝 %宽+padding 溢出错位
 * - 顶部导览卡：今日速览概述 + 4 板块格（锚点 <a href="#sec-xx">，Apple 邮件可跳，Gmail 剥 id 降级为目录/速览仍成立）
 * - 每板块 bento：首条 hero 大卡（X=深金焦点卡 / 其余=浅金徽标卡）+ 其余两两成对列，落单则整宽卡
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
    // 07-06 小孙改版：X 一手动态 → 社区动态（X + Reddit + Digg + V2EX + 小红书）
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
// 其余社区源按平台分组（Reddit/Digg/V2EX/小红书——真相源 shared digest-tags）

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

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : "#"
}

function weekdayZh(businessDate: string): string {
  const d = new Date(`${businessDate}T12:00:00+08:00`)
  if (Number.isNaN(d.getTime())) return ""
  return new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: "Asia/Shanghai" }).format(d)
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
  /** v2 过滤 raw lookup 后仍保留原「本期扫描」统计口径。 */
  scannedItemCount?: number
}

// 暖金 token：从产品 OKLCH 真相源换算的邮件可用 hex（邮件客户端不认 OKLCH）——数值对齐 dashboard-rank/DESIGN token，禁冷色
const C = {
  page: "#efe7e2", // 页面暖灰底
  card: "#ffffff",
  heroLight: "#f7efe9", // 浅金 hero / 导览卡
  border: "#efe7e2",
  ink: "#26201f", // 墨色标题 / 刊头底
  // 07-10 小孙「字体有些不太清晰」→ 正文灰从色板 #5c5856 加深一档（同暖色相，对比 6.9:1→9.3:1）
  sub: "#4a4644",
  gold: "#8a3a00", // accent-600 铜金（小字号点缀对比度）
  goldLight: "#eebb99",
  accent: "#d97a3e",
  white: "#ffffff",
  cream: "#f7efe9",
}

const SERIF = "Georgia,'Songti SC','PingFang SC','Microsoft YaHei',serif"
const SANS = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif"

const kickerCol = `font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;color:${C.gold};padding-bottom:8px;`
const bodySmall = `font-family:${SANS};font-size:13px;line-height:1.7;color:${C.sub};padding-top:8px;`
const bodyLarge = `font-family:${SANS};font-size:14px;line-height:1.75;color:${C.sub};padding-top:9px;`
const ghMeta = `font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.5px;color:${C.gold};padding-top:8px;`
const ghMetaHero = `font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:0.5px;color:${C.gold};padding-top:9px;`
const titleHero = `font-family:${SERIF};font-size:19px;font-weight:700;line-height:1.5;color:${C.ink};text-decoration:none;`
const titleWide = `font-family:${SERIF};font-size:16px;font-weight:700;line-height:1.5;color:${C.ink};text-decoration:none;word-break:break-word;`
const titleCol = `font-family:${SERIF};font-size:15px;font-weight:700;line-height:1.5;color:${C.ink};text-decoration:none;word-break:break-word;`
const titleXHero = `font-family:${SERIF};font-size:18px;font-weight:700;line-height:1.6;color:${C.white};text-decoration:none;`

/** 排版均衡（#1）：双列卡摘要截断（整宽/焦点卡不截，全文永远在链接里） */
function clampText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 排版均衡（#1）：估高分 —— 标题行数权重大（衬线大字），摘要按截断后长度算 */
function estHeight(item: NormalizedItem, pick: SectionPick): number {
  return item.title.length * 2 + Math.min(pick.summaryZh.length, 80)
}

/**
 * 子栏标题行（分栏改版；07-06 小孙「小标题不明显」升级）：浅金横带 + 左侧铜金竖条 +
 * 墨色 13px 粗体——从「细线上的小金字」升级成实体章节条，扫读时一眼见分界。
 * 单组板块不出（保持旧版扁平观感）。
 */
function subHeading(label: string, count: number, anchor: string): string {
  return `<tr><td style="padding:4px 0 12px 0;"><a name="${anchor}"></a><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.heroLight};border-left:3px solid ${C.accent};border-radius:8px;"><tr><td style="padding:8px 14px;font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:1px;color:${C.ink};">${escapeHtml(label)} · ${count} 条</td></tr></table></td></tr>`
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
      return `<div style="font-family:${SANS};font-size:13px;line-height:1.9;color:${C.sub};"><span style="color:${C.gold};font-weight:700;">${escapeHtml(sourceLabel(i.sourceId))}</span>　<a href="${href}" style="color:${C.ink};text-decoration:none;">${escapeHtml(clampText(shown, 64))}</a>${eng}</div>`
    })
    .join("")
  const headTail = total > rest.length ? `TOP ${rest.length} / 共 ${total} 条` : `${rest.length} 条`
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.heroLight};border:1px solid ${C.border};border-radius:14px;"><tr><td style="padding:14px 18px 16px 18px;"><div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;color:${C.gold};padding-bottom:6px;">◇ 其余速览 · ${headTail}</div>${rows}</td></tr></table></td></tr>`
}

/** 每节尾「回目录」：邮件里的导航回程（锚点是邮件唯一可用的"跳转"原语） */
function backToTopRow(): string {
  return `<tr><td align="right" style="padding:0 2px 6px 0;"><a href="#top" style="font-family:${SANS};font-size:12px;letter-spacing:1px;color:${C.gold};text-decoration:none;">↑ 回目录</a></td></tr>`
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

/** 单卡内容（kicker + 标题链接 + 正文），hero/wide/col 三态复用；X hero 为深金焦点卡 */
function renderCardInner(
  item: NormalizedItem,
  pick: SectionPick,
  no: number,
  meta: SectionMeta,
  variant: Variant,
  alsoLabels: string[] = [],
): string {
  const href = safeHref(item.canonicalUrl)
  const label = sourceLabel(item.sourceId)
  const noStr = String(no).padStart(2, "0")
  // 质量层 2「N 源同报」徽章：多源印证即头条信号，来源名给读者交叉核验入口
  const alsoChip = alsoLabels.length
    ? `<div style="font-family:${SANS};font-size:11px;letter-spacing:1px;color:${C.gold};padding-top:8px;">◈ ${alsoLabels.length + 1} 源同报 · ${escapeHtml(alsoLabels.slice(0, 3).join(" · "))}</div>`
    : ""

  // 社区焦点大卡（深金底、白字）——原 X 焦点卡待遇，整个社区板块共用
  if (meta.category === "community" && variant === "hero") {
    return (
      `<div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;color:${C.goldLight};padding-bottom:10px;">${escapeHtml(label)} · 焦点</div>` +
      `<a href="${href}" style="${titleXHero}">${escapeHtml(item.title)}</a>` +
      (pick.summaryZh
        ? `<div style="font-family:${SANS};font-size:13px;letter-spacing:1px;color:${C.goldLight};padding-top:10px;">${escapeHtml(pick.summaryZh)}</div>`
        : "") +
      alsoChip
    )
  }

  let body = ""
  const gh = meta.category === "github" ? splitGithubSnippet(pick.summaryZh) : null
  if (gh) {
    // 中文化补全：descZh 结构化覆盖英文 desc（meta 数据行原样保留）
    const desc = pick.descZh ?? gh.desc
    body =
      `<div style="${variant === "hero" ? ghMetaHero : ghMeta}">${escapeHtml(gh.meta)}</div>` +
      (desc
        ? `<div style="${variant === "hero" ? bodyLarge : bodySmall}">${escapeHtml(desc)}</div>`
        : "")
  } else if (pick.summaryZh) {
    // 排版均衡（#1）：双列窄卡摘要 clamp —— 长短悬殊的配对是「有些块长有些短」的主凶
    const summaryText = variant === "col" ? clampText(pick.summaryZh, 80) : pick.summaryZh
    body = `<div style="${variant === "hero" ? bodyLarge : bodySmall}">${escapeHtml(summaryText)}</div>`
  }

  if (variant === "hero") {
    return (
      `<div style="padding-bottom:10px;"><span style="display:inline-block;background-color:${C.gold};color:${C.white};font-family:${SANS};font-size:10px;font-weight:700;letter-spacing:2px;padding:3px 9px;border-radius:8px;">${escapeHtml(meta.hero)}</span>&nbsp;&nbsp;<span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;color:${C.gold};">${escapeHtml(label)} · ${noStr}</span></div>` +
      `<a href="${href}" style="${titleHero}">${escapeHtml(item.title)}</a>` +
      body +
      alsoChip
    )
  }

  const titleStyle = variant === "wide" ? titleWide : titleCol
  return (
    `<div style="${kickerCol}">${escapeHtml(label)} · ${noStr}</div>` +
    `<a href="${href}" style="${titleStyle}">${escapeHtml(item.title)}</a>` +
    body +
    alsoChip
  )
}

/** GitHub 榜单卡（#2）：每种榜一张列表卡 —— 榜单的正确形态是行式列表，不是新闻卡片对 */
function ghListCard(
  kindLabel: string,
  entries: Array<{ pick: SectionPick; item: NormalizedItem }>,
): string {
  const rows = entries
    .map((e, i) => {
      const href = safeHref(e.item.canonicalUrl)
      const gh = splitGithubSnippet(e.pick.summaryZh)
      const meta = [gh ? gh.meta : "", githubRankStatusLabel(e.item)].filter(Boolean).join(" · ")
      const desc = clampText(e.pick.descZh ?? (gh ? gh.desc : e.pick.summaryZh), 90)
      const divider =
        i > 0
          ? `<div style="border-top:1px solid ${C.border};font-size:0;line-height:0;margin-top:12px;">&nbsp;</div>`
          : ""
      return (
        divider +
        `<div style="padding-top:${i > 0 ? 12 : 0}px;"><span style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:1px;color:${C.gold};">${String(i + 1).padStart(2, "0")}</span>&nbsp;&nbsp;<a href="${href}" style="font-family:${SERIF};font-size:15px;font-weight:700;line-height:1.5;color:${C.ink};text-decoration:none;word-break:break-word;">${escapeHtml(e.item.title)}</a></div>` +
        (meta ? `<div style="${ghMeta}">${escapeHtml(meta)}</div>` : "") +
        (desc ? `<div style="${bodySmall}">${escapeHtml(desc)}</div>` : "")
      )
    })
    .join("")
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.card};border:1px solid ${C.border};border-radius:14px;"><tr><td style="padding:18px;"><div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;color:${C.gold};padding-bottom:4px;">◆ ${escapeHtml(kindLabel)} · ${entries.length}</div>${rows}</td></tr></table></td></tr>`
}

function heroRow(inner: string, category: DigestCategory): string {
  const bg = category === "community" ? C.gold : C.heroLight
  const border = category === "community" ? C.gold : C.border
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${bg};border:1px solid ${border};border-radius:14px;"><tr><td style="padding:18px;">${inner}</td></tr></table></td></tr>`
}

function wideRow(inner: string): string {
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.card};border:1px solid ${C.border};border-radius:14px;"><tr><td style="padding:18px;">${inner}</td></tr></table></td></tr>`
}

function colCard(inner: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;background-color:${C.card};border:1px solid ${C.border};border-radius:14px;"><tr><td style="padding:18px;">${inner}</td></tr></table>`
}

function twoColRow(left: string, right: string): string {
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;border-collapse:collapse;table-layout:fixed;"><tr><td width="272" valign="top" style="width:272px;padding:0;">${colCard(left)}</td><td width="16" style="width:16px;font-size:0;line-height:0;">&nbsp;</td><td width="272" valign="top" style="width:272px;padding:0;">${colCard(right)}</td></tr></table></td></tr>`
}

/** 板块大标题（07-06 小孙「标题不明显」升级）：竖条加粗 + 24px 衬线 + 通栏金底线收尾 */
function sectionHeading(meta: SectionMeta, first: boolean): string {
  const pad = first ? "6px 0 16px 0" : "22px 0 16px 0"
  return `<tr><td style="padding:${pad};"><a name="${meta.anchor}"></a><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr><td width="6" valign="top" style="width:6px;background-color:${C.accent};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td><td width="14" style="width:14px;font-size:0;line-height:0;">&nbsp;</td><td valign="middle" style="padding:0;"><div style="font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:3px;color:${C.accent};">${escapeHtml(meta.en)}</div><div style="font-family:${SERIF};font-size:24px;font-weight:700;color:${C.ink};padding-top:4px;">${escapeHtml(meta.label)}</div></td></tr><tr><td colspan="3" style="padding-top:10px;"><div style="border-bottom:2px solid ${C.goldLight};font-size:0;line-height:0;">&nbsp;</div></td></tr></table></td></tr>`
}

interface SubNavEntry {
  nav: string
  links: Array<{ label: string; anchor: string; count: number }>
}

/** 顶部导览卡：今日速览概述 + 板块格（锚点跳转 + 条数）+ 子栏目录行（07-05 晚：邮件里的"tab 栏"） */
function navCard(
  overview: string[],
  chips: Array<{ meta: SectionMeta; count: number }>,
  subNav: SubNavEntry[] = [],
): string {
  const n = chips.length
  const chipW = n > 0 ? Math.floor((524 - (n - 1) * 12) / n) : 524
  let cells = ""
  chips.forEach((c, i) => {
    cells += `<td width="${chipW}" valign="top" style="width:${chipW}px;padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;background-color:${C.card};border:1px solid ${C.border};border-radius:12px;"><tr><td align="center" style="padding:11px 4px;"><a href="#${c.meta.anchor}" style="text-decoration:none;color:${C.ink};"><div style="font-family:${SERIF};font-size:14px;font-weight:700;color:${C.ink};line-height:1.2;">${escapeHtml(c.meta.nav)}</div><div style="font-family:${SANS};font-size:11px;letter-spacing:1px;color:${C.gold};padding-top:4px;">${c.count} 条</div></a></td></tr></table></td>`
    if (i < n - 1)
      cells += `<td width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>`
  })
  const overviewBlock = overview.length
    ? `<tr><td style="padding:20px 20px 15px 20px;"><div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:3px;color:${C.gold};padding-bottom:10px;">今日速览 · AT A GLANCE</div>${overview.map((o) => `<div style="font-family:${SANS};font-size:14px;line-height:1.85;color:${C.sub};padding:2px 0;"><span style="color:${C.gold};">◆</span>&nbsp;&nbsp;${escapeHtml(o)}</div>`).join("")}</td></tr><tr><td style="padding:0 20px;"><div style="border-top:1px solid ${C.goldLight};font-size:0;line-height:0;">&nbsp;</div></td></tr>`
    : ""
  // 子栏目录：一节一行「板块名　子栏1 n · 子栏2 n」，锚点直达（不支持锚点的客户端退化为静态目录，内容零丢失）
  const subLines = subNav.filter((s) => s.links.length > 0)
  const subBlock = subLines.length
    ? `<tr><td style="padding:12px 20px 16px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">${subLines.map((s) => `<tr><td style="white-space:nowrap;vertical-align:top;padding:2px 10px 2px 0;font-family:${SANS};font-size:12px;font-weight:700;color:${C.ink};">${escapeHtml(s.nav)}</td><td style="padding:2px 0;font-family:${SANS};font-size:12px;line-height:1.9;color:${C.sub};">${s.links.map((l) => `<a href="#${l.anchor}" style="color:${C.gold};text-decoration:none;white-space:nowrap;">${escapeHtml(l.label)}&nbsp;${l.count}</a>`).join("&nbsp;·&nbsp; ")}</td></tr>`).join("")}</table></td></tr>`
    : ""
  return `<tr><td style="padding:0 0 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.heroLight};border:1px solid ${C.border};border-radius:14px;">${overviewBlock}<tr><td style="padding:15px 18px ${subBlock ? "3px" : "17px"} 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;table-layout:fixed;"><tr>${cells}</tr></table></td></tr>${subBlock}</table></td></tr>`
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
 * B 项（小孙 07-04）：信源异常顶置提醒卡 —— 失败/超时源在刊头下方醒目透出（页脚小字不够醒目），
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
          ? `<div style="font-family:${SANS};font-size:12px;line-height:1.7;color:${C.gold};padding:2px 0 0 14px;">↳ 大概率小号 cookie 失效：重新提取 auth_token → 更新 RSSHub 容器变量并重启容器</div>`
          : ""
      return `<div style="font-family:${SANS};font-size:13px;line-height:1.8;color:${C.ink};padding-top:5px;"><span style="font-weight:700;">▲ ${escapeHtml(sourceLabel(f.sourceId))}</span><span style="color:${C.sub};">　${escapeHtml(reason)}</span></div>${hint}`
    })
    .join("")
  return `<tr><td style="padding:0 0 16px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:#fbeee1;border:1px solid ${C.accent};border-radius:14px;"><tr><td style="padding:14px 18px 16px 18px;"><div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:2px;color:${C.accent};">⚠ 信源异常 · SOURCE ALERT</div><div style="font-family:${SANS};font-size:13px;line-height:1.7;color:${C.sub};padding-top:6px;">今日 ${failed.length} 个信源抓取失败，对应板块内容可能缺失或不全：</div>${rows}</td></tr></table></td></tr>`
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

export function renderDigest(input: RenderInput): RenderedDigest {
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
    return renderDigest({
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
    })
  }
  const itemsById = new Map(input.items.map((i) => [i.id, i]))
  for (const g of input.githubItems ?? []) itemsById.set(g.id, g)
  for (const p of input.podcastItems ?? []) itemsById.set(p.id, p)
  // 中文化补全（07-06）：本次渲染实际展示的速览行 id——job 层据此送翻译再二次渲染
  const restItemIds: string[] = []

  const degradedTag = input.summary.degraded ? "（清单版）" : ""
  const subject = `📰 DailyBrief ${input.businessDate}${degradedTag}`
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
      baseMeta.category === "github" ? adaptGithubMeta(baseMeta, input.githubItems ?? []) : baseMeta
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

  const mdParts: string[] = [`# DailyBrief ${input.businessDate}${degradedTag}`, ""]
  if (failed.length > 0) {
    mdParts.push(
      `> ⚠ 信源异常：${failed.map((f) => `${sourceLabel(f.sourceId)}(${f.status})`).join("、")}`,
      "",
    )
  }
  if (input.summary.overview.length > 0) {
    mdParts.push("## 今日速览", ...input.summary.overview.map((o) => `- ${o}`), "")
  }

  const chips = sections.map((s) => ({ meta: s.meta, count: s.resolved.length }))
  // 子栏目录（≥2 组的板块才有"tab 栏"可跳；github 榜单卡自带分组头不进目录）
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

    // GitHub：榜单卡分栏（每种榜一张列表卡；ghPicks 已按 kind 顺序排好）
    if (s.meta.category === "github") {
      const byKind = new Map<string, typeof s.resolved>()
      for (const e of s.resolved) {
        const list = byKind.get(e.item.sourceId) ?? []
        list.push(e)
        byKind.set(e.item.sourceId, list)
      }
      for (const [kind, entries] of byKind) {
        const label = ghKindLabel(kind)
        sectionHtml.push(ghListCard(label, entries))
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
        heroRow(
          renderCardInner(hero.item, hero.pick, 1, s.meta, "hero", hero.alsoLabels),
          s.meta.category,
        ),
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
          wideRow(renderCardInner(wide.item, wide.pick, no, s.meta, "wide", wide.alsoLabels)),
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
            wideRow(renderCardInner(L.item, L.pick, no, s.meta, "wide", L.alsoLabels)),
          )
          pushItemMd(mdParts, L.item, L.pick, L.alsoLabels)
          no++
          continue
        }
        sectionHtml.push(
          twoColRow(
            renderCardInner(L.item, L.pick, no, s.meta, "col", L.alsoLabels),
            renderCardInner(R.item, R.pick, no + 1, s.meta, "col", R.alsoLabels),
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
    const restCap = Math.max(0, Math.min(30, input.restOverviewRows ?? 12))
    const restAll = input.items.filter(
      (i) =>
        i.category === s.meta.category &&
        !usedIds.has(i.id) &&
        !BRIEFING_SOURCE_IDS.has(i.sourceId) &&
        !communityRestBlocked(i),
    )
    const restShown = restCap === 0 ? [] : diversifyBySource(restAll, restCap)
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

  const masthead = `<tr><td style="padding:0 0 16px 0;"><a name="top"></a><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;background-color:${C.ink};border:1px solid ${C.ink};border-radius:14px;"><tr><td style="padding:28px 26px;"><div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:4px;color:${C.goldLight};padding-bottom:10px;">MULTI-AGENT · DAILY BRIEF</div><div style="font-family:${SERIF};font-size:34px;font-weight:700;letter-spacing:2px;color:${C.white};line-height:1.1;">每日简报</div><div style="height:14px;line-height:14px;font-size:0;">&nbsp;</div><div style="border-top:2px solid ${C.accent};width:52px;font-size:0;line-height:0;">&nbsp;</div><div style="height:14px;line-height:14px;font-size:0;">&nbsp;</div><div style="font-family:${SANS};font-size:13px;letter-spacing:1px;color:${C.goldLight};">${escapeHtml(input.businessDate)}${weekday ? `　${escapeHtml(weekday)}` : ""}${input.summary.degraded ? "　· 清单版" : ""}</div><div style="font-family:${SANS};font-size:13px;letter-spacing:1px;color:${C.cream};padding-top:5px;">AI · 社区动态 · 今日热点 · ${DIGEST_GITHUB_SECTION_LABEL}</div><div style="font-family:${SANS};font-size:12px;letter-spacing:1px;color:${C.goldLight};padding-top:8px;">${escapeHtml(checkLine)}</div>${webUrl ? `<div style="font-family:${SANS};font-size:12px;letter-spacing:1px;padding-top:8px;"><a href="${safeHref(webUrl)}" style="color:${C.goldLight};text-decoration:underline;">网页版全量分栏 →</a></div>` : ""}</td></tr></table></td></tr>`

  const footer = `<tr><td style="padding:22px 0 0 0;"><div style="border-top:1px solid ${C.goldLight};font-size:0;line-height:0;">&nbsp;</div></td></tr><tr><td align="center" style="padding:18px 0 6px 0;"><div style="font-family:${SANS};font-size:12px;line-height:1.9;color:${C.sub};">源健康：${escapeHtml(healthLine)}</div>${webUrl ? `<div style="font-family:${SANS};font-size:12px;line-height:1.9;"><a href="${safeHref(webUrl)}" style="color:${C.gold};text-decoration:underline;">网页版全量分栏（可点切换）→</a></div>` : ""}${notes.length ? `<div style="font-family:${SANS};font-size:12px;line-height:1.9;color:${C.sub};">${notes.map(escapeHtml).join("<br>")}</div>` : ""}<div style="font-family:${SANS};font-size:12px;line-height:1.9;color:${C.sub};"><span style="color:${C.gold};">◆</span>&nbsp; DailyBrief · Multi-Agent · F037 每日简报</div></td></tr>`

  const html = [
    "<!doctype html>",
    `<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>每日简报 · DailyBrief</title></head>`,
    `<body style="margin:0;padding:0;background-color:${C.page};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background-color:${C.page};"><tr><td align="center" style="padding:28px 16px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;border-collapse:collapse;background-color:${C.page};"><tr><td style="padding:20px;">`,
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:560px;border-collapse:collapse;">`,
    masthead,
    alertCard(failed),
    navCard(input.summary.overview, chips, subNav),
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
  }
}
