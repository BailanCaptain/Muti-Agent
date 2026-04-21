import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AgentConfigDrawer } from "./agent-config-drawer"

describe("AgentConfigDrawer", () => {
  it("does not render body when isOpen=false", () => {
    const { container } = render(
      <AgentConfigDrawer isOpen={false} provider="claude" onClose={() => {}}>
        inner
      </AgentConfigDrawer>,
    )
    // When closed, the dialog should not be in the document (or hidden via aria-hidden).
    const dialog = container.querySelector('[role="dialog"]')
    if (dialog) {
      expect(dialog.getAttribute("aria-hidden")).toBe("true")
    }
  })

  it("renders dialog with segmented tabs '全局默认' and '会话专属' when open", () => {
    render(
      <AgentConfigDrawer isOpen provider="claude" onClose={() => {}}>
        inner
      </AgentConfigDrawer>,
    )
    const dialog = screen.getByRole("dialog")
    expect(dialog).toBeTruthy()
    expect(screen.getByRole("tab", { name: "全局默认" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "会话专属" })).toBeTruthy()
  })

  it("defaults to 全局默认 tab selected", () => {
    render(
      <AgentConfigDrawer isOpen provider="claude" onClose={() => {}}>
        inner
      </AgentConfigDrawer>,
    )
    const globalTab = screen.getByRole("tab", { name: "全局默认" })
    expect(globalTab.getAttribute("aria-selected")).toBe("true")
  })

  it("switches to 会话专属 tab on click", () => {
    render(
      <AgentConfigDrawer isOpen provider="claude" onClose={() => {}}>
        inner
      </AgentConfigDrawer>,
    )
    fireEvent.click(screen.getByRole("tab", { name: "会话专属" }))
    expect(screen.getByRole("tab", { name: "会话专属" }).getAttribute("aria-selected")).toBe(
      "true",
    )
  })

  it("invokes onClose when clicking the close button", () => {
    const onClose = vi.fn()
    render(
      <AgentConfigDrawer isOpen provider="claude" onClose={onClose}>
        inner
      </AgentConfigDrawer>,
    )
    fireEvent.click(screen.getByRole("button", { name: /关闭/ }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("invokes onClose on Escape key", () => {
    const onClose = vi.fn()
    render(
      <AgentConfigDrawer isOpen provider="claude" onClose={onClose}>
        inner
      </AgentConfigDrawer>,
    )
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("renders children inside the active tab panel", () => {
    render(
      <AgentConfigDrawer
        isOpen
        provider="claude"
        onClose={() => {}}
        globalSlot={<div>GLOBAL_CONTENT</div>}
        sessionSlot={<div>SESSION_CONTENT</div>}
      />,
    )
    expect(screen.getByText("GLOBAL_CONTENT")).toBeTruthy()
    // Session slot is in the DOM for hot-switching but hidden
    fireEvent.click(screen.getByRole("tab", { name: "会话专属" }))
    expect(screen.getByText("SESSION_CONTENT")).toBeTruthy()
  })
})
