import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { ProgressBlockComponent } from "./progress-block"
import type { ProgressBlock } from "@/lib/blocks"

const block: ProgressBlock = {
  kind: "progress",
  id: "p1",
  title: "投票结果",
  items: [
    { label: "方案 A", value: 60, tone: "success", caption: "12 票" },
    { label: "方案 B", value: 40 },
  ],
}

describe("ProgressBlockComponent", () => {
  it("renders labels, explicit caption, and percent fallback", () => {
    render(<ProgressBlockComponent block={block} />)
    expect(screen.getByText("投票结果")).toBeTruthy()
    expect(screen.getByText("方案 A")).toBeTruthy()
    expect(screen.getByText("12 票")).toBeTruthy() // explicit caption
    expect(screen.getByText("40%")).toBeTruthy() // no caption → percent fallback
  })

  it("sets bar width from value and clamps over-100", () => {
    render(
      <ProgressBlockComponent
        block={{ kind: "progress", id: "p", items: [{ label: "x", value: 150 }] }}
      />,
    )
    expect(screen.getByTestId("progress-bar").style.width).toBe("100%")
  })

  it("applies the tone color class to the bar", () => {
    render(
      <ProgressBlockComponent
        block={{ kind: "progress", id: "p", items: [{ label: "x", value: 50, tone: "danger" }] }}
      />,
    )
    expect(screen.getByTestId("progress-bar").className).toContain("bg-rose-500")
  })
})
