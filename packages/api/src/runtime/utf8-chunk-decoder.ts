/**
 * F026 P0 Day3 · R-185 chunk 边界 UTF-8 解码。
 *
 * 把一串 byte chunk（可能在 multi-byte codepoint 中间切开）正确重组回原字符串。
 * 使用 TextDecoder({stream:true}) 持续喂 chunk，最后一块关 stream。
 *
 * 关键约束：现有 codex-runtime.ts 的 stdout 读取走 readline，底层 Node
 * StringDecoder 已是 utf-8-boundary-safe；所以 R-185 乱码的真因不在 readline
 * 单行内，而在 codex-runtime 的**双路事件拼接**（delta + completed.agent_message）。
 * 本函数是 P1+ 替换拼接逻辑时的基础原语，当前 P0 仅把函数 + harness 建好，
 * 由 R-185 fuzz 证明"真的有人会用到时能 decode 正确"。
 */
export function decodeChunkedUtf8(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder("utf-8", { fatal: false })
  let out = ""
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    out += decoder.decode(chunks[i], { stream: !isLast })
  }
  return out
}
