/**
 * F026 P5 F10 · /debug/a2a 视图前端类型
 *
 * 与 packages/api/src/orchestrator/call-registry.ts 的 CallRow 同形（API 直接 JSON 返回 CallRow[]）。
 * 单独在 web 侧定义避免前端直接 import api 包内部模块；shared 包暂未抽这层（命中场景仅
 * 调试视图），等需要其他前端消费时再上提到 @multi-agent/shared。
 */

export type DebugA2ACallStatus =
  | "pending"
  | "working"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled"

export type DebugA2ACallRow = {
  callId: string
  parentCallId: string | null
  rootCallId: string
  issuerId: string
  convenerId: string
  onBehalfOf: string | null
  replyTo: string
  deadlineAt: string
  joinSetId: string | null
  status: DebugA2ACallStatus
  envelopeVersion: string
  sessionGroupId: string
  createdAt: string
  updatedAt: string
}

export type DebugA2ASessionTree = {
  rootCallId: string
  calls: DebugA2ACallRow[]
}

export type DebugA2AStatusResponse = {
  kind: "status"
  status: DebugA2ACallStatus
  calls: DebugA2ACallRow[]
}

export type DebugA2ASessionTreesResponse = {
  kind: "session_trees"
  sessionGroupId: string
  trees: DebugA2ASessionTree[]
}

export type DebugA2AErrorResponse = { error: string }

export type DebugA2AResponse =
  | DebugA2AStatusResponse
  | DebugA2ASessionTreesResponse
  | DebugA2AErrorResponse

export const STATUS_TONE: Record<
  DebugA2ACallStatus,
  { dot: string; text: string; label: string }
> = {
  pending: { dot: "bg-slate-400", text: "text-slate-700", label: "待发" },
  working: { dot: "bg-sky-500", text: "text-sky-700", label: "进行" },
  done: { dot: "bg-emerald-500", text: "text-emerald-700", label: "完成" },
  failed: { dot: "bg-rose-500", text: "text-rose-700", label: "失败" },
  timeout: { dot: "bg-orange-500", text: "text-orange-700", label: "超时" },
  cancelled: { dot: "bg-slate-400", text: "text-slate-500", label: "取消" },
}
