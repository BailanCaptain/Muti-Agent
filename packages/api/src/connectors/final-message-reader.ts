import { PROVIDER_ALIASES, type Provider } from "@multi-agent/shared"
import type { SqliteStore } from "../db/sqlite"
import { uploadBasename } from "../lib/upload-path"
import type { FinalMessage } from "./channel-types"

/**
 * F040 出站终稿读取（assistantMessageId → 正文 + 署名花名）。
 *
 * 从 server.ts 内联 SQL 抽出（r4 P3）：provider→花名映射是出站署名的正确性
 * 关键面，独立成函数配真表测试（claude/codex/gemini/无线程四路），防止
 * JOIN 写错把德彪的话署成仁勋——gateway 测试的 fake 署名是定值，测不到这层。
 */
export function readFinalMessageFromDb(store: SqliteStore, messageId: string): FinalMessage | null {
  const row = store.db
    .prepare(
      // rowid = 同毫秒 tie-breaker（AC13.5）：与房间列表 (created_at, rowid) 同序键；
      // model = F021 逐消息快照（AC-N4 卡片署名带真实型号）；
      // content_blocks = P3 AC16 出站媒体（agent 截图/产物回飞书）
      "SELECT m.content, m.created_at, m.rowid AS order_seq, m.model, m.content_blocks, t.provider FROM messages m LEFT JOIN threads t ON m.thread_id = t.id WHERE m.id = ?",
    )
    .get(messageId) as
    | {
        content?: string
        created_at?: string
        order_seq?: number
        model?: string | null
        content_blocks?: string | null
        provider?: string
      }
    | undefined
  if (row?.content === undefined) return null
  const alias = row.provider ? (PROVIDER_ALIASES[row.provider as Provider] ?? row.provider) : null
  const mediaBlocks = parseMediaBlocks(row.content_blocks)
  return {
    content: row.content,
    senderAlias: alias,
    createdAt: row.created_at ?? null,
    orderSeq: typeof row.order_seq === "number" ? row.order_seq : null,
    model: typeof row.model === "string" && row.model.length > 0 ? row.model : null,
    // 无媒体不放 key（老测试整体 deepEqual + optional 字段语义：没有就没有）
    ...(mediaBlocks ? { mediaBlocks } : {}),
  }
}

/**
 * 出站媒体 URL 白名单（德彪 P3-r1 P2 + T7 真机修 + r7 修10）：路径必须是 /uploads/
 * 单层文件，闸走 lib/upload-path 共享核（与 readUploadFile / resolveAttachmentPath
 * 同源，显式拒 "."/".."——裸正则放行后 basename+resolve 会逃出容器）。防穿越/防
 * 「名字说是外部 report.pdf 实际发本地同名文件」的 confused-deputy。
 *
 * T7 真机抓的 gap：take_screenshot / web 上传落库的块是**绝对 URL**
 * （resolveUploadUrl 前缀 NEXT_PUBLIC_API_*，web 跨端口加载图片的刚需改不了源头）——
 * 只收相对形态会把 Tailscale/局域网环境下的全部出站媒体静默拒掉。故绝对 http(s)
 * URL 解析后 pathname 过同一把闸即收，并**归一化回相对路径**（下游 basename 语义
 * 不变）。host 不授予新能力：字节恒来自本地 uploadsDir，相对形态本就能按 basename
 * 指名任意本地上传文件；WHATWG URL 解析把 /../ 归一、反斜杠转正斜杠，穿越进不了单层闸。
 */
function extractUploadPath(raw: string): string | null {
  const direct = uploadBasename(raw)
  if (direct) return `/uploads/${direct}`
  if (/^https?:\/\//i.test(raw)) {
    try {
      const name = uploadBasename(new URL(raw).pathname)
      if (name) return `/uploads/${name}`
    } catch {}
  }
  return null
}

/** content_blocks JSON → 出站媒体（image/file 之外的块忽略；/uploads 单层闸外拒；破损按无媒体降级） */
function parseMediaBlocks(
  raw: string | null | undefined,
): Array<{ kind: "image" | "file"; url: string; name: string }> | undefined {
  if (!raw) return undefined
  try {
    const blocks = JSON.parse(raw) as Array<Record<string, unknown>>
    if (!Array.isArray(blocks)) return undefined
    const media: Array<{ kind: "image" | "file"; url: string; name: string }> = []
    for (const b of blocks) {
      const path = typeof b?.url === "string" ? extractUploadPath(b.url) : null
      if (!path) continue
      if (b.type === "image") {
        media.push({
          kind: "image",
          url: path,
          name: typeof b.alt === "string" && b.alt ? b.alt : "图片",
        })
      } else if (b.type === "file") {
        media.push({
          kind: "file",
          url: path,
          name: typeof b.name === "string" && b.name ? b.name : "文件",
        })
      }
    }
    return media.length > 0 ? media : undefined
  } catch {
    return undefined
  }
}
