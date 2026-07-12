import type { NormalizedItem, SourceFetchContext } from "../types"
import { forEachPaced, resolvePacing } from "./pacing"

/**
 * #30 HN 评论富化（主表 v2.1 P1，小孙 07-05「后置件往前提」）：
 * 对 hn-ai 榜内互动量前 N 的故事拉 Algolia items/{id}，取顶层高质量评论前 2 条
 * 拼进 rawSnippet —— LLM 摘要能看到社区视角（争议点/实测反馈常在评论里）。
 *
 * 边界：整体与逐故事全部 fail-open（富化失败保持原条目）；大热帖评论树 JSON 可超
 * SafeHttpClient 2MB 上限 → too_large 抛错同样落 fail-open。轻 pacing 防 429。
 */

export interface HnEnrichOptions {
  /** 只富化互动量前 N 的故事（成本有界），默认 5 */
  enrichTop?: number
  /** 每故事取顶层评论条数，默认 2 */
  commentsPerStory?: number
  /** 单条评论截断长度，默认 160 字符 */
  commentLen?: number
  pacing?: { delayMs?: number; jitterMs?: number; maxTotalMs?: number }
}

const PACING_DEFAULTS = { delayMs: 300, jitterMs: 200, maxTotalMs: 30_000 }
/** rawSnippet 合同上限（types.ts：纯文本 ≤2000） */
const SNIPPET_MAX = 2000

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}

/** Algolia comment.text 是 HTML：剥标签 + 解常见实体 + 压空白 */
export function stripCommentHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

/** 从列表响应回读 url→objectID（map 层丢掉了 objectID；外链故事也要能富化） */
export function hnIdByUrl(rawBody: string): Map<string, string> {
  const out = new Map<string, string>()
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return out
  }
  const hits = asRecord(json).hits
  for (const h of Array.isArray(hits) ? hits : []) {
    const rec = asRecord(h)
    const id = String(rec.objectID ?? "")
    if (!id) continue
    if (typeof rec.url === "string" && rec.url) out.set(rec.url, id)
    out.set(`https://news.ycombinator.com/item?id=${id}`, id)
  }
  return out
}

/** items/{id} 响应 → 顶层评论文本前 N（跳空/已删） */
export function topCommentTexts(itemJson: unknown, n: number, maxLen: number): string[] {
  const children = asRecord(itemJson).children
  const out: string[] = []
  for (const c of Array.isArray(children) ? children : []) {
    const rec = asRecord(c)
    if (typeof rec.text !== "string" || !rec.text) continue
    const text = stripCommentHtml(rec.text)
    if (text.length < 20) continue // 太短的没信息量（"+1"/"Thanks"）
    out.push(text.slice(0, maxLen))
    if (out.length >= n) break
  }
  return out
}

export async function enrichHnComments(
  items: NormalizedItem[],
  rawBody: string,
  ctx: SourceFetchContext,
  opts: HnEnrichOptions = {},
): Promise<NormalizedItem[]> {
  try {
    const enrichTop = opts.enrichTop ?? 5
    const perStory = opts.commentsPerStory ?? 2
    const maxLen = opts.commentLen ?? 160
    const idByUrl = hnIdByUrl(rawBody)
    if (idByUrl.size === 0) return items

    // 互动量前 N（engagement = points；无值垫底）
    const targets = [...items]
      .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))
      .slice(0, enrichTop)
      .map((it) => ({ it, id: idByUrl.get(it.canonicalUrl) }))
      .filter((t): t is { it: NormalizedItem; id: string } => Boolean(t.id))
    if (targets.length === 0) return items

    const extra = new Map<string, string>()
    const pacing = resolvePacing(opts.pacing, PACING_DEFAULTS)
    await forEachPaced(targets, pacing, ctx.signal, async (t) => {
      try {
        const body = await ctx.http.fetchText(`https://hn.algolia.com/api/v1/items/${t.id}`)
        const comments = topCommentTexts(JSON.parse(body), perStory, maxLen)
        if (comments.length > 0) {
          extra.set(t.it.id, `｜热评：${comments.map((c) => `「${c}」`).join(" ")}`)
        }
      } catch {
        // 逐故事隔离：单帖失败/超大评论树跳过，不影响其余富化
      }
    })
    if (extra.size === 0) return items
    return items.map((it) => {
      const add = extra.get(it.id)
      if (!add) return it
      return { ...it, rawSnippet: `${it.rawSnippet} ${add}`.slice(0, SNIPPET_MAX) }
    })
  } catch {
    return items // 整体 fail-open：富化绝不打挂 hn-ai 主链
  }
}
