export type ToolEventStatus = "started" | "completed" | "error"

export type ToolEvent = {
  type: "tool_use" | "tool_result"
  toolName: string
  toolInput?: string
  content?: string
  status: ToolEventStatus
  timestamp: string
  source?: "tool" | "mcp"
}
