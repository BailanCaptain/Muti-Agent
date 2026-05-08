import { getA2APayloadMaxTokens } from "./a2a-feature-flags"
import { extractTaskSnippet, truncateHeadTail } from "./context-snapshot"

const CHARS_PER_TOKEN = 4

export type BuildReturnPathPayloadOptions = {
  maxTokens: number
  dbMsgId?: string
}

export type BuildReturnPathPayloadResult = {
  text: string
  truncated: boolean
  omittedChars: number
}

export function buildReturnPathPayload(
  content: string,
  opts: BuildReturnPathPayloadOptions,
): BuildReturnPathPayloadResult {
  const maxChars = opts.maxTokens * CHARS_PER_TOKEN
  if (content.length <= maxChars) {
    return { text: content, truncated: false, omittedChars: 0 }
  }
  const headLen = Math.floor(maxChars * 0.6)
  const tailLen = Math.floor(maxChars * 0.3)
  const omittedChars = content.length - headLen - tailLen
  const truncated = truncateHeadTail(content, maxChars)
  const text = opts.dbMsgId
    ? truncated.replace(/(\(省略 \d+ 字\))/, `$1 [msg_id=${opts.dbMsgId}]`)
    : truncated
  return { text, truncated: true, omittedChars }
}

/**
 * Forward-dispatch extractSnippet：用 extractTaskSnippet（含 @alias 那句话 / ≤500 字）。
 * 适用于 user @ 短指令、SOP 合成消息等"任务一句话"语义场景。
 */
export function buildForwardExtractSnippet(): (content: string, alias: string) => string {
  return (content, alias) => extractTaskSnippet(content, alias)
}

/**
 * Return-path extractSnippet：用 buildReturnPathPayload（默认 16k token cap，超 cap 头尾保留 + msg_id 引用）。
 * 适用于 agent 完整输出回流场景（如 4195 字 review、CLI 流出 accumulatedContent）。
 * dbMsgId 注入闭包 → 截断时附 [msg_id=...] 引用，下游可调 MCP get_room_context 查原文。
 */
export function buildReturnPathExtractSnippet(
  dbMsgId: string,
): (content: string, alias: string) => string {
  return (content, _alias) =>
    buildReturnPathPayload(content, {
      maxTokens: getA2APayloadMaxTokens(),
      dbMsgId,
    }).text
}
