"use client"

import {
  RUNTIME_LOG_MAX_HEIGHT,
  RUNTIME_LOG_MIN_HEIGHT,
  clampRuntimeLogHeight,
  useLayoutStore,
} from "@/components/stores/layout-store"
import { useCallback, useRef, useState } from "react"

/**
 * F027 P3-1 扩展（小孙 2026-06-02 浏览器实测拍 · 方案一 split）·
 * StatusPanel 上下两区之间的**贯穿分隔线**——拖它分配「房间信息区(上)」与「运行日志区(下)」空间。
 *
 * 视觉：整条全宽细线（面板结构的一部分，不是贴在日志卡片上的把手），
 *       中间一个居中 grip 提示可拖；hover/拖动变蓝。
 * 行为：往上拖 = 下方日志变大、上方收缩；往下拖反之。改的是 layout-store.runtimeLogHeight，
 *       上区是 flex-1 自动让位（status-panel 已包成可滚动区）。
 *
 * 性能/可访问性照搬横向 ResizeHandle 成熟实现（范-r1 P2-2 + P3）：
 *   - mousedown 内同步 addEventListener（不走 useEffect 异步）
 *   - 拖动期间直操 DOM `containerEl.style.height`（绕 rerender + persist 写）→ 60+fps
 *   - mouseup 才 commit + persist
 *   - keyboard：ArrowUp/Down 步进 16 / Shift 64 / Home → min / End → max
 *   - 拖动时 body user-select:none + cursor ns-resize
 */

const KEYBOARD_STEP_PX = 16
const KEYBOARD_SHIFT_STEP_PX = 64

export function ResizeHandleVertical() {
  const setRuntimeLogHeight = useLayoutStore((state) => state.setRuntimeLogHeight)
  const runtimeLogHeight = useLayoutStore((state) => state.runtimeLogHeight)
  const [isDragging, setIsDragging] = useState(false)
  const handleRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{
    startY: number
    startHeight: number
    containerEl: HTMLElement
    currentHeight: number
  } | null>(null)

  /** 找分隔线下方的 runtime-log 容器（拖动时直操它的 style.height） */
  const findContainerEl = useCallback((): HTMLElement | null => {
    // 分隔线是 runtime-log 容器的前一个兄弟节点
    const sib = handleRef.current?.nextElementSibling
    if (sib instanceof HTMLElement && sib.dataset.testid === "runtime-log-container") return sib
    return (
      handleRef.current?.parentElement?.querySelector<HTMLElement>(
        "[data-testid='runtime-log-container']",
      ) ?? null
    )
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const containerEl = findContainerEl()
      if (!containerEl) return
      dragStateRef.current = {
        startY: e.clientY,
        startHeight: runtimeLogHeight,
        containerEl,
        currentHeight: runtimeLogHeight,
      }
      setIsDragging(true)

      const prevBodyUserSelect = document.body.style.userSelect
      const prevBodyCursor = document.body.style.cursor
      document.body.style.userSelect = "none"
      document.body.style.cursor = "ns-resize"

      const handleMouseMove = (ev: MouseEvent) => {
        const state = dragStateRef.current
        if (!state) return
        // 分隔线向上移动（dy 负）= 下方日志加高
        const dy = ev.clientY - state.startY
        const newHeight = clampRuntimeLogHeight(state.startHeight - dy)
        state.currentHeight = newHeight
        // 直操 DOM 避开 rerender + persist 写 → 60+fps
        state.containerEl.style.height = `${newHeight}px`
      }

      const handleMouseUp = () => {
        const state = dragStateRef.current
        if (state) setRuntimeLogHeight(state.currentHeight)
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
    [runtimeLogHeight, findContainerEl, setRuntimeLogHeight],
  )

  /** keyboard 拖动 — ArrowUp/Down 步进 + Shift 大步 + Home/End 极值 */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      let nextHeight = runtimeLogHeight
      const step = e.shiftKey ? KEYBOARD_SHIFT_STEP_PX : KEYBOARD_STEP_PX
      switch (e.key) {
        case "ArrowUp":
          nextHeight = runtimeLogHeight + step
          break
        case "ArrowDown":
          nextHeight = runtimeLogHeight - step
          break
        case "Home":
          nextHeight = RUNTIME_LOG_MIN_HEIGHT
          break
        case "End":
          nextHeight = RUNTIME_LOG_MAX_HEIGHT
          break
        default:
          return
      }
      e.preventDefault()
      setRuntimeLogHeight(nextHeight)
    },
    [runtimeLogHeight, setRuntimeLogHeight],
  )

  return (
    // 贯穿全宽的分隔线：整条是拖动热区（含上下各 ~4px padding 好点中），
    // 视觉上是一条贴着面板的细线 + 居中 grip。
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="horizontal"
      aria-label="拖动分隔线调整运行日志高度 (往上拖加高；ArrowUp/Down 键盘步进 16px, Shift 64px, Home/End 极值)"
      aria-valuenow={runtimeLogHeight}
      aria-valuemin={RUNTIME_LOG_MIN_HEIGHT}
      aria-valuemax={RUNTIME_LOG_MAX_HEIGHT}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      className="group relative -my-1 flex h-3 w-full shrink-0 cursor-ns-resize items-center justify-center focus:outline-none"
      data-testid="runtime-log-resize-handle"
    >
      {/* 全宽分隔细线 */}
      <span
        aria-hidden="true"
        className={`absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 transition-colors ${
          isDragging ? "bg-blue-400" : "bg-slate-200 group-hover:bg-blue-300 group-focus:bg-blue-400"
        }`}
      />
      {/* 居中 grip 提示可拖 */}
      <span
        aria-hidden="true"
        className={`relative h-1 w-8 rounded-full transition-colors ${
          isDragging
            ? "bg-blue-400"
            : "bg-slate-300 group-hover:bg-blue-400 group-focus:bg-blue-500"
        }`}
      />
    </div>
  )
}
