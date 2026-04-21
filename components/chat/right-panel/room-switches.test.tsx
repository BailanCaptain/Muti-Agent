import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { RoomSwitches } from "./room-switches"

describe("RoomSwitches", () => {
  it("renders 心里话模式 label with a checkbox reflecting showThinking=false", () => {
    render(<RoomSwitches showThinking={false} onToggleThinking={() => {}} />)
    expect(screen.getByText("心里话模式")).toBeTruthy()
    const box = screen.getByRole("checkbox", { name: /心里话模式/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
  })

  it("checkbox is checked when showThinking=true", () => {
    render(<RoomSwitches showThinking={true} onToggleThinking={() => {}} />)
    const box = screen.getByRole("checkbox", { name: /心里话模式/ }) as HTMLInputElement
    expect(box.checked).toBe(true)
  })

  it("clicking the toggle calls onToggleThinking with the negated value", () => {
    const onToggle = vi.fn()
    render(<RoomSwitches showThinking={false} onToggleThinking={onToggle} />)
    const box = screen.getByRole("checkbox", { name: /心里话模式/ })
    fireEvent.click(box)
    expect(onToggle).toHaveBeenCalledWith(true)
  })

  it("clicking again from showThinking=true emits false", () => {
    const onToggle = vi.fn()
    render(<RoomSwitches showThinking={true} onToggleThinking={onToggle} />)
    fireEvent.click(screen.getByRole("checkbox", { name: /心里话模式/ }))
    expect(onToggle).toHaveBeenCalledWith(false)
  })
})
