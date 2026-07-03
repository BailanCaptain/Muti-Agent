"use client"

import {
  STATUS_PANEL_MAX_WIDTH,
  STATUS_PANEL_MIN_WIDTH,
  clampStatusPanelWidth,
  useLayoutStore,
} from "@/components/stores/layout-store"
import { useCallback, useRef, useState } from "react"

/**
 * F027 Phase 3 P20 Week 3 Day 11 (AC-P3-1) · StatusPanel 左边缘拖动 handle.
 *
 * r2 范-r1 修复：
 *   - P2-2: mousemove 期间 **直接修 DOM aside.style.width**（绕 React rerender 高频 +
 *     绕 zustand persist 同步 localStorage 写），mouseup 时才调 setStatusPanelWidth
 *     一次性 commit + persist。性能从 r1 ~30fps（每帧 setState + localStorage 写）
 *     提升到 60+fps（拖动只 DOM 直写）。
 *   - P3: 加 keyboard 拖动支持（ArrowLeft/Right 步进 16px / Shift 步进 64px /
 *     Home → min / End → max），保留 ARIA + tabIndex 可访问性合规。
 *
 * 设计：
 *   - 1px 竖线（hover 蓝亮 / 拖动深蓝）+ cursor-ew-resize
 *   - mousedown 启动拖动 → 全局监听 mousemove/mouseup
 *   - DOM 直操 wrapper aside.style.width（ResizeHandle 内 closest('aside') 拿引用）
 *   - mouseup 时同步 width → store（zustand persist 同步写 localStorage）
 *   - 防文本选中：拖动时给 body 加 user-select: none
 *   - keyboard: handle focused 时 Arrow keys 步进调宽
 */

const KEYBOARD_STEP_PX = 16
const KEYBOARD_SHIFT_STEP_PX = 64

export function ResizeHandle() {
  const setStatusPanelWidth = useLayoutStore((state) => state.setStatusPanelWidth)
  const statusPanelWidth = useLayoutStore((state) => state.statusPanelWidth)
  const [isDragging, setIsDragging] = useState(false)
  const handleRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{
    startX: number
    startWidth: number
    asideEl: HTMLElement
    currentWidth: number
  } | null>(null)

  /** 找最近的 aside 父元素（StatusPanel wrapper）— 拖动时直操它的 style.width */
  const findAsideEl = useCallback((): HTMLElement | null => {
    return handleRef.current?.closest("aside") ?? null
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const asideEl = findAsideEl()
      if (!asideEl) return
      dragStateRef.current = {
        startX: e.clientX,
        startWidth: statusPanelWidth,
        asideEl,
        currentWidth: statusPanelWidth,
      }
      setIsDragging(true)

      // r2 fix: 监听器同步注册（不走 useEffect+isDragging state）— useEffect 异步
      // 会让测试 fireEvent.mouseMove 在 listener 装好之前触发（fail）+ 真实场景也
      // 可能错过最早的几个 mousemove。mousedown 内同步 addEventListener，mouseup
      // 内同步 remove + cleanup body styles。
      const prevBodyUserSelect = document.body.style.userSelect
      const prevBodyCursor = document.body.style.cursor
      document.body.style.userSelect = "none"
      document.body.style.cursor = "ew-resize"

      const handleMouseMove = (ev: MouseEvent) => {
        const state = dragStateRef.current
        if (!state) return
        // 左边缘拖动 → 鼠标向左移动（dx 负）= 拖宽
        const dx = ev.clientX - state.startX
        const newWidth = clampStatusPanelWidth(state.startWidth - dx)
        state.currentWidth = newWidth
        // r2 P2-2: 直接修 DOM 避开 React rerender + zustand persist 同步 localStorage 写
        // 60+fps 流畅拖动（vs r1 每帧 setState + JSON.stringify + localStorage.setItem ~30fps）
        state.asideEl.style.width = `${newWidth}px`
      }

      const handleMouseUp = () => {
        const state = dragStateRef.current
        if (state) {
          // r2 P2-2: 拖动结束才一次性 commit 到 store（触发 zustand persist localStorage 写）
          setStatusPanelWidth(state.currentWidth)
        }
        dragStateRef.current = null
        setIsDragging(false)
        document.removeEventListener("mousemove", handleMouseMove)
        document.removeEventListener("mouseup", handleMouseUp)
        document.body.style.userSelect = prevBodyUserSelect
        document.body.style.cursor = prevBodyCursor
      }

      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
    },
    [statusPanelWidth, findAsideEl, setStatusPanelWidth],
  )

  /** r2 P3: keyboard 拖动 — ArrowLeft/Right 步进 + Shift 大步 + Home/End 极值 */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let nextWidth = statusPanelWidth
      const step = e.shiftKey ? KEYBOARD_SHIFT_STEP_PX : KEYBOARD_STEP_PX
      switch (e.key) {
        case "ArrowLeft":
          nextWidth = statusPanelWidth + step // 左 = 拖宽
          break
        case "ArrowRight":
          nextWidth = statusPanelWidth - step // 右 = 拖窄
          break
        case "Home":
          nextWidth = STATUS_PANEL_MIN_WIDTH
          break
        case "End":
          nextWidth = STATUS_PANEL_MAX_WIDTH
          break
        default:
          return
      }
      e.preventDefault()
      setStatusPanelWidth(nextWidth)
    },
    [statusPanelWidth, setStatusPanelWidth],
  )

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整 StatusPanel 宽度 (ArrowLeft/Right 键盘步进 16px, Shift 64px, Home/End 极值)"
      aria-valuenow={statusPanelWidth}
      aria-valuemin={STATUS_PANEL_MIN_WIDTH}
      aria-valuemax={STATUS_PANEL_MAX_WIDTH}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      className={`absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize transition-colors focus:outline-none focus-visible:bg-accent-400 ${
        isDragging ? "bg-accent-400" : "bg-transparent hover:bg-slate-300/60"
      }`}
      data-testid="status-panel-resize-handle"
    />
  )
}
