import { buildNormalizedItem } from "../feed-parsers"
import type { DigestCategory, DigestSource, NormalizedItem } from "../types"
import { type PacingOptions, forEachPaced, resolvePacing } from "./pacing"

/**
 * #31 小红书源（主表 v2.1 P2 → 小孙 07-05「后置件往前提 特别是小红书」）。
 * 路线 = xiaohongshu-mcp 常驻 sidecar（xpzouying/xiaohongshu-mcp，MCP Streamable HTTP
 * `:18060/mcp`，自带无头浏览器 + **小号扫码**登录；cookie 只活在 sidecar，永不经过本进程）。
 * sidecar 地址走 .env 信任锚（MULTI_AGENT_DIGEST_XHS_MCP_BASE，同 RSSHub 姿势，Iron Law §4 合规）。
 *
 * **未活测**（同 twitterapi-io 先例，07-05 README 钉过工具面）：上游只文档化了工具名/参数
 * （search_feeds{keyword} / list_feeds / get_feed_detail{feed_id,xsec_token}，feed 带
 * feed_id+xsec_token），响应内层 schema 无文档 → 解析走多形状防御提取；任何失败以明确
 * 报错浮出（orchestrator 记 failed + 邮件顶置异常卡），绝不静默空转。激活日两颗可能要拧的螺丝：
 * 1. MCP streamable 若非 stateless（要求 initialize 握手 / Mcp-Session-Id 头），tools/call
 *    首击会被拒 → 报错含 session/initialize 字样时补真实握手；
 * 2. 内层 feed 字段名按真响应校正并锁 fixture（digg/reddit 同款纪律）。
 *
 * xsec_token 机制（主表 §0 #31）：笔记链接必须带 token 才打得开 → canonicalUrl 直接从
 * 搜索结果拼 explore URL + xsec_token。频控 2.5s±1s/关键词（上游 README 纪律 2-3s/次）。
 */

const XHS_PACING_DEFAULTS = { delayMs: 2500, jitterMs: 1000, maxTotalMs: 120_000 }

export interface XhsNote {
  feedId: string
  xsecToken: string
  title: string
  likes?: number
}

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>
}

/** 中文计数（"1.2万"/"3456"/数字）→ number；解析不出/非正数返回 undefined */
export function parseCnCount(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined
  if (typeof v !== "string") return undefined
  const m = v.trim().match(/^([\d.]+)\s*(万|w|W|k|K)?$/)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n)) return undefined
  const unit = m[2] ?? ""
  const mult =
    unit === "万" || unit.toLowerCase() === "w" ? 10_000 : unit.toLowerCase() === "k" ? 1000 : 1
  const out = Math.round(n * mult)
  return out > 0 ? out : undefined
}

/**
 * MCP 响应信封 → 工具载荷。兼容三种形态：
 * 纯 JSON-RPC（result.content[{type:"text",text:<json>}]）、structuredContent 直出、
 * SSE 帧（streamable HTTP 可能以 text/event-stream 回单次调用——拼接 data: 行再解析）。
 * error 信封抛明确错误（含 session/initialize 提示时是握手问题，见文件头）。
 */
export function extractMcpPayload(body: string): unknown {
  let text = body.trim()
  if (text.startsWith("event:") || text.startsWith("data:") || text.includes("\ndata:")) {
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
    text = dataLines.join("")
  }
  let env: Record<string, unknown>
  try {
    env = asRecord(JSON.parse(text))
  } catch {
    throw new Error(`xiaohongshu: MCP 响应不是 JSON（前 120 字符：${text.slice(0, 120)}）`)
  }
  if (env.error !== undefined && env.error !== null) {
    throw new Error(`xiaohongshu: MCP error — ${JSON.stringify(env.error).slice(0, 200)}`)
  }
  const result = asRecord(env.result ?? env)
  if (result.structuredContent !== undefined) return result.structuredContent
  const content = Array.isArray(result.content) ? result.content : []
  const textPart = content
    .map(asRecord)
    .find((c) => c.type === "text" && typeof c.text === "string")
  if (textPart) {
    try {
      return JSON.parse(textPart.text as string)
    } catch {
      return textPart.text
    }
  }
  return result
}

/** 载荷里找 feeds 数组（多形状：本身是数组 / .feeds / .data.feeds / .data.items / .items / .notes） */
function findFeedArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const rec = asRecord(payload)
  for (const key of ["feeds", "items", "notes"]) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[]
  }
  const data = asRecord(rec.data)
  for (const key of ["feeds", "items", "notes"]) {
    if (Array.isArray(data[key])) return data[key] as unknown[]
  }
  return []
}

/** 防御提取（未活测：字段名候选按 README 提到的 feed_id/xsec_token + xhs web 端惯例枚举） */
export function parseXhsNotes(payload: unknown): XhsNote[] {
  const out: XhsNote[] = []
  for (const raw of findFeedArray(payload)) {
    const rec = asRecord(raw)
    const noteCard = asRecord(rec.note_card ?? rec.noteCard)
    const interact = asRecord(noteCard.interact_info ?? rec.interact_info ?? rec.interactInfo)
    const feedId = [rec.feed_id, rec.feedId, rec.id, rec.note_id, rec.noteId].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    )
    const xsecToken =
      [rec.xsec_token, rec.xsecToken, noteCard.xsec_token].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      ) ?? ""
    const title = [rec.title, rec.display_title, noteCard.display_title, noteCard.title]
      .find((v): v is string => typeof v === "string" && v.trim().length > 0)
      ?.trim()
    if (!feedId || !title) continue
    const likes = parseCnCount(
      rec.liked_count ?? rec.likes ?? interact.liked_count ?? interact.likedCount,
    )
    out.push({ feedId, xsecToken, title, ...(likes !== undefined ? { likes } : {}) })
  }
  return out
}

export interface XiaohongshuOptions {
  /** sidecar 基址（MULTI_AGENT_DIGEST_XHS_MCP_BASE，如 http://localhost:18060），.env 信任锚 */
  mcpBase: string
  /** 搜索关键词清单（MULTI_AGENT_DIGEST_XHS_KEYWORDS 逗号分隔，小孙人工件） */
  keywords: string[]
  /** 每关键词取前 N 条，默认 8 */
  perKeyword?: number
  /** 板块归属，默认 community（07-06 社区改版：小红书是社区动态的一员） */
  category?: DigestCategory
  pacing?: PacingOptions
}

export function makeXiaohongshuSource(opts: XiaohongshuOptions): DigestSource {
  const base = opts.mcpBase.replace(/\/$/, "")
  const perKeyword = opts.perKeyword ?? 8
  const category = opts.category ?? "community"
  const pacing = resolvePacing(opts.pacing, XHS_PACING_DEFAULTS)
  return {
    sourceId: "xiaohongshu",
    category,
    timeoutBudgetMs: (pacing.maxTotalMs ?? XHS_PACING_DEFAULTS.maxTotalMs) + 60_000,
    async fetch(ctx): Promise<NormalizedItem[]> {
      if (opts.keywords.length === 0) throw new Error("xiaohongshu: no keywords configured")
      const out: NormalizedItem[] = []
      const seen = new Set<string>()
      let firstError: string | null = null
      await forEachPaced(opts.keywords, pacing, ctx.signal, async (keyword) => {
        try {
          const body = await ctx.http.fetchText(`${base}/mcp`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "search_feeds", arguments: { keyword } },
            }),
          })
          for (const note of parseXhsNotes(extractMcpPayload(body)).slice(0, perKeyword)) {
            if (seen.has(note.feedId)) continue // 关键词间同帖去重
            seen.add(note.feedId)
            // xsec_token 直接进链接（无 token 的链接打不开——上游机制）
            const url = `https://www.xiaohongshu.com/explore/${encodeURIComponent(note.feedId)}${
              note.xsecToken
                ? `?xsec_token=${encodeURIComponent(note.xsecToken)}&xsec_source=pc_search`
                : ""
            }`
            out.push(
              buildNormalizedItem(
                "xiaohongshu",
                category,
                note.title,
                url,
                null, // 搜索结果无可靠时间戳；保守保留
                `[${keyword}]${note.likes !== undefined ? ` ▲${note.likes} 赞` : ""} ${note.title}`,
                note.likes,
              ),
            )
          }
        } catch (err) {
          // 单关键词失败跳过（per-keyword 隔离）；全灭时把首个错因抛出去可观测
          if (firstError === null) firstError = String(err).slice(0, 200)
        }
      })
      if (out.length === 0) {
        throw new Error(
          `xiaohongshu: 0 notes fetched（sidecar 未起/未扫码/MCP 握手或字段变更？）${firstError ? ` — ${firstError}` : ""}`,
        )
      }
      return out
    },
  }
}
