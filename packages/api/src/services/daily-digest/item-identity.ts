import { createHash } from "node:crypto"

export const SNIPPET_MAX_CHARS = 2000

export function makeItemId(sourceId: string, canonicalUrl: string): string {
  return createHash("sha1").update(`${sourceId}\n${canonicalUrl}`).digest("hex").slice(0, 16)
}

/** URL 归一做跨源去重键：host 小写、去 fragment、去 utm_* 参数、去尾斜杠。无效 URL 回退原串 trim 小写。 */
export function makeDedupeKey(rawUrl: string): string {
  let u: URL
  try {
    u = new URL(rawUrl.trim())
  } catch {
    return rawUrl.trim().toLowerCase()
  }
  u.hash = ""
  const keep = new URLSearchParams()
  for (const [k, v] of u.searchParams) {
    if (!k.toLowerCase().startsWith("utm_")) keep.append(k, v)
  }
  u.search = keep.toString()
  let path = u.pathname
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search ? `?${u.search}` : ""}`
}

/** 压缩空白 + 截断到 SNIPPET_MAX_CHARS */
export function truncateSnippet(text: string): string {
  const squashed = text.replace(/\s+/g, " ").trim()
  return squashed.length > SNIPPET_MAX_CHARS ? squashed.slice(0, SNIPPET_MAX_CHARS) : squashed
}
