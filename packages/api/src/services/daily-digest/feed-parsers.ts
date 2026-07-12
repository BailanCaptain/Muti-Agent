import { XMLParser } from "fast-xml-parser"
import { makeDedupeKey, makeItemId, truncateSnippet } from "./item-identity"
import type { DigestCategory, NormalizedItem } from "./types"

/** 去标签 + 解常用实体 + 压空白（邮件 snippet 用，非安全 sanitize——渲染层另做 escape） */
export function stripHtml(html: string): string {
  const noTags = html.replace(/<[^>]*>/g, " ")
  const decoded = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, "&")
  return decoded.replace(/\s+/g, " ").trim()
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function text(v: unknown): string {
  if (v === undefined || v === null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  const obj = v as Record<string, unknown>
  if (typeof obj["#text"] === "string" || typeof obj["#text"] === "number")
    return String(obj["#text"])
  if (typeof obj.__cdata === "string") return String(obj.__cdata)
  return ""
}

function isoOrNull(raw: string): string | null {
  if (!raw) return null
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

/** Atom link：string / {@_href} / 数组（取 rel=alternate 优先） */
function atomLink(link: unknown): string {
  const links = toArray(link as Record<string, unknown> | Array<Record<string, unknown>>)
  if (links.length === 0) return ""
  const pick =
    links.find(
      (l) =>
        typeof l === "object" &&
        l !== null &&
        (l as Record<string, unknown>)["@_rel"] === "alternate",
    ) ?? links[0]
  if (typeof pick === "string") return pick
  const href = (pick as Record<string, unknown>)["@_href"]
  return typeof href === "string" ? href : ""
}

/**
 * RSS 2.0 / Atom 容错解析 → NormalizedItem[]。
 * 解析失败/无条目返回 []（fetcher 合同：不抛业务错误）。
 */
export function parseRssOrAtom(
  xml: string,
  sourceId: string,
  category: DigestCategory,
): NormalizedItem[] {
  let doc: Record<string, unknown>
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      cdataPropName: "__cdata",
    })
    doc = parser.parse(xml)
  } catch {
    return []
  }

  const out: NormalizedItem[] = []

  const rss = doc.rss as Record<string, unknown> | undefined
  const channel = rss?.channel as Record<string, unknown> | undefined
  const feed = doc.feed as Record<string, unknown> | undefined

  if (channel) {
    for (const item of toArray(
      channel.item as Record<string, unknown> | Array<Record<string, unknown>>,
    )) {
      const rec = item as Record<string, unknown>
      const link = text(rec.link) || text(rec.guid)
      const title = stripHtml(text(rec.title))
      if (!link || !title) continue
      const body = text(rec["content:encoded"]) || text(rec.description)
      out.push(
        buildNormalizedItem(sourceId, category, title, link, isoOrNull(text(rec.pubDate)), body),
      )
    }
  } else if (feed) {
    for (const entry of toArray(
      feed.entry as Record<string, unknown> | Array<Record<string, unknown>>,
    )) {
      const rec = entry as Record<string, unknown>
      const link = atomLink(rec.link) || text(rec.id)
      const title = stripHtml(text(rec.title))
      if (!link || !title) continue
      const body = text(rec.summary) || text(rec.content)
      out.push(
        buildNormalizedItem(
          sourceId,
          category,
          title,
          link,
          isoOrNull(text(rec.updated) || text(rec.published)),
          body,
        ),
      )
    }
  }

  return out
}

export function buildNormalizedItem(
  sourceId: string,
  category: DigestCategory,
  title: string,
  link: string,
  publishedAt: string | null,
  rawBody: string,
  engagement?: number,
): NormalizedItem {
  const canonicalUrl = link.trim()
  return {
    id: makeItemId(sourceId, canonicalUrl),
    dedupeKey: makeDedupeKey(canonicalUrl),
    category,
    sourceId,
    title,
    canonicalUrl,
    publishedAt,
    rawSnippet: truncateSnippet(stripHtml(rawBody)),
    // 质量层 1：有限数值才落字段（NaN/负值/0 视为无信号）
    ...(engagement !== undefined && Number.isFinite(engagement) && engagement > 0
      ? { engagement }
      : {}),
  }
}
