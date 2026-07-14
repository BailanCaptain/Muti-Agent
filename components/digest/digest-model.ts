import {
  DIGEST_AI_TAG_ORDER,
  DIGEST_COMMUNITY_PLATFORM_TABS,
  DIGEST_COMMUNITY_TAB_FALLBACK,
  DIGEST_COMMUNITY_TAB_ORDER,
  DIGEST_GH_KINDS,
  DIGEST_GITHUB_SECTION_LABEL,
  DIGEST_HOT_TAG_ORDER,
  DIGEST_X_GROUP_ORG,
  DIGEST_X_GROUP_PERSON,
  DIGEST_X_TAB_MORE,
  DIGEST_X_TAB_ORG,
  DIGEST_X_TAB_PERSON,
  normalizeDigestCategory,
} from "@multi-agent/shared"

/**
 * F037 网页版日报数据模型（小孙 07-05 分栏改版 #2）：纯函数层，
 * /api/daily-digest/:date 响应 → 分栏 tabs / picks 解析 / GitHub 榜种分组。
 * 类目顺序真相源 = shared digest-tags（与邮件渲染同源）。
 */

export interface DigestItem {
  id: string
  category: string
  sourceId: string
  title: string
  canonicalUrl: string
  publishedAt: string | null
  rawSnippet: string
  engagement?: number
  topicTag?: string
  githubMeta?: {
    rankStatus?: { kind: "new" } | { kind: "streak"; days: number } | { kind: "returning" }
  }
}

export interface DigestPick {
  itemId: string
  summaryZh: string
  tag?: string
  alsoItemIds?: string[]
}

export interface DeepRead {
  itemId: string
  titleZh: string
  summaryZh: string
}

export interface DigestSummaryDoc {
  schemaVersion?: 2
  businessDate: string
  generatedAt?: string
  degraded: boolean
  summary: {
    overview: string[]
    sections: Array<{ category: string; picks: DigestPick[]; briefItemIds?: string[] }>
    deepReads?: DeepRead[]
    /** 中文化补全（07-06）：github desc / 速览标题翻译 map（缺省回落英文原文） */
    githubDescZh?: Record<string, string>
    restTitleZh?: Record<string, string>
    degraded: boolean
  }
  sourceHealth: Array<{
    sourceId: string
    status: string
    itemCount: number
    durationMs: number
    error: string | null
  }>
  /** podcast（#33，07-10 起）：老归档无此键——读取侧一律 ?? 0 */
  counts: { content: number; github: number; podcast?: number; scanned?: number }
  /** 本期实际渲染的播客集 id（07-11 德彪 r1 P2-1）：网页版按此 join，与邮件同口径 */
  podcastItemIds?: string[]
  githubItemIds?: string[]
  /** B027：新归档的唯一发布清单；schemaVersion=2 时缺失/畸形必须 fail-closed。 */
  publication?: {
    schemaVersion: 2
    businessDate: string
    overview: string[]
    sections: Array<{
      category: string
      entries: Array<{
        itemId: string
        role: "hero" | "card" | "brief" | "list"
        displayTag?: string
        summaryZh?: string
        alsoItemIds?: string[]
      }>
    }>
  }
}

export interface DigestDayResponse {
  businessDate: string
  summary: DigestSummaryDoc | null
  items: DigestItem[]
  labels: Record<string, string>
}

export interface ResolvedPick {
  pick: DigestPick
  item: DigestItem
  deep?: DeepRead
  alsoLabels: string[]
}

export const ALL_TAB = "全部"

export function labelOf(day: DigestDayResponse, sourceId: string): string {
  return day.labels[sourceId] ?? sourceId
}

/** v2 的速览只认最终 publication；缺清单失败关闭。旧归档才回落原 summary。 */
export function overviewOf(day: DigestDayResponse): string[] {
  if (day.summary?.schemaVersion === 2) {
    return day.summary.publication?.schemaVersion === 2 ? day.summary.publication.overview : []
  }
  return day.summary?.summary.overview ?? []
}

/** null = legacy v1（按旧归档合同回落）；Set = v2 严格批准集合，空 Set 也不得回落 raw。 */
function publicationIds(day: DigestDayResponse, category: string): Set<string> | null {
  if (day.summary?.schemaVersion !== 2) return null
  const publication = day.summary.publication
  if (!publication || publication.schemaVersion !== 2) return new Set()
  const ids = new Set<string>()
  for (const section of publication.sections) {
    if (normalizeDigestCategory(section.category) !== category) continue
    for (const entry of section.entries) {
      if (typeof entry.itemId === "string") ids.add(entry.itemId)
    }
  }
  return ids
}

/** picks → item join（缺 item 的 pick 丢弃）+ 深读覆盖信息 + 同报来源名。
 * category 比对走 normalizeDigestCategory：07-06 前的归档 X 板块存的是 "x"。 */
export function resolvePicks(day: DigestDayResponse, category: string): ResolvedPick[] {
  const byId = new Map(day.items.map((i) => [i.id, i]))
  const deepById = new Map((day.summary?.summary.deepReads ?? []).map((d) => [d.itemId, d]))
  const approvedIds = publicationIds(day, category)
  const publicationSection = day.summary?.publication?.sections.find(
    (section) => normalizeDigestCategory(section.category) === category,
  )
  const legacySection = day.summary?.summary.sections.find(
    (section) => normalizeDigestCategory(section.category) === category,
  )
  const picks: DigestPick[] =
    approvedIds === null
      ? (legacySection?.picks ?? [])
      : (publicationSection?.entries ?? [])
          .filter((entry) => entry.role === "hero" || entry.role === "card")
          .map((entry) => ({
            itemId: entry.itemId,
            summaryZh: entry.summaryZh ?? "",
            ...(entry.displayTag ? { tag: entry.displayTag } : {}),
            ...(entry.alsoItemIds?.length ? { alsoItemIds: entry.alsoItemIds } : {}),
          }))
          .filter((pick) => pick.summaryZh.length > 0)
  const out: ResolvedPick[] = []
  for (const pick of picks) {
    if (approvedIds !== null && !approvedIds.has(pick.itemId)) continue
    const item = byId.get(pick.itemId)
    if (!item) continue
    const alsoLabels = [
      ...new Set(
        (pick.alsoItemIds ?? [])
          .map((id) => byId.get(id))
          .filter((i): i is DigestItem => i !== undefined)
          .map((i) => labelOf(day, i.sourceId)),
      ),
    ].filter((l) => l !== labelOf(day, item.sourceId))
    out.push({ pick, item, deep: deepById.get(pick.itemId), alsoLabels })
  }
  return out
}

/** pick 归属的分栏（邮件子栏同一套规则：community 用结构分组，ai/hot 用 LLM tag） */
export function tabOf(category: string, rp: ResolvedPick): string {
  if (category === "community") {
    if (rp.item.sourceId === "x-firsthand") {
      if (rp.item.topicTag === DIGEST_X_GROUP_ORG) return DIGEST_X_TAB_ORG
      if (rp.item.topicTag === DIGEST_X_GROUP_PERSON) return DIGEST_X_TAB_PERSON
      return DIGEST_X_TAB_MORE
    }
    return DIGEST_COMMUNITY_PLATFORM_TABS[rp.item.sourceId] ?? DIGEST_COMMUNITY_TAB_FALLBACK
  }
  return rp.pick.tag ?? "其他"
}

/** 板块 tabs：固定序里实际有货的类目；不足 2 个分组时不出 tabs（切换无意义） */
export function buildTabs(category: string, resolved: ResolvedPick[]): string[] {
  const present = new Set(resolved.map((rp) => tabOf(category, rp)))
  const order: readonly string[] =
    category === "ai"
      ? DIGEST_AI_TAG_ORDER
      : category === "hot"
        ? DIGEST_HOT_TAG_ORDER
        : category === "community"
          ? DIGEST_COMMUNITY_TAB_ORDER
          : []
  const tabs = order.filter((t) => present.has(t))
  return tabs.length >= 2 ? [ALL_TAB, ...tabs] : []
}

export function filterByTab(
  category: string,
  resolved: ResolvedPick[],
  tab: string,
): ResolvedPick[] {
  return tab === ALL_TAB ? resolved : resolved.filter((rp) => tabOf(category, rp) === tab)
}

export interface GhGroup {
  sourceId: string
  label: string
  items: DigestItem[]
}

/** GitHub 榜种分组（全量，不做邮件端限量——网页版就是看全的地方） */
export function githubGroups(day: DigestDayResponse): GhGroup[] {
  const approvedIds = publicationIds(day, "github")
  const gh = day.items.filter(
    (item) => item.category === "github" && (approvedIds === null || approvedIds.has(item.id)),
  )
  const groups: GhGroup[] = []
  for (const kind of DIGEST_GH_KINDS) {
    const items = gh.filter((i) => i.sourceId === kind.sourceId)
    if (items.length > 0) groups.push({ sourceId: kind.sourceId, label: kind.label, items })
  }
  const known = new Set<string>(DIGEST_GH_KINDS.map((k) => k.sourceId))
  const extraIds = [...new Set(gh.filter((i) => !known.has(i.sourceId)).map((i) => i.sourceId))]
  for (const sid of extraIds) {
    groups.push({
      sourceId: sid,
      label: labelOf(day, sid),
      items: gh.filter((i) => i.sourceId === sid),
    })
  }
  return groups
}

/**
 * #33 播客速递（07-10；07-11 德彪 r1 P2-1 修口径）：items.jsonl 是全量底料——含 shown
 * 账本已滤掉的旧集；有 podcastItemIds（新归档）严格按本期渲染清单 join（与邮件同口径），
 * 老归档（无该键）回落全量（当年落盘时邮件网页本就同源，语义不破）。
 */
export function podcastEpisodes(day: DigestDayResponse): DigestItem[] {
  const approvedIds = publicationIds(day, "podcast")
  const legacyIds = day.summary?.podcastItemIds
  return day.items
    .filter(
      (item) =>
        item.category === "podcast" &&
        (approvedIds !== null
          ? approvedIds.has(item.id)
          : legacyIds === undefined || legacyIds.includes(item.id)),
    )
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
}

/** 板块全量条目（tabs 下面的「全部抓取条目」区）：互动量倒序，无互动量按时间倒序垫底 */
export function rawItems(day: DigestDayResponse, category: string): DigestItem[] {
  const approvedIds = publicationIds(day, category)
  return day.items
    .filter(
      (item) =>
        normalizeDigestCategory(item.category) === category &&
        (approvedIds === null || approvedIds.has(item.id)),
    )
    .sort((a, b) => {
      const ea = a.engagement ?? -1
      const eb = b.engagement ?? -1
      if (ea !== eb) return eb - ea
      return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")
    })
}

/** github snippet "+N stars today/this week/this month · ★M · Lang · desc" → 数据行 + 描述 */
export function splitGhSnippet(text: string): { meta: string; desc: string } {
  const parts = text.split(" · ")
  const m = parts[0]?.match(/^\+([\d,]+) stars (this week|this month|today)$/)
  if (m && /^★[\d,]+$/.test(parts[1] ?? "")) {
    const periodZh = m[2] === "this month" ? "本月" : m[2] === "today" ? "今日" : "本周"
    const meta = [`▲ ${m[1]} ${periodZh}`, parts[1]]
    let rest = parts.slice(2)
    if (rest.length > 1 && /^[A-Za-z][A-Za-z0-9+#. -]{0,19}$/.test(rest[0])) {
      meta.push(rest[0])
      rest = rest.slice(1)
    }
    return { meta: meta.join("　"), desc: rest.join(" · ") }
  }
  const newcomer = parts[0]?.match(/^新仓 7 天 (★[\d,]+)$/)
  if (newcomer) return { meta: `新仓 7 天　${newcomer[1]}`, desc: parts.slice(1).join(" · ") }
  return { meta: "", desc: text }
}

/** 沿用既有 GitHub 数据行，只为增长榜/新秀榜追加解释性状态。 */
export function githubMetaLine(item: DigestItem): string {
  const meta = splitGhSnippet(item.rawSnippet).meta
  if (!["github-trending-daily", "github-ai-newcomers"].includes(item.sourceId)) return meta
  const status = item.githubMeta?.rankStatus
  const label =
    status?.kind === "new"
      ? "NEW"
      : status?.kind === "returning"
        ? "重新上榜"
        : status?.kind === "streak"
          ? `连续 ${status.days} 日上榜`
          : ""
  return [meta, label].filter(Boolean).join("　")
}

/**
 * 体检行（德彪 r-final P2-1）：「收录」走 summary.counts（预滤后语料，与邮件同口径）——
 * day.items 是预滤前全量底料（07-10 实测 3271 vs 邮件 450，口径漂移 7 倍）。「精选」=
 * LLM picks；GitHub 榜网页展示全量（邮件有 caps），单列不混进精选。老归档无 counts 时
 * 回落全量数（当年落盘的就是这口径，没有更准的数）。
 */
export function checkLine(day: DigestDayResponse): string {
  const health = day.summary?.sourceHealth ?? []
  const ok = health.filter((h) => h.status === "ok").length
  const picks =
    day.summary?.schemaVersion === 2
      ? (day.summary.publication?.sections.reduce(
          (count, section) =>
            count +
            section.entries.filter((entry) => entry.role === "hero" || entry.role === "card")
              .length,
          0,
        ) ?? 0)
      : (day.summary?.summary.sections.reduce((n, s) => n + s.picks.length, 0) ?? 0)
  const counts = day.summary?.counts
  const podcastCount = counts?.podcast ?? 0
  const included = counts
    ? (counts.scanned ?? counts.content + counts.github + podcastCount)
    : day.items.length
  const gh = counts ? ` · ${DIGEST_GITHUB_SECTION_LABEL} ${counts.github} 条` : ""
  const pc = podcastCount > 0 ? ` · 播客 ${podcastCount} 集` : ""
  return `本期扫描 ${ok}/${health.length} 源 · 收录 ${included} 条 · 精选 ${picks} 条${gh}${pc}`
}

/**
 * 外链护栏（德彪 r-final P2-3；与邮件 safeHref 同口径）：React 只拦 javascript:，
 * data: 等仍会放行——canonicalUrl 上游虽有校验，归档数据可能早于校验版本，这里再守一道。
 */
export function safeExternalHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#"
}
