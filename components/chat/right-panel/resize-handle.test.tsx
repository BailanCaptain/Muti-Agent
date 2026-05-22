/**
 * F027 Phase 3 P20 Week 3 Day 11 (AC-P3-1) · ResizeHandle 单元测试
 *
 * 覆盖:
 *   - 渲染 + ARIA 属性
 *   - mousedown 启动拖动 + mousemove 改 width + mouseup 结束
 *   - clamp 范围（拖出边界 360-720 弹回）
 *   - 拖动方向：StatusPanel 左边缘，鼠标左移 = 拖宽
 *   - 拖动期间 body cursor + user-select 状态
 *
 * 注：性能测试 (≥50fps) 留 Playwright E2E (Week 5)，单测不覆盖。
 */

import {
  STATUS_PANEL_DEFAULT_WIDTH,
  STATUS_PANEL_MAX_WIDTH,
  STATUS_PANEL_MIN_WIDTH,
  useLayoutStore,
} from "@/components/stores/layout-store"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ResizeHandle } from "./resize-handle"

function resetStore() {
  useLayoutStore.setState({
    statusPanelWidth: STATUS_PANEL_DEFAULT_WIDTH,
    statusPanelCollapsed: false,
    sidebarCollapsed: false,
  })
}

describe("ResizeHandle 渲染 + ARIA", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("渲染 separator role + 完整 ARIA + data-testid", () => {
    render(<ResizeHandle />)
    const handle = screen.getByRole("separator")
    expect(handle).toBeTruthy()
    expect(handle.getAttribute("aria-orientation")).toBe("vertical")
    expect(handle.getAttribute("aria-label")).toMatch(/拖动调整/)
    expect(handle.getAttribute("aria-valuenow")).toBe(String(STATUS_PANEL_DEFAULT_WIDTH))
    expect(handle.getAttribute("aria-valuemin")).toBe(String(STATUS_PANEL_MIN_WIDTH))
    expect(handle.getAttribute("aria-valuemax")).toBe(String(STATUS_PANEL_MAX_WIDTH))
    expect(handle.getAttribute("data-testid")).toBe("status-panel-resize-handle")
  })

  it("初始非拖动态 cursor = ew-resize + 非高亮", () => {
    render(<ResizeHandle />)
    const handle = screen.getByTestId("status-panel-resize-handle")
    expect(handle.className).toMatch(/cursor-ew-resize/)
    expect(handle.className).not.toMatch(/bg-blue-400/)
    expect(handle.className).toMatch(/hover:bg-blue-300/)
  })
})

describe("ResizeHandle 拖动行为", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("mousedown → mousemove → mouseup：左拖 50px → width 增 50", () => {
    render(<ResizeHandle />)
    const handle = screen.getByTestId("status-panel-resize-handle")
    // 起始 width 360，clientX 起 500
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
    })
    // 鼠标左移 50px (clientX 450) → newWidth = 360 - (450 - 500) = 410
    act(() => {
      fireEvent.mouseMove(document, { clientX: 450 })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(410)
    act(() => {
      fireEvent.mouseUp(document)
    })
  })

  it("右拖 50px → width 减 50", () => {
    useLayoutStore.setState({ statusPanelWidth: 500 })
    render(<ResizeHandle />)
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 800 })
    })
    // 鼠标右移 50px → newWidth = 500 - (850 - 800) = 450
    act(() => {
      fireEvent.mouseMove(document, { clientX: 850 })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(450)
    act(() => {
      fireEvent.mouseUp(document)
    })
  })

  it("拖出 max 720 → clamp 720", () => {
    useLayoutStore.setState({ statusPanelWidth: 700 })
    render(<ResizeHandle />)
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
    })
    // 大幅左拖到 200，newWidth = 700 - (200 - 500) = 1000 → clamp 720
    act(() => {
      fireEvent.mouseMove(document, { clientX: 200 })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MAX_WIDTH)
    act(() => {
      fireEvent.mouseUp(document)
    })
  })

  it("拖出 min 360 → clamp 360", () => {
    useLayoutStore.setState({ statusPanelWidth: 400 })
    render(<ResizeHandle />)
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
    })
    // 大幅右拖到 800，newWidth = 400 - (800 - 500) = 100 → clamp 360
    act(() => {
      fireEvent.mouseMove(document, { clientX: 800 })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MIN_WIDTH)
    act(() => {
      fireEvent.mouseUp(document)
    })
  })

  it("mouseup 后 mousemove 不再改 width", () => {
    render(<ResizeHandle />)
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
      fireEvent.mouseMove(document, { clientX: 450 })
    })
    const widthAfterFirstMove = useLayoutStore.getState().statusPanelWidth
    act(() => {
      fireEvent.mouseUp(document)
      // mouseup 之后再 move 应该不生效
      fireEvent.mouseMove(document, { clientX: 100 })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(widthAfterFirstMove)
  })

  it("拖动期间 body cursor=ew-resize + user-select=none，mouseup 清除", () => {
    render(<ResizeHandle />)
    const handle = screen.getByTestId("status-panel-resize-handle")
    expect(document.body.style.cursor).toBe("")
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
    })
    expect(document.body.style.cursor).toBe("ew-resize")
    expect(document.body.style.userSelect).toBe("none")
    act(() => {
      fireEvent.mouseUp(document)
    })
    expect(document.body.style.cursor).toBe("")
    // userSelect restored 到上一个值（测试环境通常空字符串）
  })
})
