import type { TimelineMessage } from "@multi-agent/shared"

/**
 * F026 P5 F5 · 并列卡片 Visual Silo
 *
 * `display_mode='nested'` 的 sibling messages 视觉上独立成"卡片框"，
 * 与主流 inline 模式区分开 — branch isolation 提示用户"这条是 A2A 子派发，不串主流"。
 *
 * 数据来源：T0 LEFT JOIN a2a_calls + envelope-builder.ts derive
 *   → TimelineMessage.a2aDisplayMode = 'inline' | 'nested' | 'background'
 *
 * 视觉：在 inner card div 上加 `border-2` 增加边框粗度（叠加 bubbleTheme[provider] 颜色）
 *   - nested → 'border-2'（独立卡片边框醒目）
 *   - inline / background / undefined → ''（不附加，走 bubbleTheme 默认）
 *
 * 注意：本函数返回的 className **附加在 message-bubble 的 inner card div 上**，
 *   与 foldable-group (outer wrap) 互补。F4 处理父子缩进，F5 处理独立卡片框。
 *
 * AC-P5-9 (spec line 385 + ADR-004 line 167) — Wave 1 第四个独立原语
 */
export function getVisualSiloClassName(message: TimelineMessage): string {
  if (message.a2aDisplayMode === "nested") {
    return "border-2"
  }
  return ""
}
