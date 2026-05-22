/**
 * F027 Phase 3 Week 3 Day 12-13 (AC-P3-2) · RuntimeLog 容器集成测试
 *
 * r2 范-r1 修：
 *   - P2-1: lvl2-content always-render 5 tabs + display 控制 visibility
 *     → 切换 tab 不 unmount 旧 tab (state-retention 契约)
 *   - P3-1: lvl1/lvl2 tabs 加 keyboard nav (ArrowLeft/Right/Home/End +
 *     roving tabIndex)
 *
 * 覆盖:
 *   - 渲染 4 个子组件 (Header + Lvl1Tabs + Lvl2Tabs + Lvl2Content)
 *   - 默认 lvl2 tab = prompt-inspector (AC-P3-2 拍)
 *   - collapsed 时只显示 Header
 *   - r2 P2-1: 5 tab always-mount + display:none 隐藏 inactive
 *   - r2 P3-1: keyboard nav ArrowLeft/Right/Home/End + roving tabIndex
 *   - Lvl1 tab 切换 (enabled / disabled)
 *   - knowledge-base [+ Drop 资料] 按钮 (disabled, Week 4 接 IngestModal)
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
    expect(screen.queryByTestId("runtime-log-lvl1-tabs")).toBeNull()
  })
})

describe("RuntimeLog r2 P2-1: 5 tabs always-mount + display 控制 visibility", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("5 个 tab 全部 always-mount (queryByTestId 都 non-null)", () => {
    render(<RuntimeLog />)
    expect(screen.getByTestId("viewfinder-tab")).toBeTruthy()
    expect(screen.getByTestId("prompt-inspector-tab")).toBeTruthy()
    expect(screen.getByTestId("draft-approval-tab")).toBeTruthy()
    expect(screen.getByTestId("warnings-tab")).toBeTruthy()
    expect(screen.getByTestId("knowledge-base-tab")).toBeTruthy()
  })

  it("active tab 父 div display=block，inactive tab display=none", () => {
    render(<RuntimeLog />)
    // 默认 prompt-inspector active
    const activeContainer = screen.getByTestId("prompt-inspector-tab").parentElement
    const inactiveContainer = screen.getByTestId("viewfinder-tab").parentElement
    expect(activeContainer?.style.display).toBe("block")
    expect(inactiveContainer?.style.display).toBe("none")
  })

  it("切换 tab 时其他 tab 仍 mount (state-retention 契约)", () => {
    render(<RuntimeLog />)
    expect(screen.getByTestId("prompt-inspector-tab")).toBeTruthy()
    expect(screen.getByTestId("viewfinder-tab")).toBeTruthy()
    act(() => {
      fireEvent.click(screen.getByTestId("runtime-log-lvl2-viewfinder"))
    })
    // 切到 viewfinder 后 prompt-inspector 仍 mount (display:none 但 DOM 在)
    expect(screen.getByTestId("prompt-inspector-tab")).toBeTruthy()
    expect(screen.getByTestId("viewfinder-tab")).toBeTruthy()
    const viewfinderContainer = screen.getByTestId("viewfinder-tab").parentElement
    const promptInspectorContainer = screen.getByTestId("prompt-inspector-tab").parentElement
    expect(viewfinderContainer?.style.display).toBe("block")
    expect(promptInspectorContainer?.style.display).toBe("none")
  })
})

describe("RuntimeLog Lvl1 tabs (含 r2 P3-1 keyboard nav)", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("system-prompt active 高亮 + roving tabIndex=0", () => {
    render(<RuntimeLog />)
    const sp = screen.getByTestId("runtime-log-lvl1-system-prompt")
    expect(sp.getAttribute("aria-selected")).toBe("true")
    expect(sp.getAttribute("tabIndex")).toBe("0")
    expect(sp.className).toMatch(/bg-slate-800/)
  })

  it("logs (未来) tab disabled + tabIndex=-1 + click 拒切换", () => {
    render(<RuntimeLog />)
    const logs = screen.getByTestId("runtime-log-lvl1-logs")
    expect(logs.getAttribute("aria-disabled")).toBe("true")
    expect(logs.getAttribute("tabIndex")).toBe("-1")
    expect(logs.hasAttribute("disabled")).toBe(true)
    act(() => {
      fireEvent.click(logs)
    })
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("system-prompt")
  })

  it("Lvl1 keyboard 只在 enabled tabs 内导航 (logs disabled 被 skip)", () => {
    render(<RuntimeLog />)
    const sp = screen.getByTestId("runtime-log-lvl1-system-prompt")
    // 只 1 个 enabled tab (system-prompt)，ArrowRight 循环回自己
    act(() => {
      fireEvent.keyDown(sp, { key: "ArrowRight" })
    })
    expect(useRuntimeLogStore.getState().activeLvl1).toBe("system-prompt")
  })
})

describe("RuntimeLog Lvl2 r2 P3-1 keyboard nav", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("active tab tabIndex=0 / inactive tabIndex=-1 (roving)", () => {
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-prompt-inspector")
    const inactive = screen.getByTestId("runtime-log-lvl2-viewfinder")
    expect(active.getAttribute("tabIndex")).toBe("0")
    expect(inactive.getAttribute("tabIndex")).toBe("-1")
  })

  it("ArrowRight → 切到下一个 tab", () => {
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-prompt-inspector")
    // 默认 prompt-inspector (index 1)，Right → draft-approval (index 2)
    act(() => {
      fireEvent.keyDown(active, { key: "ArrowRight" })
    })
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("draft-approval")
  })

  it("ArrowLeft → 切到上一个 tab", () => {
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-prompt-inspector")
    // 默认 prompt-inspector (index 1)，Left → viewfinder (index 0)
    act(() => {
      fireEvent.keyDown(active, { key: "ArrowLeft" })
    })
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("viewfinder")
  })

  it("ArrowLeft 在首 tab → 循环到末 tab (5 个)", () => {
    useRuntimeLogStore.setState({ activeLvl2: "viewfinder" })
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-viewfinder")
    act(() => {
      fireEvent.keyDown(active, { key: "ArrowLeft" })
    })
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("knowledge-base") // 末 tab
  })

  it("ArrowRight 在末 tab → 循环到首 tab", () => {
    useRuntimeLogStore.setState({ activeLvl2: "knowledge-base" })
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-knowledge-base")
    act(() => {
      fireEvent.keyDown(active, { key: "ArrowRight" })
    })
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("viewfinder") // 首 tab
  })

  it("Home → 跳首 tab viewfinder", () => {
    useRuntimeLogStore.setState({ activeLvl2: "warnings" })
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-warnings")
    act(() => {
      fireEvent.keyDown(active, { key: "Home" })
    })
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("viewfinder")
  })

  it("End → 跳末 tab knowledge-base", () => {
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-prompt-inspector")
    act(() => {
      fireEvent.keyDown(active, { key: "End" })
    })
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("knowledge-base")
  })

  it("其他 key 忽略", () => {
    render(<RuntimeLog />)
    const active = screen.getByTestId("runtime-log-lvl2-prompt-inspector")
    act(() => {
      fireEvent.keyDown(active, { key: "Enter" })
      fireEvent.keyDown(active, { key: "a" })
    })
    expect(useRuntimeLogStore.getState().activeLvl2).toBe("prompt-inspector")
  })
})

describe("RuntimeLog Lvl2 click 切换 (回归)", () => {
  beforeEach(() => resetStore())
  afterEach(() => resetStore())

  it("click 5 个 tab 都能切 + 对应 placeholder display=block", () => {
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
      const container = screen.getByTestId(c.testid).parentElement
      expect(container?.style.display).toBe("block")
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
