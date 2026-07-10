import { describe, expect, it, vi } from "vitest"
import { selectSessionGroupFromCard } from "./session-sidebar"

describe("F044 session sidebar switching", () => {
  it("closes the mobile drawer before the async snapshot resolves", async () => {
    let resolveSelection!: () => void
    const selection = new Promise<void>((resolve) => {
      resolveSelection = resolve
    })
    const events: string[] = []
    const toggleSidebar = vi.fn(() => events.push("close"))
    const selectGroup = vi.fn(() => {
      events.push("select")
      return selection
    })

    const result = selectSessionGroupFromCard("g1", selectGroup, {
      isMobile: () => true,
      isSidebarCollapsed: () => false,
      toggleSidebar,
    })

    expect(events).toEqual(["close", "select"])
    expect(toggleSidebar).toHaveBeenCalledOnce()
    resolveSelection()
    await result
  })

  it("does not toggle the desktop sidebar", async () => {
    const toggleSidebar = vi.fn()

    await selectSessionGroupFromCard(
      "g1",
      vi.fn(async () => {}),
      {
        isMobile: () => false,
        isSidebarCollapsed: () => false,
        toggleSidebar,
      },
    )

    expect(toggleSidebar).not.toHaveBeenCalled()
  })
})
