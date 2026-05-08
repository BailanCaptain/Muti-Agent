import type { TimelineMessage } from "@multi-agent/shared"

/**
 * F026 P5 F8 · Envelope display_mode 三态 dispatcher
 *
 * ADR-004 envelope.task.render.displayMode：
 *   - `inline`（默认）→ 嵌入主流，正常渲染气泡
 *   - `nested` → 缩进卡片（F4 缩进 + F5 边框 + F7 紫底），仍渲染气泡
 *   - `background` → **不渲染气泡**，仅 pill 状态变化（F1 Wave 2 接管）
 *
 * 数据来源：T0 LEFT JOIN a2a_calls + envelope-builder.ts derive
 *   → TimelineMessage.a2aDisplayMode = 'inline' | 'nested' | 'background'
 *
 * 用法：在 MessageBubble 组件顶部 early return：
 *   ```tsx
 *   if (!shouldRenderBubble(message)) return null
 *   ```
 *
 * AC-P5-12 (spec line 388 + ADR-004 line 106) — Wave 1 第六个独立原语 (Wave 1 收尾)
 */
export function shouldRenderBubble(message: TimelineMessage): boolean {
  return message.a2aDisplayMode !== "background"
}
