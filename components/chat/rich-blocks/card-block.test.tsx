import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { CardBlock } from "@/lib/blocks"
import { CardBlockComponent } from "./card-block"

function block(over: Partial<CardBlock> = {}): CardBlock {
  return { kind: "card", id: "c1", title: "Review 结论", ...over }
}

// F030 AC1 契约锁定：组件是 F001/F012 产物，本测试不驱动新实现，
// 只把 tone 着色 / fields 渲染锁进回归网（此前零测试覆盖）。
describe("CardBlockComponent (F030 AC1 contract)", () => {
  // 锚在语义 data-tone 属性上，而不是具体 tailwind 颜色类——视觉迭代不应撞测试。
  it.each(["info", "success", "warning", "danger"] as const)(
    "marks the card with data-tone=%s for visual differentiation",
    (tone) => {
      const { container } = render(<CardBlockComponent block={block({ tone })} />)
      expect(container.firstElementChild?.getAttribute("data-tone")).toBe(tone)
    },
  )

  it("falls back to info tone when tone is absent", () => {
    const { container } = render(<CardBlockComponent block={block()} />)
    expect(container.firstElementChild?.getAttribute("data-tone")).toBe("info")
  })

  // F030 r3 P3：只断言 data-tone 属性会让"四个 tone 共用一套颜色"也通过（着色形同虚设）。
  // 这里断言四个 tone 的容器样式互不相同——锁"视觉可区分"，但不绑死具体颜色类（仍允许视觉迭代）。
  it("maps the four tones to mutually distinct container styles + icons", () => {
    const tones = ["info", "success", "warning", "danger"] as const
    const containerClasses: string[] = []
    const iconClasses: string[] = []
    for (const tone of tones) {
      const { container } = render(<CardBlockComponent block={block({ tone })} />)
      const root = container.firstElementChild
      containerClasses.push(root?.getAttribute("class") ?? "")
      iconClasses.push(root?.querySelector("svg")?.getAttribute("class") ?? "")
    }
    expect(new Set(containerClasses).size).toBe(4)
    expect(new Set(iconClasses).size).toBe(4)
  })

  it("renders the title", () => {
    render(<CardBlockComponent block={block({ title: "0 P1 / 0 P2" })} />)
    expect(screen.getByText("0 P1 / 0 P2")).toBeInTheDocument()
  })

  it("renders bodyMarkdown content", () => {
    render(<CardBlockComponent block={block({ bodyMarkdown: "放行合入。" })} />)
    expect(screen.getByText("放行合入。")).toBeInTheDocument()
  })

  it("renders fields as label/value pairs", () => {
    render(
      <CardBlockComponent
        block={block({
          fields: [
            { label: "P1", value: "0" },
            { label: "P2", value: "2" },
          ],
        })}
      />,
    )
    expect(screen.getByText("P1")).toBeInTheDocument()
    expect(screen.getByText("P2")).toBeInTheDocument()
    expect(screen.getByText("0")).toBeInTheDocument()
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("renders no interactive elements (read-only)", () => {
    const { container } = render(
      <CardBlockComponent block={block({ bodyMarkdown: "正文", fields: [{ label: "k", value: "v" }] })} />,
    )
    expect(container.querySelectorAll("input, button")).toHaveLength(0)
  })
})
