import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import type { SafeHttpClient } from "../../net/safe-http-client"

/**
 * F040 P3 AC16：飞书入站媒体下载（GET /im/v1/messages/:id/resources/:key?type=image|file，
 * 终态 schema 1.7，真机 T7 校准）→ 落盘 mediaDir（= server uploadsDir，/uploads 静态服务）。
 * 落盘名恒 `feishu-<uuid>.<白名单 ext>`——原始文件名绝不进文件系统（路径穿越面），
 * 只进 ContentBlock.name 展示。大小闸 20MB（SafeHttp maxBytes，超限 too_large 拒）。
 */

const MEDIA_MAX_BYTES = 20 * 1024 * 1024

/** 落盘扩展名白名单：命中用原 ext（浏览器/静态服务按扩展名给 MIME），未命中按 kind 兜底 */
const EXT_ALLOWLIST = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic",
  "pdf", "txt", "md", "csv", "json", "log",
  "zip", "7z", "tar", "gz",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "wav", "mp4", "mov",
])

export type FeishuMediaDeps = {
  http: SafeHttpClient
  getToken: () => Promise<string>
  /** 落盘目录（server config uploadsDir；/uploads 前缀静态服务同一目录） */
  mediaDir: string
}

export type DownloadMediaInput = {
  messageId: string
  kind: "image" | "file"
  key: string
  /** 原始文件名（仅取 ext 白名单判定；不进落盘名） */
  name: string
}

export async function downloadFeishuMedia(
  deps: FeishuMediaDeps,
  input: DownloadMediaInput,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const token = await deps.getToken()
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(
      input.messageId,
    )}/resources/${encodeURIComponent(input.key)}?type=${input.kind}`
    const res = await deps.http.request(url, {
      headers: { authorization: `Bearer ${token}` },
      responseAs: "buffer",
      maxBytes: MEDIA_MAX_BYTES,
    })
    if (res.status !== 200 || !res.bytes || res.bytes.byteLength === 0) {
      return { ok: false, error: `download http ${res.status}` }
    }
    const extRaw = path.extname(input.name).slice(1).toLowerCase()
    const ext = EXT_ALLOWLIST.has(extRaw) ? extRaw : input.kind === "image" ? "png" : "bin"
    const filename = `feishu-${crypto.randomUUID()}.${ext}`
    fs.mkdirSync(deps.mediaDir, { recursive: true })
    fs.writeFileSync(path.join(deps.mediaDir, filename), res.bytes)
    return { ok: true, url: `/uploads/${filename}` }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}
