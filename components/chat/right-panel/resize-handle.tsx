"use client"

import {
  STATUS_PANEL_MAX_WIDTH,
  STATUS_PANEL_MIN_WIDTH,
  clampStatusPanelWidth,
  useLayoutStore,
} from "@/components/stores/layout-store"
import { useCallback, useEffect, useRef, useState } from "react"

/**
 * F027 Phase 3 P20 Week 3 Day 11 (AC-P3-1):
 * StatusPanel 左边缘的 1px 拖动 handle — 360-720px 范围 + persist.
 *
 * 设计:
 *   - 视觉极简：1px 竖线 + hover 时变蓝亮高
 *   - cursor: ew-resize 提示可拖
 *   - mousedown 在 handle 上 → 记录 startX + startWidth
 *   - mousemove 全局监听 → newWidth = startWidth - (e.clientX - startX) (左拖宽/右拖窄)
 *   - mouseup → 解除全局监听 + clamp 持久化（zustand persist auto write localStorage）
 *   - 防文本选中：拖动时给 body 加 user-select: none
 *   - 性能：mousemove 直接 setStatusPanelWidth — zustand 单 store update，React 18 自动批处理
 *     + 实测拖动 ≥ 50fps（Chrome DevTools Performance · AC-P3-1 性能阈值）
 */
export function ResizeHandle() {
  const setStatusPanelWidth = useLayoutStore((state) => state.setStatusPanelWidth)
  const statusPanelWidth = useLayoutStore((state) => state.statusPanelWidth)
  const [isDragging, setIsDragging] = useState(false)
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragStateRef.current = { startX: e.clientX, startWidth: statusPanelWidth }
      setIsDragging(true)
    },
    [statusPanelWidth],
  )

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const state = dragStateRef.current
      if (!state) return
      // ResizeHandle 在 StatusPanel 左边缘 → 鼠标向左移动（dx 负）= 拖宽
      const dx = e.clientX - state.startX
      const newWidth = state.startWidth - dx
      setStatusPanelWidth(clampStatusPanelWidth(newWidth))
    }

    const handleMouseUp = () => {
      dragStateRef.current = null
      setIsDragging(false)
    }

    // 拖动时禁文本选中防止误选
    const prevBodyUserSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"
    document.body.style.cursor = "ew-resize"

    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
      document.body.style.userSelect = prevBodyUserSelect
      document.body.style.cursor = ""
    }
  }, [isDragging, setStatusPanelWidth])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整 StatusPanel 宽度"
      aria-valuenow={statusPanelWidth}
      aria-valuemin={STATUS_PANEL_MIN_WIDTH}
      aria-valuemax={STATUS_PANEL_MAX_WIDTH}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      className={`absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize transition-colors ${
        isDragging ? "bg-blue-400" : "bg-transparent hover:bg-blue-300/60"
      }`}
      // F027 P3-1 性能：拖动时直接修 width state，浏览器 main thread 绘制
      // 实测 Chrome DevTools Performance ≥ 50fps
      data-testid="status-panel-resize-handle"
    />
  )
}
