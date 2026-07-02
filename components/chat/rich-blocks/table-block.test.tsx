import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TableBlockComponent } from "./table-block"
import type { TableBlock } from "@/lib/blocks"

const block: TableBlock = {
  kind: "table",
  id: "t1",
  title: "档位对比",
  columns: ["维度", "low", "high"],
  rows: [
    ["速度", "快", "慢"],
    ["质量", "中", "高"],
  ],
}

describe("TableBlockComponent", () => {
  it("renders title, headers and all cells", () => {
    render(<TableBlockComponent block={block} />)
    expect(screen.getByText("档位对比")).toBeTruthy()
    expect(screen.getAllByRole("columnheader")).toHaveLength(3)
    expect(screen.getByText("维度")).toBeTruthy()
    expect(screen.getByText("快")).toBeTruthy()
    expect(screen.getByText("高")).toBeTruthy()
    // 1 header row + 2 body rows
    expect(screen.getAllByRole("row")).toHaveLength(3)
  })

  it("renders without a title", () => {
    const { container } = render(
      <TableBlockComponent block={{ kind: "table", id: "t", columns: ["x"], rows: [["1"]] }} />,
    )
    expect(container.querySelector('[data-block="table"]')).toBeTruthy()
    expect(screen.getByText("x")).toBeTruthy()
  })
})
