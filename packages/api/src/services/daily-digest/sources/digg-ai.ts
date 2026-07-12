import { buildNormalizedItem } from "../feed-parsers"
import type { DigestSource, NormalizedItem } from "../types"

/**
 * #23 Digg AI 1000（主表 v2.1）：digg.com「what AI Twitter is paying attention to」——
 * 1000 个 AI 圈 X 账号的实时 story 聚类（title/tldr/rank/postCount/互动数），等于不碰
 * 自家小号白嫖 1000 账号的聚合信号（last30days 给其质量先验 0.85，与 Techmeme 同档）。
 *
 * 无公开 RSS/JSON（标准路径全 404，07-05 实测；/api/trending/status 只有管线心跳无内容）→
 * 抓 /tech/ 页提取 Next.js RSC 流内嵌数据（/ai 已 308 并入 /tech/，feed topic 仍 ="ai"）。
 * 脆性声明：RSC 内部格式（self.__next_f.push 分片 + storiesByFilter 结构）随部署演化
 * （05→07 月已见 label→title、gravityScore 移除）——解析 0 story 抛错由 orchestrator
 * 记 failed（B 项提醒卡可见），fixture 锁 07-05 实拍结构。
 */

/** RSC 分片拼接：数据 JSON 常被切在分片边界，必须先全量拼接再找结构（fixture 特意锁跨片用例） */
export function extractRscPayload(html: string): string {
  let payload = ""
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)/g)) {
    try {
      payload += JSON.parse(`"${m[1]}"`)
    } catch {
      // 单分片坏转义丢弃（不常见；整体解析质量由 0-story 抛错兜底）
    }
  }
  return payload
}

/** 平衡括号扫描（字符串/转义感知）：从 start（指向 [ 或 {）截出完整 JSON 值 */
export function scanJsonValue(s: string, start: number): string | null {
  let depth = 0
  let inStr = false
  for (let j = start; j < s.length; j++) {
    const c = s[j]
    if (inStr) {
      if (c === "\\") j++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === "[" || c === "{") depth++
    else if (c === "]" || c === "}") {
      depth--
      if (depth === 0) return s.slice(start, j + 1)
    }
  }
  return null
}

export interface DiggStory {
  title: string
  tldr: string
  clusterUrlId: string
  rank: number
  postCount: number
  createdAt: string | null
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}

export function parseDiggStories(html: string): DiggStory[] {
  const payload = extractRscPayload(html)
  const sbf = payload.indexOf('"storiesByFilter":')
  if (sbf === -1) return []
  const itemsIdx = payload.indexOf('"items":[', sbf)
  if (itemsIdx === -1) return []
  const raw = scanJsonValue(payload, itemsIdx + '"items":'.length)
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  const out: DiggStory[] = []
  for (const e of Array.isArray(arr) ? arr : []) {
    const rec = asRecord(e)
    const title = String(rec.title ?? "")
    const clusterUrlId = String(rec.clusterUrlId ?? "")
    if (!title || !/^[a-z0-9]+$/i.test(clusterUrlId)) continue
    const created = typeof rec.createdAt === "string" ? Date.parse(rec.createdAt) : Number.NaN
    out.push({
      title,
      tldr: String(rec.tldr ?? ""),
      clusterUrlId,
      rank: Number(rec.rank ?? 999),
      postCount: Number(rec.postCount ?? 0),
      createdAt: Number.isNaN(created) ? null : new Date(created).toISOString(),
    })
  }
  return out
}

/** /tech/ 直达（/ai 已 308 并入，留作 fallback 防再改回） */
const DIGG_URLS = ["https://digg.com/tech/", "https://digg.com/ai"]

export interface DiggAiOptions {
  /** 取 rank 前 N 个 story，默认 15 */
  maxStories?: number
}

export function makeDiggAiSource(opts: DiggAiOptions = {}): DigestSource {
  const cap = opts.maxStories ?? 15
  return {
    sourceId: "digg-ai",
    category: "community",
    async fetch(ctx): Promise<NormalizedItem[]> {
      let lastErr: unknown = null
      for (const url of DIGG_URLS) {
        try {
          const html = await ctx.http.fetchText(url)
          const stories = parseDiggStories(html)
          if (stories.length > 0) {
            return stories
              .sort((a, b) => a.rank - b.rank)
              .slice(0, cap)
              .map((s) =>
                buildNormalizedItem(
                  "digg-ai",
                  // 德彪批次 D r1 P1：item 级 category 必须与源声明一致（orchestrator 只认 item 自带值）
                  "community",
                  s.title,
                  // 集群页 = 聚合导航页（07-05 实测 /tech/{id} 200，/ai/{id} 308 过去）
                  `https://digg.com/tech/${s.clusterUrlId}`,
                  s.createdAt,
                  `[#${s.rank} · ${s.postCount} 帖聚合] ${s.tldr}`,
                  s.postCount, // 聚合帖数 = 多账号交叉印证强度
                ),
              )
          }
          lastErr = new Error(`digg-ai: no stories parsed from ${url}（RSC 结构改版？）`)
        } catch (err) {
          lastErr = err
        }
      }
      throw lastErr ?? new Error("digg-ai: all urls exhausted")
    },
  }
}
