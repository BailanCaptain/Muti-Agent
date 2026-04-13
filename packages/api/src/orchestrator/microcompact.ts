import type { ContextMessage } from "./context-snapshot"

export type MicrocompactConfig = {
  keepRecent: number
  keepLastFailure: boolean
}

const TOOL_RESULT_PATTERN = /\[tool_result\]/
const FAILURE_PATTERN = /exit=[1-9]|stderr=|Error|FAIL|error:/i
const TOOL_NAME_PATTERN = /\[tool_result\]\s*(\S+)/
const PATH_PATTERN = /path=(\S+)/

export function microcompact(
  messages: readonly ContextMessage[],
  config: MicrocompactConfig,
): ContextMessage[] {
  const isToolResult = (m: ContextMessage) => TOOL_RESULT_PATTERN.test(m.content)
  const isFailure = (m: ContextMessage) => FAILURE_PATTERN.test(m.content)

  const toolIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (isToolResult(messages[i])) {
      toolIndices.push(i)
    }
  }

  const keepSet = new Set<number>()

  const recentToolIndices = toolIndices.slice(-config.keepRecent)
  for (const idx of recentToolIndices) {
    keepSet.add(idx)
  }

  if (config.keepLastFailure) {
    for (let i = toolIndices.length - 1; i >= 0; i--) {
      if (isFailure(messages[toolIndices[i]])) {
        keepSet.add(toolIndices[i])
        break
      }
    }
  }

  return messages.map((m, i) => {
    if (!isToolResult(m) || keepSet.has(i)) {
      return { ...m }
    }
    return {
      ...m,
      content: buildAnchorPlaceholder(m),
    }
  })
}

function buildAnchorPlaceholder(m: ContextMessage): string {
  const toolMatch = TOOL_NAME_PATTERN.exec(m.content)
  const toolName = toolMatch?.[1] ?? "unknown"
  const pathMatch = PATH_PATTERN.exec(m.content)
  const pathStr = pathMatch ? ` | path=${pathMatch[1]}` : ""
  const exitMatch = /exit=(\d+)/.exec(m.content)
  const exitStr = exitMatch ? ` | exit=${exitMatch[1]}` : ""
  return `[工具结果已压缩] msgId=${m.id} | tool=${toolName}${pathStr}${exitStr} | at=${m.createdAt}`
}
