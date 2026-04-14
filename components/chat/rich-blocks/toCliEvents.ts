import type { ToolEvent } from "@multi-agent/shared"

export type CliEventKind = "tool_use" | "tool_result"
export type CliStatus = "streaming" | "done" | "failed"

export interface PairedTool {
  id: string
  toolName: string
  label: string
  toolInput?: string
  resultContent?: string
  status: "active" | "completed" | "error"
  timestamp: string
}

const ARG_KEYS = ["file_path", "command", "pattern", "url", "query", "prompt"] as const

function extractPrimaryArg(toolInput?: string): string | undefined {
  if (!toolInput) return undefined
  try {
    const obj = JSON.parse(toolInput) as Record<string, unknown>
    for (const key of ARG_KEYS) {
      const val = obj[key]
      if (typeof val === "string" && val.length > 0) {
        return val.length > 60 ? `${val.slice(0, 57)}...` : val
      }
    }
    for (const val of Object.values(obj)) {
      if (typeof val === "string" && val.length > 0 && val.length <= 80) {
        return val.length > 60 ? `${val.slice(0, 57)}...` : val
      }
    }
  } catch {
    // toolInput is already pre-formatted by the runtime (not JSON)
    return toolInput.length > 60 ? `${toolInput.slice(0, 57)}...` : toolInput
  }
  return undefined
}

export function pairToolEvents(toolEvents: ToolEvent[]): PairedTool[] {
  const paired: PairedTool[] = []
  const pendingUses: Map<string, number> = new Map()

  for (const event of toolEvents) {
    if (event.type === "tool_use") {
      const primaryArg = extractPrimaryArg(event.toolInput)
      const label = primaryArg ? `${event.toolName} ${primaryArg}` : event.toolName
      const idx = paired.length
      paired.push({
        id: `tool-${idx}`,
        toolName: event.toolName,
        label,
        toolInput: event.toolInput,
        status: "active",
        timestamp: event.timestamp,
      })
      const key = event.toolName
      const existingCount = pendingUses.get(key) ?? 0
      pendingUses.set(`${key}:${existingCount}`, idx)
      pendingUses.set(key, existingCount + 1)
    } else if (event.type === "tool_result") {
      // Match with the last unresolved tool_use (LIFO by index)
      let matchIdx = -1
      for (let i = paired.length - 1; i >= 0; i--) {
        if (paired[i].status === "active") {
          matchIdx = i
          break
        }
      }
      if (matchIdx >= 0) {
        paired[matchIdx].status = event.status === "error" ? "error" : "completed"
        paired[matchIdx].resultContent = event.content
      } else {
        paired.push({
          id: `result-${paired.length}`,
          toolName: event.toolName || "Result",
          label: event.toolName || "Result",
          resultContent: event.content,
          status: event.status === "error" ? "error" : "completed",
          timestamp: event.timestamp,
        })
      }
    }
  }

  return paired
}

export function deriveCliStatus(toolEvents: ToolEvent[]): CliStatus {
  if (toolEvents.length === 0) return "done"
  const hasActive = toolEvents.some(
    (e) => e.type === "tool_use" && e.status === "started",
  )
  if (hasActive) {
    const lastResult = [...toolEvents].reverse().find((e) => e.type === "tool_result")
    if (!lastResult) return "streaming"
    const lastUse = [...toolEvents].reverse().find((e) => e.type === "tool_use")
    if (lastUse && toolEvents.indexOf(lastUse) > toolEvents.indexOf(lastResult)) {
      return "streaming"
    }
  }
  const hasError = toolEvents.some((e) => e.status === "error")
  return hasError ? "failed" : "done"
}
