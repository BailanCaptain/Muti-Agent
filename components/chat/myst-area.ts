import type { TimelineMessage } from "@multi-agent/shared"

/**
 * F026 P5 F7 · A2A 密谋区淡紫底色（D6 拍板 2026-04-23）
 *
 * 子派发消息（带 parent_call_id）的 outer 容器加 `bg-purple-50/30`，
 * 让用户视觉上立刻分辨「这条是 A2A 密谋区子流，不是主流主线」。
 *
 * 数据来源：T0 LEFT JOIN a2a_calls.parent_call_id → TimelineMessage.a2aParentCallId。
 *   - sub-call → 紫色底色（密谋区）
 *   - root call / 非 a2a → 不上紫色（主流）
 *
 * 视觉布局：紫底加在 outer wrap 上，inner card (rounded-2xl + bubbleTheme) 仍保留
 *   provider 渐变。outer 紫底通过 ml-8 缩进暴露的左侧空白区域 + 卡片间距
 *   形成「紫色密谋区」视觉边界。
 *
 * AC-P5-11 (spec line 387 + D6 决策) — Wave 1 第五个独立原语
 */
export function getMystAreaClassName(message: TimelineMessage): string {
  const isSubCall = !!(message.a2aParentCallId && message.a2aParentCallId.length > 0)
  if (!isSubCall) return ""
  return "bg-purple-50/30"
}
