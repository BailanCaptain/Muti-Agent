// F018 AC2: ThreadMemory rolling summary — 跨 session 压缩成单行/多行文本，
// 每次 seal 合入新 session 的 extractive digest。参照 clowder-ai buildThreadMemory。
//
// Cap 动态公式：Math.max(1200, Math.min(3000, Math.floor(maxPromptTokens * 0.03)))
//   — 小窗口模型给 1200 token 下限；大窗口模型上调但不超 3000
//   — 超限时从尾部（最旧 session）逐行丢弃；仍超 → 字符级截断 + "..."
//
// 纯函数 — 持久化由调用方（message-service seal 分支）负责。

import type { ExtractiveDigestV1 } from "./transcript-writer"

export type ThreadMemory = {
  summary: string
  sessionCount: number
  lastUpdatedAt: string
}

const CHARS_PER_TOKEN = 4 // 粗估 1 token ≈ 4 chars，与 clowder-ai 同基线

export function appendSession(
  existing: ThreadMemory | null,
  digest: ExtractiveDigestV1,
  maxPromptTokens: number,
): ThreadMemory {
  const nextCount = (existing?.sessionCount ?? 0) + 1
  const line = formatDigestLine(digest, nextCount)
  const maxTokens = Math.max(1200, Math.min(3000, Math.floor(maxPromptTokens * 0.03)))
  const maxChars = maxTokens * CHARS_PER_TOKEN

  const combined = existing?.summary ? `${line}\n${existing.summary}` : line
  const trimmed = truncateFromTail(combined, maxChars)

  return {
    summary: trimmed,
    sessionCount: nextCount,
    lastUpdatedAt: digest.time.sealedAt,
  }
}

function formatDigestLine(digest: ExtractiveDigestV1, n: number): string {
  const start = digest.time.createdAt.slice(11, 16)
  const end = digest.time.sealedAt.slice(11, 16)
  const durMin = Math.round(
    (new Date(digest.time.sealedAt).getTime() - new Date(digest.time.createdAt).getTime()) / 60000,
  )
  const tools = [...new Set(digest.invocations.flatMap((i) => i.toolNames ?? []))].join(", ")
  const files = digest.filesTouched
    .slice(0, 5)
    .map((f) => f.path)
    .join(", ")
  const moreFiles = digest.filesTouched.length > 5 ? ` +${digest.filesTouched.length - 5}` : ""
  const errs = digest.errors.length
  return `Session #${n} (${start}-${end}, ${durMin}min): ${tools}. Files: ${files}${moreFiles}. ${errs} errors.`
}

function truncateFromTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const lines = text.split("\n")
  while (lines.length > 1 && lines.join("\n").length > maxChars) {
    lines.pop()
  }
  let out = lines.join("\n")
  if (out.length > maxChars) {
    // Slice by code points (not UTF-16 code units) to avoid splitting surrogate pairs.
    // Iterate per code point via `Array.from`; shrink until UTF-16 length fits maxChars.
    const codePoints = Array.from(out)
    let take = Math.min(codePoints.length, Math.max(0, maxChars - 3))
    let candidate = `${codePoints.slice(0, take).join("")}...`
    while (candidate.length > maxChars && take > 0) {
      take -= 1
      candidate = `${codePoints.slice(0, take).join("")}...`
    }
    out = candidate
  }
  return out
}
