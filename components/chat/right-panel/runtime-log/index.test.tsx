/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 容器集成测试
 *
 * 覆盖:
 *   - 渲染 4 个子组件 (Header + Lvl1Tabs + Lvl2Tabs + Lvl2Content)
 *   - 默认 lvl2 tab = prompt-inspector (AC-P3-2 拍)
 *   - collapsed 时只显示 Header (Lvl1Tabs/Lvl2Tabs/Content 隐藏)
 *   - Lvl1 tab 切换 (enabled / disabled)
 *   - Lvl2 tab 切换 5 tabs
 *   - Lvl2 内容根据 activeLvl2 渲染对应 placeholder
 */

import { useRuntimeLogStore } from "@/components/stores/runtime-log-store"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RuntimeLog } from "./index"

function resetStore() {
  useRuntimeLogStore.setState({
    activeLvl1: "system-prompt",
    activeLvl2: "prompt-inspector",
    collapsed: false,
  })
}

describe("RuntimeLog 容器渲染", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("展开态渲染 Header + Lvl1Tabs + Lvl2Tabs + Lvl2Content", () => {
    render(<RuntimeLog />)
    expect(screen.getByTestId("runtime-log-container")).toBeTruthy()
    expect(screen.getByTestId("runtime-log-header")).toBeTruthy()
    expect(screen.getByTestId("runtime-log-lvl1-tabs")).toBeTruthy()
    expect(screen.getByTestId("runtime-log-lvl2-tabs")).toBeTruthy()
    expect(screen.getByTestId("runtime-log-lvl2-content")).toBeTruthy()
  })

  it("默认 lvl2 tab = prompt-inspector (AC-P3-2 拍)", () => {
    render(<RuntimeLog />)
    // 渲染 prompt-inspector-tab placeholder
    expect(screen.getByTestId("prompt-inspector-tab")).toBeTruthy()
    // 其他 4 tab 不渲染
    expect(screen.queryByTestId("viewfinder-tab")).toBeNull()
    expect(screen.queryByTestId("draft-approval-tab")).toBeNull()
    expect(screen.queryByTestId("warnings-tab")).toBeNull()
    expect(screen.queryByTestId("knowledge-base-tab")).toBeNull()
  })

  it("collapsed 态只渲染 Header", () => {
    useRuntimeLogStore.setState({ collapsed: true })
    render(<RuntimeLog />)
    expect(screen.getByTestId("runtime-log-header")).toBeTruthy()
    expect(screen.queryByTestId("runtime-log-lvl1-tabs")).toBeNull()
    expect(screen.queryByTestId("runtime-log-lvl2-tabs")).toBeNull()
    expect(screen.queryByTestId("runtime-log-lvl2-content")).toBeNull()
  })

  it("toggle collapsed 按钮工作", () => {
    render(<RuntimeLog />)
    const toggleBtn = screen.getByTestId("runtime-log-toggle-collapse")
    expect(useRuntimeLogStore.getState().collapsed).toBe(false)
    act(() => {
      fireEvent.click(toggleBtn)
    })
    expect(useRuntimeLogStore.getState().collapsed).toBe(true)
    // collapsed 后 lvl1/lvl2 不渲染
    expect(screen.queryByTestId("runtime-log-lvl1-tabs")).toBeNull()
  })
})

describe("RuntimeLog Lvl1 tabs", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("system-prompt active 高亮", () => {
    render(<RuntimeLog />)
    const sp = screen.getByTestId("runtime-log-lvl1-system-prompt")
    expect(sp.getAttribute("aria-selected")).toBe("true")
    expect(sp.className).toMatch(/bg-slate-800/) // active 黑底
  })

  it("logs (未来) tab disabled — click 不切换", () => {
    render(<RuntimeLog />)
    const logs = screen.getByTestId("runtime-log-lvl1-logs")
    expect(logs.getAttribute("aria-disabled")).toBe("true")
    expect(logs.hasAttribute("disabled")).toBe(true)
    act(() => {
      fireEvent.click(logs)
    })
    // 状态不变（disabled 拒切换）
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("system-prompt")
  })

  it("logs tab 显示 '· 未来' 标记", () => {
    render(<RuntimeLog />)
    const logs = screen.getByTestId("runtime-log-lvl1-logs")
    expect(logs.textContent).toMatch(/未来/)
  })
})

describe("RuntimeLog Lvl2 tabs 5 个切换", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("click viewfinder tab → 切换 + 渲染 viewfinder-tab placeholder", () => {
    render(<RuntimeLog />)
    act(() => {
      fireEvent.click(screen.getByTestId("runtime-log-lvl2-viewfinder"))
    })
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("viewfinder")
    expect(screen.getByTestId("viewfinder-tab")).toBeTruthy()
    expect(screen.queryByTestId("prompt-inspector-tab")).toBeNull()
  })

  it("5 个 tab 都能切换 + 对应 placeholder 渲染", () => {
    const cases = [
      { key: "viewfinder", testid: "viewfinder-tab" },
      { key: "prompt-inspector", testid: "prompt-inspector-tab" },
      { key: "draft-approval", testid: "draft-approval-tab" },
      { key: "warnings", testid: "warnings-tab" },
      { key: "knowledge-base", testid: "knowledge-base-tab" },
    ] as const
    render(<RuntimeLog />)
    for (const c of cases) {
      act(() => {
        fireEvent.click(screen.getByTestId(`runtime-log-lvl2-${c.key}`))
      })
      expect(useRuntimeLogStore.getState().activeLvl2).toBe(c.key)
      expect(screen.getByTestId(c.testid)).toBeTruthy()
    }
  })

  it("active tab 视觉高亮 (border-b-white)", () => {
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-prompt-inspector")
    expect(active.getAttribute("aria-selected")).toBe("true")
    expect(active.className).toMatch(/border-b-white/)
  })
})

describe("RuntimeLog knowledge-base [+ Drop 资料] 按钮 (Week 4 接入)", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("knowledge-base tab 含 disabled '+ Drop 资料' 按钮", () => {
    useRuntimeLogStore.setState({ activeLvl2: "knowledge-base" })
    render(<RuntimeLog />)
    const tab = screen.getByTestId("knowledge-base-tab")
    const btn = tab.querySelector("button")
    expect(btn).toBeTruthy()
    expect(btn?.hasAttribute("disabled")).toBe(true)
    expect(btn?.textContent).toMatch(/Drop 资料/)
  })
})
