import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { ChecklistBlock } from "@/lib/blocks"
import { ChecklistBlockComponent } from "./checklist-block"

function block(over: Partial<ChecklistBlock> = {}): ChecklistBlock {
  return {
    kind: "checklist",
    id: "cl1",
    title: "AC 进度",
    items: [
      { id: "i1", text: "AC1 tone 着色", checked: true },
      { id: "i2", text: "AC2 checklist" },
      { id: "i3", text: "AC6 dogfood", checked: false },
    ],
    ...over,
  }
}

describe("ChecklistBlockComponent (F030 AC2)", () => {
  it("renders the title and all item texts", () => {
    render(<ChecklistBlockComponent block={block()} />)
    expect(screen.getByText("AC 进度")).toBeInTheDocument()
    expect(screen.getByText("AC1 tone 着色")).toBeInTheDocument()
    expect(screen.getByText("AC2 checklist")).toBeInTheDocument()
    expect(screen.getByText("AC6 dogfood")).toBeInTheDocument()
  })

  it("shows a progress count of checked items", () => {
    render(<ChecklistBlockComponent block={block()} />)
    expect(screen.getByText("1/3")).toBeInTheDocument()
  })

  it("marks checked items with a data-checked attribute (read-only state display)", () => {
    render(<ChecklistBlockComponent block={block()} />)
    expect(screen.getByText("AC1 tone 着色").closest("li")).toHaveAttribute("data-checked", "true")
    expect(screen.getByText("AC2 checklist").closest("li")).toHaveAttribute("data-checked", "false")
  })

  it("renders no checkboxes or buttons (read-only, interaction belongs to F033)", () => {
    const { container } = render(<ChecklistBlockComponent block={block()} />)
    expect(container.querySelectorAll("input, button")).toHaveLength(0)
  })

  it("omits the title row when title is absent", () => {
    render(<ChecklistBlockComponent block={block({ title: undefined })} />)
    expect(screen.queryByText("AC 进度")).not.toBeInTheDocument()
    expect(screen.getByText("AC1 tone 着色")).toBeInTheDocument()
  })
})
