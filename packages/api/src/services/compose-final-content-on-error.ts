/**
 * B023 AC1: catch 路径 append 不 overwrite — 保留流式累积内容 + 末尾 append [runtime] 错误信息。
 *
 * 修复前：message-service.ts catch 路径用 `Error: ${message}` 整个覆盖
 *   `assistantContent`，导致前端看到流式累积内容瞬间消失（DB 实测：范德彪
 *   5/8 02:08 final content=97 字仅 Error 文案，但 thinking=1356 字保留）。
 *
 * 修复后：保留 assistantContent，错误信息追加到末尾，前端看到"流式内容 + 系统注释"。
 *
 * 详见 docs/bugReport/B023-runtime-resilience.md AC1。
 */
export function composeFinalContentOnError(args: {
  assistantContent: string
  errorMessage: string
}): string {
  const preserved = args.assistantContent.trim() ? args.assistantContent : ""
  const errorTail = `[runtime] Error: ${args.errorMessage}`
  if (!preserved) {
    return errorTail
  }
  return `${preserved}\n\n---\n${errorTail}`
}
