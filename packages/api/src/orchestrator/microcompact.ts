import type { ContextMessage } from "./context-snapshot"

export type MicrocompactConfig = {
  keepRecent: number
  keepLastFailure: boolean
}

const FAILURE_PATTERN = /error|fail|stderr|exit=[1-9]/i

export function microcompact(
  messages: readonly ContextMessage[],
  config: MicrocompactConfig,
): ContextMessage[] {
  const isToolResult = (m: ContextMessage) => !!m.toolEventsSummary
  const isFailure = (m: ContextMessage) =>
    FAILURE_PATTERN.test(m.content) || FAILURE_PATTERN.test(m.toolEventsSummary ?? "")

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
      content: m.content + "\n" + buildAnchorPlaceholder(m),
    }
  })
}

function buildAnchorPlaceholder(m: ContextMessage): string {
  return `[工具结果已压缩] msgId=${m.id} | tools=${m.toolEventsSummary ?? "unknown"} | at=${m.createdAt}`
}
