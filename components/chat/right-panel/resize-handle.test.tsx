/**
 * F027 Phase 3 P20 Week 3 Day 11 (AC-P3-1) · ResizeHandle 单元测试 (r2)
 *
 * r2 范-r1 修复:
 *   - P2-2: mousemove 改 DOM 不改 store / mouseup 才 commit store
 *   - P3: keyboard 拖动 (ArrowLeft/Right/Shift/Home/End)
 *
 * 覆盖:
 *   - 渲染 + ARIA (含 r2 keyboard 提示)
 *   - mouse 拖动: mousemove 改 aside DOM width / mouseup 才 commit store / clamp 边界
 *   - keyboard 拖动: ArrowLeft 拖宽 / ArrowRight 拖窄 / Shift 大步 / Home / End
 *   - body cursor + user-select 状态
 *
 * 性能 ≥50fps 阈值留 Week 5 Playwright E2E，单测不覆盖。
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
  localStorage.removeItem("multi-agent-layout-store")
  // 防上个 test 残留 body styles 干扰下个 test
  document.body.style.cursor = ""
  document.body.style.userSelect = ""
}

/** ResizeHandle 需要 aside 父元素（拖动时 closest('aside') 拿引用） */
function renderInAside(initialWidth = STATUS_PANEL_DEFAULT_WIDTH) {
  return render(
    <aside style={{ width: `${initialWidth}px` }} data-testid="aside-wrapper">
      <ResizeHandle />
    </aside>,
  )
}

describe("ResizeHandle 渲染 + ARIA", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("渲染 separator role + 完整 ARIA + data-testid", () => {
    renderInAside()
    const handle = screen.getByRole("separator")
    expect(handle).toBeTruthy()
    expect(handle.getAttribute("aria-orientation")).toBe("vertical")
    expect(handle.getAttribute("aria-label")).toMatch(/拖动调整/)
    expect(handle.getAttribute("aria-label")).toMatch(/ArrowLeft\/Right/) // r2 P3 keyboard 提示
    expect(handle.getAttribute("aria-valuenow")).toBe(String(STATUS_PANEL_DEFAULT_WIDTH))
    expect(handle.getAttribute("aria-valuemin")).toBe(String(STATUS_PANEL_MIN_WIDTH))
    expect(handle.getAttribute("aria-valuemax")).toBe(String(STATUS_PANEL_MAX_WIDTH))
    expect(handle.getAttribute("tabIndex")).toBe("0")
    expect(handle.getAttribute("data-testid")).toBe("status-panel-resize-handle")
  })

  it("初始非拖动态 cursor = ew-resize + 非高亮 + focus 高亮", () => {
    renderInAside()
    const handle = screen.getByTestId("status-panel-resize-handle")
    expect(handle.className).toMatch(/cursor-ew-resize/)
    expect(handle.className).not.toMatch(/(?<!:)bg-accent-400/) // 非拖动态不常亮（排除 focus-visible: 前缀）
    expect(handle.className).toMatch(/hover:bg-slate-300/)
    // F039: keyboard focus 视觉从 focus:bg-blue-500 收敛到 focus-visible + accent（r2 P3 语义不变）
    expect(handle.className).toMatch(/focus-visible:bg-accent-400/)
  })
})

describe("ResizeHandle mouse 拖动 (r2 P2-2: DOM 直操 + mouseup commit)", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("mousemove 直接修 aside.style.width（不调 store）", () => {
    renderInAside()
    const aside = screen.getByTestId("aside-wrapper") as HTMLElement
    const handle = screen.getByTestId("status-panel-resize-handle")
    const initialStoreWidth = useLayoutStore.getState().statusPanelWidth
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
    })
    // 鼠标左移 50px → newWidth = 360 - (-50) = 410
    act(() => {
      fireEvent.mouseMove(document, { clientX: 450 })
    })
    // r2 P2-2: store 未变（只 DOM 改）
    expect(useLayoutStore.getState().statusPanelWidth).toBe(initialStoreWidth)
    expect(aside.style.width).toBe("410px")
  })

  it("mouseup 才一次性 commit store（zustand persist 同步 localStorage）", () => {
    renderInAside()
    const aside = screen.getByTestId("aside-wrapper") as HTMLElement
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
      fireEvent.mouseMove(document, { clientX: 450 })
      fireEvent.mouseMove(document, { clientX: 400 })
      fireEvent.mouseMove(document, { clientX: 350 }) // 多次 mousemove 期间 store 不变
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_DEFAULT_WIDTH)
    act(() => {
      fireEvent.mouseUp(document)
    })
    // mouseup 后 store commit 最终 width: 360 - (350 - 500) = 510
    expect(useLayoutStore.getState().statusPanelWidth).toBe(510)
    expect(aside.style.width).toBe("510px")
  })

  it("拖出 max 1200 → DOM clamp 1200 (v3.4 patch)", () => {
    useLayoutStore.setState({ statusPanelWidth: 1180 })
    renderInAside(1180)
    const aside = screen.getByTestId("aside-wrapper") as HTMLElement
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
      fireEvent.mouseMove(document, { clientX: 100 }) // 大拖远超 1200 → clamp 1200
    })
    expect(aside.style.width).toBe(`${STATUS_PANEL_MAX_WIDTH}px`)
    act(() => {
      fireEvent.mouseUp(document)
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MAX_WIDTH)
  })

  it("拖出 min 360 → DOM clamp 360", () => {
    useLayoutStore.setState({ statusPanelWidth: 400 })
    renderInAside(400)
    const aside = screen.getByTestId("aside-wrapper") as HTMLElement
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 500 })
      fireEvent.mouseMove(document, { clientX: 800 }) // 大拖到 100 → clamp 360
    })
    expect(aside.style.width).toBe(`${STATUS_PANEL_MIN_WIDTH}px`)
    act(() => {
      fireEvent.mouseUp(document)
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MIN_WIDTH)
  })

  it("拖动期间 body cursor=ew-resize + user-select=none，mouseup 清除", () => {
    renderInAside()
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
  })
})

describe("ResizeHandle keyboard 拖动 (r2 P3)", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("ArrowLeft → 拖宽 16px", () => {
    renderInAside()
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowLeft" })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_DEFAULT_WIDTH + 16)
  })

  it("ArrowRight → 拖窄 16px (clamp 到 min)", () => {
    renderInAside()
    const handle = screen.getByTestId("status-panel-resize-handle")
    // 起始 360 (min)，再拖窄被 clamp
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowRight" })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MIN_WIDTH)
  })

  it("Shift+ArrowLeft → 拖宽 64px (大步)", () => {
    renderInAside()
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_DEFAULT_WIDTH + 64)
  })

  it("Home → 跳到 min 360", () => {
    useLayoutStore.setState({ statusPanelWidth: 500 })
    renderInAside(500)
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.keyDown(handle, { key: "Home" })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MIN_WIDTH)
  })

  it("End → 跳到 max 1200 (v3.4 patch)", () => {
    renderInAside()
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.keyDown(handle, { key: "End" })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_MAX_WIDTH)
  })

  it("其他 key 忽略不变", () => {
    renderInAside()
    const handle = screen.getByTestId("status-panel-resize-handle")
    act(() => {
      fireEvent.keyDown(handle, { key: "Enter" })
      fireEvent.keyDown(handle, { key: "a" })
      fireEvent.keyDown(handle, { key: " " })
    })
    expect(useLayoutStore.getState().statusPanelWidth).toBe(STATUS_PANEL_DEFAULT_WIDTH)
  })
})
