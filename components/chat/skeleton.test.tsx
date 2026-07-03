import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SkeletonLines } from "./skeleton"

// F039 AC5: >300ms 加载给形状贴布局的 skeleton，替换光杆"加载中…"文字。
describe("SkeletonLines", () => {
  it("renders the requested number of pulse lines", () => {
    const { container } = render(<SkeletonLines lines={4} />)
    expect(container.querySelectorAll("[data-skeleton-line]").length).toBe(4)
  })

  it("is announced as busy loading for assistive tech", () => {
    const { getByRole } = render(<SkeletonLines lines={2} />)
    const el = getByRole("status")
    expect(el.getAttribute("aria-busy")).toBe("true")
    expect(el.getAttribute("aria-label")).toBe("加载中")
  })

  it("varies line widths so the placeholder reads as content, not stripes", () => {
    const { container } = render(<SkeletonLines lines={3} />)
    const widths = Array.from(container.querySelectorAll("[data-skeleton-line]")).map(
      (n) => (n as HTMLElement).className,
    )
    expect(new Set(widths).size).toBeGreaterThan(1)
  })
})
