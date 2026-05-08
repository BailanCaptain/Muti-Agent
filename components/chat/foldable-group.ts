import type { TimelineMessage } from "@multi-agent/shared"

/**
 * F026 P5 F4 · 折叠群组样式
 *
 * 带 `parent_call_id` 的 a2a 子派发消息默认半透明缩进 32px，hover 时恢复不透明。
 * 让用户视觉上立刻分辨「主流主线 vs A2A 密谋区子流」，又能 hover 偷看细节。
 *
 * 数据来源：T0 LEFT JOIN a2a_calls.parent_call_id → TimelineMessage.a2aParentCallId。
 *   - root call（顶层派发）/ 非 a2a message → parent 为 null/undefined → 不缩进
 *   - sub-call（嵌套派发）→ parent 非空 → opacity-60 ml-8 hover:opacity-100
 *
 * AC-P5-8 (spec line 384) — Wave 1 第三个独立原语
 */
export function getFoldableGroupClassName(message: TimelineMessage): string {
  const isSubCall = !!(message.a2aParentCallId && message.a2aParentCallId.length > 0)
  const base = "mb-4"
  if (!isSubCall) return base
  return `${base} ml-8 opacity-60 transition-opacity hover:opacity-100`
}
